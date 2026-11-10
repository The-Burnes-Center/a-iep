/**
 * The family survey through its real screens, with only the network mocked.
 *
 * The fake server below keeps the survey the way user-profile-handler does,
 * including the rule that matters most: a baseline answer after the summary
 * was opened is refused (409 baseline_closed). So the cases assert what the
 * server ended up holding, where the parent was sent, and what must not
 * happen: a link to the summary while a question is open.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppContext } from "../../common/app-context";
import { LanguageContext } from "../../common/language-context";
import type { AppConfig, SurveyRecord } from "../../common/types";
import type { SupportedLanguage } from "../../common/languages";
import SurveyPage from "./SurveyPage";
import SurveyFollowUp from "./SurveyFollowUp";
import ChildCount from "./ChildCount";
import { SummarySurveyCards, SurveyWhileYouWait } from "./SurveyCards";
import UploadIEPDocument from "../iep-folder/UploadIEPDocument";
import { afterConsent } from "../../common/onboarding-next";

const Auth = vi.hoisted(() => ({ getCurrentUser: vi.fn(), fetchAuthSession: vi.fn() }));
vi.mock("aws-amplify/auth", () => Auth);
vi.mock("../../common/file-uploader", () => ({
  FileUploader: class { upload = vi.fn(async () => undefined); },
}));

const API = "https://api.example.test/api";
const MAYA = { childId: "c-maya", name: "Maya Lopez", schoolCity: "Lakeview" };
const LEO = { childId: "c-leo", name: "Leo Lopez", schoolCity: "Lakeview" };

interface FakeSurvey {
  before: SurveyRecord | null;
  after: SurveyRecord | null;
  household: SurveyRecord | null;
  summaryFirstViewedAt: number | null;
  iepChildCount: number | null;
}

let children: Array<typeof MAYA>;
let server: FakeSurvey;
let documentAnswer: unknown;
let surveyGetFails: boolean;
let saveFails: boolean;
let saves: Array<Record<string, unknown>>;
let profilePuts: Array<Record<string, unknown>>;
let fetchMock: ReturnType<typeof vi.fn>;

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const record = (status: string, part?: string, answers: Record<string, unknown> = {}): SurveyRecord =>
  ({ version: 1, status, part, answers: answers as SurveyRecord["answers"], startedAt: 1, updatedAt: 1 });

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname + location.search}</div>;
}

const renderAt = (path: string, element: React.ReactNode, { features = ["onboardingSurvey"], language = "en" } = {}) => {
  const appConfig = { httpEndpoint: `${API}/`, enabledFeatures: features, enabledLanguages: ["en", "es"] } as unknown as AppConfig;
  const pathname = path.split("?")[0];
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <AppContext.Provider value={appConfig}>
          <LanguageContext.Provider
            value={{
              language: language as SupportedLanguage,
              setLanguage: vi.fn(),
              t: (key: string) => key,
              translationsLoaded: true,
              enabledLanguages: ["en", "es"] as SupportedLanguage[],
            }}
          >
            <Routes>
              <Route path={pathname} element={element} />
              <Route path="*" element={null} />
            </Routes>
            <Where />
          </LanguageContext.Provider>
        </AppContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

/**
 * Runs timers and promises until the screen is quiet: no loading spinner and
 * no new request for a few rounds. A fixed number of ticks was not enough for
 * the chained profile -> survey -> document reads.
 */
const settle = async () => {
  let calls = -1;
  let quietRounds = 0;
  for (let round = 0; round < 60 && quietRounds < 3; round++) {
    await act(async () => {
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10);
    });
    const busy = document.querySelector(".aiep-page-loading") !== null;
    const now = fetchMock.mock.calls.length;
    quietRounds = !busy && now === calls ? quietRounds + 1 : 0;
    calls = now;
  }
};
const click = async (testId: string) => {
  fireEvent.click(screen.getByTestId(testId));
  await settle();
};
const title = () => screen.getByTestId("survey-title").textContent;
const where = () => screen.getByTestId("where").textContent;
const summaryLinks = () => document.querySelectorAll('a[href*="summary-and-translations"]').length;
/** The nth statement's answer on the agreement scale. */
const choose = (label: string, nth = 0) => fireEvent.click(screen.getAllByLabelText(label)[nth]);

