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
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppContext } from "../../common/app-context";
import { LanguageContext } from "../../common/language-context";
import type { AppConfig, SurveyRecord } from "../../common/types";
import type { SupportedLanguage } from "../../common/languages";
import SurveyPage from "./SurveyPage";
import { AUTOSAVE_MS } from "./use-survey-autosave";
import { SAVES_WAIT_MAX_MS } from "./survey-saves";
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
let saveDelayMs: number;
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
  saveDelayMs = 0;
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
      if (saveDelayMs) await new Promise((resolve) => setTimeout(resolve, saveDelayMs));
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

afterEach(async () => {
  // Unmount here, then let the saves made on leaving land in this test's
  // server: left for the automatic cleanup, they reached the next test's.
  cleanup();
  await act(async () => { await vi.advanceTimersByTimeAsync(SAVES_WAIT_MAX_MS); });
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

  test("answers given on a part survive leaving it by the app's own navigation, without Next", async () => {
    server.before = record("started", "understand");
    const first = renderAt("/survey", <SurveyPage />);
    await settle();
    choose("survey.scale.somewhat_agree", 1);
    first.unmount(); // the bottom nav, or the child switcher
    await settle();
    expect(server.before?.status).toBe("started");
    expect(server.before?.part).toBe("understand");

    renderAt("/survey", <SurveyPage />);
    await settle();
    expect(title()).toBe("survey.part.understand.title");
    expect((screen.getAllByLabelText("survey.scale.somewhat_agree")[1] as HTMLInputElement).checked).toBe(true);
  });

  test("coming straight back waits for the save made on leaving, so it shows the answers just given", async () => {
    server.before = record("started", "understand");
    saveDelayMs = 400;
    const first = renderAt("/survey", <SurveyPage />);
    await settle();
    choose("survey.scale.somewhat_agree", 1);
    first.unmount();
    renderAt("/survey", <SurveyPage />); // before the save has landed
    await settle();
    expect((screen.getAllByLabelText("survey.scale.somewhat_agree")[1] as HTMLInputElement).checked).toBe(true);
  });

  test("a save that never answers holds the survey back for a few seconds, not for good", async () => {
    server.before = record("started", "understand");
    saveDelayMs = 10 * 60 * 1000;
    const first = renderAt("/survey", <SurveyPage />);
    await settle();
    choose("survey.scale.somewhat_agree", 1);
    first.unmount();
    renderAt("/survey", <SurveyPage />);
    await settle();
    expect(screen.queryByTestId("survey-title")).toBeNull(); // still waiting on the save
    await act(async () => { await vi.advanceTimersByTimeAsync(SAVES_WAIT_MAX_MS); });
    await settle();
    expect(title()).toBe("survey.part.understand.title");
    // Let the stuck save land, or the next test's reads wait behind it.
    await act(async () => { await vi.advanceTimersByTimeAsync(saveDelayMs); });
  });

  test("an answer is saved a moment after it is given, while the parent stays", async () => {
    server.before = record("started", "understand");
    renderAt("/survey", <SurveyPage />);
    await settle();
    choose("survey.scale.somewhat_agree", 1);
    expect(saves).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_MS); });
    await settle();
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ phase: "before", status: "started", part: "understand" });
    expect(Object.values(saves[0].answers as Record<string, unknown>)).toContain("somewhat_agree");
  });

  test("Next with an answer still waiting sends one save, and leaving after it sends none", async () => {
    server.before = record("started", "understand");
    const view = renderAt("/survey", <SurveyPage />);
    await settle();
    choose("survey.scale.somewhat_agree", 1);
    await click("survey-next");
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2); });
    expect(saves).toHaveLength(1);
    expect(server.before?.part).toBe("speak");
  });

  test("saying No thanks is not undone by the save made on leaving", async () => {
    server.before = record("started", "understand");
    const view = renderAt("/survey", <SurveyPage />);
    await settle();
    choose("survey.scale.somewhat_agree", 1);
    await click("survey-back"); // understand -> about, saving
    await click("survey-back"); // about -> invite
    await click("survey-decline");
    view.unmount();
    await settle();
    expect(server.before?.status).toBe("declined");
  });

  test("each statement is one row of faces, frown to smile, with Not sure at its end", async () => {
    server.household = record("done", "you");
    server.before = record("started", "understand");
    renderAt("/survey", <SurveyPage />);
    await settle();
    expect(title()).toBe("survey.part.understand.title");
    const groups = screen.getAllByRole("group").filter((group) => group.querySelector(".ui-radios-scale"));
    expect(groups).toHaveLength(6);
    for (const group of groups) {
      expect(group.querySelectorAll(".ui-radios-options")).toHaveLength(1);
      const faces = [...group.querySelectorAll("label svg")].map((svg) => svg.getAttribute("data-expression"));
      expect(faces).toEqual(["disagree", "somewhat_disagree", "somewhat_agree", "agree", "unsure"]);
    }
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

describe("before the upload", () => {
  const upload = async () => {
    renderAt("/iep-documents", <UploadIEPDocument onUploadComplete={vi.fn()} hasExistingDocument={false} />);
    await settle();
    fireEvent.change(document.getElementById("fileUpload")!, {
      target: { files: [new File(["hello"], "iep.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })] },
    });
    await settle();
    await click("upload-submit-button");
  };

  test("an upload goes straight to the summary's processing screen; the survey came first", async () => {
    await upload();
    expect(where()).toBe("/summary-and-translations");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/survey"))).toBe(false);
  });

  test("with no IEP yet, the invite says the upload comes next, and every way out leads to it", async () => {
    documentAnswer = { message: "No document found for this child" };
    const invite = renderAt("/survey", <SurveyPage />);
    await settle();
    expect(screen.getByText("survey.invite.uploadNext")).toBeTruthy();
    await click("survey-decline");
    expect(where()).toBe("/iep-documents");
    invite.unmount();

    server.household = record("done", "you");
    server.before = record("started", "reflect", { u1: "agree" });
    renderAt("/survey", <SurveyPage />);
    await settle();
    await click("survey-next");
    expect(title()).toBe("survey.thanks.title");
    expect(screen.getByTestId("survey-upload")).toHaveAttribute("href", "/iep-documents");
  });
});

/**
 * The survey, the upload and the processing screen in one app with one query
 * cache, carrying the app's real five-minute default (components/
 * app-configured.tsx). Each screen rendered alone gets a fresh cache, which is
 * how a stale "no IEP yet" read survived the upload unseen.
 */
/** The browser's Back button. */
function HistoryBack() {
  const navigate = useNavigate();
  return <button type="button" data-testid="history-back" onClick={() => navigate(-1)}>back</button>;
}

const renderJourney = (path: string, before: string[] = []) => {
  const appConfig = { httpEndpoint: `${API}/`, enabledFeatures: ["onboardingSurvey"], enabledLanguages: ["en"] } as unknown as AppConfig;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[...before, path]} initialIndex={before.length}>
        <AppContext.Provider value={appConfig}>
          <LanguageContext.Provider
            value={{
              language: "en" as SupportedLanguage,
              setLanguage: vi.fn(),
              t: (key: string) => key,
              translationsLoaded: true,
              enabledLanguages: ["en"] as SupportedLanguage[],
            }}
          >
            <Routes>
              <Route path="/survey" element={<SurveyPage />} />
              <Route path="/iep-documents" element={<UploadIEPDocument onUploadComplete={vi.fn()} hasExistingDocument={false} />} />
              <Route path="/summary-and-translations" element={<SurveyWhileYouWait />} />
              <Route path="*" element={null} />
            </Routes>
            <Where />
            <HistoryBack />
          </LanguageContext.Provider>
        </AppContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

describe("finishing later, uploading, and coming back", () => {
  const leaveBeforeUploadThenUpload = async () => {
    documentAnswer = { message: "No document found for this child" };
    server.household = record("done", "you");
    renderJourney("/survey");
    await settle();
    await click("survey-start");
    await click("survey-next"); // about -> understand
    await click("survey-later");
    expect(where()).toBe("/iep-documents");

    fireEvent.change(document.getElementById("fileUpload")!, {
      target: { files: [new File(["hello"], "iep.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })] },
    });
    await settle();
    documentAnswer = { documentId: "d-1", status: "PROCESSING" };
    await click("upload-submit-button");
    expect(where()).toBe("/summary-and-translations");
    await click("survey-wait-open");
    expect(where()).toBe("/survey");
    expect(title()).toBe("survey.part.understand.title");
  };

  test("Back to the invite does not say the upload is still to come, and its ways out skip the upload", async () => {
    await leaveBeforeUploadThenUpload();
    await click("survey-back");
    expect(title()).toBe("survey.part.about.title");
    await click("survey-back");
    expect(title()).toBe("survey.invite.titleWhileReading");
    expect(screen.queryByText("survey.invite.uploadNext")).toBeNull();
    await click("survey-remind");
    expect(where()).toBe("/summary-and-translations");
  });

  test("finishing later again goes to the IEP being read, not back to the upload", async () => {
    await leaveBeforeUploadThenUpload();
    await click("survey-later");
    expect(where()).toBe("/summary-and-translations");
  });

  test("the thank-you leads to the IEP being read, not to another upload", async () => {
    await leaveBeforeUploadThenUpload();
    choose("survey.scale.agree", 0);
    for (let part = 0; part < 3; part++) await click("survey-next"); // understand, speak, reflect
    expect(title()).toBe("survey.thanks.title");
    expect(screen.queryByTestId("survey-upload")).toBeNull();
    expect(screen.getByTestId("survey-see-summary")).toHaveAttribute("href", "/summary-and-translations");
  });
});

describe("meeting the survey again on the way to the upload", () => {
  test("Back from the processing screen skips the upload form it came from", async () => {
    documentAnswer = { message: "No document found for this child" };
    renderJourney("/iep-documents", ["/how-to-use-the-tool"]);
    await settle();
    fireEvent.change(document.getElementById("fileUpload")!, {
      target: { files: [new File(["hello"], "iep.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })] },
    });
    await settle();
    documentAnswer = { documentId: "d-1", status: "PROCESSING" };
    await click("upload-submit-button");
    expect(where()).toBe("/summary-and-translations");
    await click("history-back");
    expect(where()).toBe("/how-to-use-the-tool");
  });

  test("a parent who said no is sent on to the upload, not told they opened a summary", async () => {
    documentAnswer = { message: "No document found for this child" };
    server.before = record("declined");
    renderJourney("/survey");
    await settle();
    expect(where()).toBe("/iep-documents");
    expect(screen.queryByText("survey.closed.body")).toBeNull();
    expect(saves).toHaveLength(0);
  });

  test("a parent who said no and has an IEP is sent to it", async () => {
    server.before = record("declined");
    renderJourney("/survey");
    await settle();
    expect(where()).toBe("/summary-and-translations");
  });

  test("a parent who finished before uploading goes straight on to the upload", async () => {
    documentAnswer = { message: "No document found for this child" };
    server.before = record("done");
    renderJourney("/survey");
    await settle();
    expect(where()).toBe("/iep-documents");
  });

  test("finishing still shows the thank-you, not a jump to the upload", async () => {
    documentAnswer = { message: "No document found for this child" };
    server.household = record("done", "you");
    server.before = record("started", "reflect", { u1: "agree" });
    renderJourney("/survey");
    await settle();
    await click("survey-next");
    expect(where()).toBe("/survey");
    expect(title()).toBe("survey.thanks.title");
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

  test("always offers a sibling, whatever the family said about how many have an IEP", async () => {
    for (const iepChildCount of [null, 1, 3]) {
      server.iepChildCount = iepChildCount;
      const view = renderAt("/summary-and-translations", <SummarySurveyCards />, { features: ["onboardingSurvey", "multiChild"] });
      await settle();
      expect(screen.getByTestId("summary-sibling-card")).toBeTruthy();
      expect(screen.getByTestId("summary-sibling-add")).toHaveAttribute("href", "/account-center/children/add");
      expect(screen.getByText("sibling.button")).toBeTruthy();
      view.unmount();
    }
  });

  test("offers a sibling without the survey, and records nothing", async () => {
    renderAt("/summary-and-translations", <SummarySurveyCards />, { features: ["multiChild"] });
    await settle();
    expect(screen.getByTestId("summary-sibling-card")).toBeTruthy();
    expect(screen.queryByTestId("survey-follow-up-card")).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/survey"))).toBe(false);
  });

  test("offers no sibling once the account holds the most children it can", async () => {
    children = Array.from({ length: 10 }, (_, i) => ({ ...MAYA, childId: `c-${i}`, name: `Child ${i}` }));
    renderAt("/summary-and-translations", <SummarySurveyCards />, { features: ["multiChild"] });
    await settle();
    expect(screen.queryByTestId("summary-sibling-card")).toBeNull();
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