beforeEach(() => {
  vi.useFakeTimers();
  Auth.getCurrentUser.mockResolvedValue({ username: "u", userId: "u" });
  Auth.fetchAuthSession.mockResolvedValue({ tokens: { idToken: { toString: () => "tok", payload: {} } } });
  children = [MAYA];
  server = { before: null, after: null, household: null, summaryFirstViewedAt: null, iepChildCount: null };
  documentAnswer = { documentId: "d-1", status: "PROCESSING" };
  surveyGetFails = false;
  saveFails = false;
  saves = [];
  profilePuts = [];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === `${API}/profile` && method === "GET") {
      return json(200, { profile: { userId: "u", consentGiven: true, showOnboarding: false, children, iepChildCount: server.iepChildCount } });
    }
    if (url === `${API}/profile` && method === "PUT") {
      profilePuts.push(JSON.parse(String(init!.body)));
      return json(200, { message: "ok" });
    }
    if (url.endsWith("/survey") && method === "GET") {
      if (surveyGetFails) return json(503, {});
      return json(200, { version: 1, ...server });
    }
    if (url.endsWith("/survey") && method === "PUT") {
      const body = JSON.parse(String(init!.body));
      if (saveFails) return json(503, {});
      if (body.phase === "before" && server.summaryFirstViewedAt) return json(409, { code: "baseline_closed" });
      saves.push(body);
      const saved = { ...record(body.status, body.part, body.answers ?? {}), researchConsent: body.researchConsent };
      (server as unknown as Record<string, unknown>)[body.phase] = saved;
      return json(200, { [body.phase]: saved });
    }
    if (url.endsWith("/survey/summary-viewed") && method === "POST") {
      server.summaryFirstViewedAt = server.summaryFirstViewedAt ?? 5;
      return json(200, { summaryFirstViewedAt: server.summaryFirstViewedAt });
    }
    if (/\/documents$/.test(url)) return json(200, documentAnswer);
    if (url === `${API}/signed-url-knowledge`) return json(200, { signedUrl: "https://s3.example.test/put" });
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the baseline survey", () => {
  test("walks every part, saving each, and the survey itself never offers the summary", async () => {
    renderAt("/survey", <SurveyPage />);
    await settle();
    expect(title()).toBe("survey.invite.titleWhileReading");

    fireEvent.click(screen.getByLabelText("survey.research.yes"));
    await click("survey-start");
    expect(saves[0]).toMatchObject({ phase: "before", status: "started", part: "about", researchConsent: true });

    for (const part of ["about", "understand", "speak", "reflect", "you"]) {
      expect(title()).toBe(`survey.part.${part}.title`);
      expect(summaryLinks()).toBe(0);
      if (part === "understand") choose("survey.scale.agree", 0);
      await click("survey-next");
    }

    expect(title()).toBe("survey.thanks.title");
    expect(server.before?.status).toBe("done");
    expect(server.before?.answers).toEqual({ u1: "agree" });
    expect(server.before?.researchConsent).toBe(true);
    expect(server.household?.status).toBe("done");
  });

  test("leaving and coming back lands on the saved part, with the answers given", async () => {
    // Survey state lives on the server, so an unmount (the bottom nav) loses nothing.
    const first = renderAt("/survey", <SurveyPage />);
    await settle();
    await click("survey-start");
    await click("survey-next"); // about -> understand
    choose("survey.scale.somewhat_agree", 1);
    await click("survey-next"); // understand -> speak, saving u2
    first.unmount();

    renderAt("/survey", <SurveyPage />);
    await settle();
    expect(title()).toBe("survey.part.speak.title");
    await click("survey-back");
    expect(title()).toBe("survey.part.understand.title");
    expect((screen.getAllByLabelText("survey.scale.somewhat_agree")[1] as HTMLInputElement).checked).toBe(true);
  });

  test("finishing with nothing answered is refused; one answer is enough", async () => {
    server.household = record("done", "you");
    server.before = record("started", "reflect");
    renderAt("/survey", <SurveyPage />);
    await settle();
    await click("survey-next");
    expect(screen.getByTestId("survey-nothing-answered")).toBeTruthy();
    expect(server.before?.status).toBe("started");
    choose("survey.scale.agree", 0);
    await click("survey-next");
    expect(server.before?.status).toBe("done");
  });

  test("a parent who already answered the household questions is not asked again", async () => {
    server.household = record("done", "you");
    server.before = record("started", "reflect", { u1: "agree" });
    renderAt("/survey", <SurveyPage />);
    await settle();
    expect(screen.getByText("survey.progress")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "survey.progress.label" })).toHaveAttribute("aria-valuemax", "4");
    await click("survey-next");
    expect(title()).toBe("survey.thanks.title");
    expect(saves.some((save) => save.phase === "household")).toBe(false);
  });

  test("a disagreement opens a box for why; agreeing again drops it from the save", async () => {
    server.before = record("started", "speak");
    renderAt("/survey", <SurveyPage />);
    await settle();
    expect(screen.queryByLabelText(/survey.q.speakWhy/)).toBeNull();
    choose("survey.scale.disagree", 0);
    fireEvent.change(screen.getByLabelText(/survey.q.speakWhy/), { target: { value: "rushed" } });
    choose("survey.scale.agree", 0);
    expect(screen.queryByLabelText(/survey.q.speakWhy/)).toBeNull();
    await click("survey-next");
    expect(saves.at(-1)?.answers).toEqual({ p1: "agree" });
  });

  test("the home-language question is asked only of a parent not using English", async () => {
    server.before = record("started", "about");
    const english = renderAt("/survey", <SurveyPage />);
    await settle();
    expect(screen.queryByText("survey.q.homeLanguageCopy")).toBeNull();
    english.unmount();

    renderAt("/survey", <SurveyPage />, { language: "es" });
    await settle();
    expect(screen.getByText("survey.q.homeLanguageCopy")).toBeTruthy();
  });

  test("Remind me later saves the reminder, keeps the answers, and goes to the child's IEP", async () => {
    server.before = record("started", "about", { k12: "yes" });
    renderAt("/survey", <SurveyPage />);
    await settle();
    await click("survey-back"); // to the invite
    await click("survey-remind");
    expect(server.before?.status).toBe("remind");
    expect(server.before?.answers).toEqual({ k12: "yes" });
    expect(where()).toBe("/summary-and-translations");
  });

  test("while the summary is ready there is no 'later', which would close the questions on arrival", async () => {
    server.before = record("started", "speak");
    documentAnswer = { documentId: "d-1", status: "PROCESSED" };
    const part = renderAt("/survey", <SurveyPage />);
    await settle();
    expect(screen.queryByTestId("survey-later")).toBeNull();
    part.unmount();

    server.before = null;
    renderAt("/survey", <SurveyPage />);
    await settle();
    expect(screen.queryByTestId("survey-remind")).toBeNull();
    await click("survey-decline");
    expect(where()).toBe("/summary-and-translations");
  });

  test("research use is a choice with neither answer picked, and unanswered is not consent", async () => {
    renderAt("/survey", <SurveyPage />);
    await settle();
    const yes = screen.getByLabelText("survey.research.yes") as HTMLInputElement;
    const no = screen.getByLabelText("survey.research.no") as HTMLInputElement;
    expect(yes.type).toBe("radio");
    expect(yes.checked || no.checked).toBe(false);
    await click("survey-start");
    expect(saves[0]).not.toHaveProperty("researchConsent");
    expect(server.before?.researchConsent).toBeUndefined();
  });

  test("a parent who says no is saved as no", async () => {
    renderAt("/survey", <SurveyPage />);
    await settle();
    fireEvent.click(screen.getByLabelText("survey.research.no"));
    await click("survey-start");
    expect(server.before?.researchConsent).toBe(false);
  });

  test("No thanks withdraws the research consent with the survey", async () => {
    server.before = { ...record("remind"), researchConsent: true };
    renderAt("/survey", <SurveyPage />);
    await settle();
    await click("survey-decline");
    expect(server.before).toMatchObject({ status: "declined", researchConsent: false });
  });

  test("a save that fails keeps the parent and their answers on the same part", async () => {
    server.before = record("started", "understand");
    renderAt("/survey", <SurveyPage />);
    await settle();
    choose("survey.scale.agree", 0);
    saveFails = true;
    await click("survey-next");
    expect(screen.getByRole("alert")).toHaveTextContent("survey.error.save");
    expect(title()).toBe("survey.part.understand.title");
    expect((screen.getAllByLabelText("survey.scale.agree")[0] as HTMLInputElement).checked).toBe(true);
  });

  test("once the summary has been opened, the baseline is closed and says so", async () => {
    server.before = record("started", "speak");
    renderAt("/survey", <SurveyPage />);
    await settle();
    server.summaryFirstViewedAt = 9; // opened on another device, mid-survey
    await click("survey-next");
    expect(screen.getByText("survey.closed.body")).toBeTruthy();
    expect(server.before?.status).toBe("started");
  });

  test("the household email has to look like one before the parent moves on", async () => {
    server.before = record("started", "you", { u1: "agree" });
    renderAt("/survey", <SurveyPage />);
    await settle();
    fireEvent.click(screen.getAllByLabelText("survey.answer.yes")[0]);
    fireEvent.change(screen.getByLabelText(/survey.q.email/), { target: { value: "5551234567" } });
    await click("survey-next");
    expect(screen.getByRole("alert")).toHaveTextContent("survey.error.email");
    expect(server.household).toBeNull();
  });

  test("with the feature off, the route goes to the summary", async () => {
    renderAt("/survey", <SurveyPage />, { features: [] });
    await settle();
    expect(where()).toBe("/summary-and-translations");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/survey"))).toBe(false);
  });
});

describe("after an upload", () => {
  const upload = async (features = ["onboardingSurvey"]) => {
    renderAt("/iep-documents", <UploadIEPDocument onUploadComplete={vi.fn()} hasExistingDocument={false} />, { features });
    await settle();
    fireEvent.change(document.getElementById("fileUpload")!, {
      target: { files: [new File(["hello"], "iep.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })] },
    });
    await settle();
    await click("upload-submit-button");
  };

  test("an open baseline sends the parent to the survey's invite", async () => {
    await upload();
    expect(where()).toBe("/survey");
  });

  test("a closed baseline, or a survey that cannot be read, goes straight to the summary", async () => {
    server.summaryFirstViewedAt = 3;
    await upload();
    expect(where()).toBe("/summary-and-translations");
  });

  test("a survey that cannot be read never holds the parent at the upload", async () => {
    surveyGetFails = true;
    await upload();
    expect(where()).toBe("/summary-and-translations");
  });

  test("with the feature off, nothing about the survey is asked", async () => {
    await upload([]);
    expect(where()).toBe("/summary-and-translations");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/survey"))).toBe(false);
  });
});

describe("the IEP's progress above the questions", () => {
  test("while it is read, shows the processing screen's step and bar, not a link", async () => {
    documentAnswer = { documentId: "d-1", status: "PROCESSING", progress: 40, current_step: "summarizing", updatedAt: 1 };
    server.before = record("started", "understand");
    renderAt("/survey", <SurveyPage />);
    await settle();
    expect(screen.getByTestId("survey-banner")).toBeTruthy();
    expect(screen.getByTestId("processing-progress-bar")).toBeTruthy();
    expect(summaryLinks()).toBe(0);
  });
});

describe("on the summary", () => {
  test("opening a readable summary closes the baseline and offers the follow-up", async () => {
    server.before = record("started", "speak");
    renderAt("/summary-and-translations", <SummarySurveyCards />);
    await settle();
    expect(server.summaryFirstViewedAt).toBe(5);
    expect(screen.getByTestId("survey-follow-up-card")).toBeTruthy();
  });

  test("offers the next child while the family has fewer on the profile than they said", async () => {
    server.iepChildCount = 3;
    children = [MAYA, LEO];
    renderAt("/summary-and-translations", <SummarySurveyCards />, { features: ["onboardingSurvey", "multiChild"] });
    await settle();
    expect(screen.getByTestId("survey-next-child-card")).toBeTruthy();
    expect(screen.queryByTestId("survey-follow-up-card")).toBeNull();
  });

  test("with the feature off, the summary records nothing and shows nothing", async () => {
    renderAt("/summary-and-translations", <SummarySurveyCards />, { features: [] });
    await settle();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/survey"))).toBe(false);
    expect(screen.queryByTestId("survey-follow-up-card")).toBeNull();
  });

  test("the processing screen offers the questions while the baseline is open, and stops after", async () => {
    const open = renderAt("/summary-and-translations", <SurveyWhileYouWait />);
    await settle();
    expect(screen.getByTestId("survey-wait-card")).toBeTruthy();
    open.unmount();

    server.before = record("declined");
    renderAt("/summary-and-translations", <SurveyWhileYouWait />);
    await settle();
    expect(screen.queryByTestId("survey-wait-card")).toBeNull();
  });

  test("the follow-up sends its four answers and returns to the summary", async () => {
    server.before = record("done");
    server.summaryFirstViewedAt = 5;
    renderAt("/survey/follow-up", <SurveyFollowUp />);
    await settle();
    await click("follow-up-send");
    expect(screen.getByTestId("survey-nothing-answered")).toBeTruthy();
    expect(server.after).toBeNull();
    choose("survey.scale.agree", 0);
    await click("follow-up-send");
    expect(server.after).toMatchObject({ status: "done", answers: { u3: "agree" } });
    expect(where()).toBe("/summary-and-translations");
  });
});

describe("how many children have an IEP", () => {
  test("asks for a choice, saves it, and carries on to how the tool works", async () => {
    renderAt("/your-children", <ChildCount />, { features: ["onboardingSurvey", "studentNameGate"] });
    await settle();
    await click("child-count-continue");
    expect(screen.getByTestId("child-count-missing")).toBeTruthy();
    expect(profilePuts).toEqual([]);

    fireEvent.click(screen.getByLabelText("childCount.option.2"));
    await click("child-count-continue");
    expect(profilePuts).toEqual([{ iepChildCount: 2 }]);
    expect(where()).toBe("/how-to-use-the-tool");
  });

  test("comes once, straight after consent, and only with the feature on", () => {
    const on = () => true;
    const surveyOff = (feature: string) => feature !== "onboardingSurvey";
    const named = { children: [MAYA] } as never;
    expect(afterConsent(named, on).path).toBe("/your-children");
    expect(afterConsent({ ...(named as object), iepChildCount: 2 } as never, on).path).toBe("/how-to-use-the-tool");
    expect(afterConsent(named, surveyOff).path).toBe("/how-to-use-the-tool");
  });
});
