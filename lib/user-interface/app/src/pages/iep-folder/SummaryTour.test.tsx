/**
 * When the summary page's guided tour shows, and what it writes.
 *
 * The page it points at is a handful of plain elements carrying the same
 * classes and test ids the real summary renders (see IEPSummarizationAndTranslation),
 * so the target lookup is the real one. Only the network boundary is mocked
 * (`fetch`, plus Amplify's `Auth` for the bearer token); the real profile
 * client, the shared ['profile'] cache and GuidedTour all run.
 *
 * Wording is the English dictionary, so the steps are asserted by the
 * strings a parent reads and not by their keys.
 */
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SummaryTour from "./SummaryTour";
import en from "../../translations/en.json";
import { AppContext } from "../../common/app-context";
import { LanguageContext } from "../../common/language-context";
import type { AppConfig } from "../../common/types";
import type { SupportedLanguage } from "../../common/languages";

const Auth = vi.hoisted(() => ({ getCurrentUser: vi.fn(), fetchAuthSession: vi.fn() }));
vi.mock("aws-amplify/auth", () => Auth);

const API_BASE = "https://api.example.test/api";
const PROFILE_URL = `${API_BASE}/profile`;

const appConfig = { httpEndpoint: `${API_BASE}/` } as unknown as AppConfig;
const words = en as Record<string, string>;
const t = (key: string) => words[key] ?? key;

const STEP_TITLES = {
  summary: words["rights.slide7.title"],
  insights: words["rights.slide8.title"],
  glossary: words["rights.slide9.title"],
  pages: words["rights.slide10.title"],
};

/** What GET /profile answers; null makes it fail. */
let profile: Record<string, unknown> | null;
/** Whether the save of the flag is refused. */
let putFails: boolean;
let fetchMock: ReturnType<typeof vi.fn>;
let queryClient: QueryClient;

const puts = () =>
  fetchMock.mock.calls
    .filter(([url, init]) => url === PROFILE_URL && (init as RequestInit | undefined)?.method === "PUT")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

beforeEach(() => {
  Auth.getCurrentUser.mockResolvedValue({ username: "u", userId: "u" });
  Auth.fetchAuthSession.mockResolvedValue({
    tokens: { idToken: { toString: () => "id-token", payload: {} } },
  });
  profile = { userId: "user-1", secondaryLanguage: "en", showOnboarding: false };
  putFails = false;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === PROFILE_URL && init?.method === "PUT") {
      return putFails
        ? { ok: false, status: 500, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({}) };
    }
    if (url === PROFILE_URL) {
      return profile
        ? { ok: true, status: 200, json: async () => ({ profile }) }
        : { ok: false, status: 503, json: async () => ({}) };
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  // The tour's failed-save log is the behaviour under test, not noise.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

interface PageProps {
  withGlossary?: boolean;
  withPages?: boolean;
}

/** The pieces of the summary the tour looks for, with the page's own markers. */
const SummaryPage: React.FC<PageProps> = ({ withGlossary = true, withPages = true }) => (
  <div id="main-content">
    <div data-testid="summary-tab-panel-en">
      <h4 className="summary-header">IEP Summary</h4>
      <div className="summary-content card">
        <div data-testid="summary-text-en">
          The team agreed on{" "}
          {withGlossary ? <span className="jargon-term" data-term="Accommodations">accommodations</span> : "supports"}.
        </div>
      </div>
      <h4 className="key-insights-header">Key Insights</h4>
      <div className="summary-accordion accordion">
        <div className="accordion-item">
          <h2 className="accordion-header">
            <button
              type="button"
              className="accordion-button collapsed"
              onClick={(event) => {
                const item = (event.currentTarget as HTMLElement).closest(".accordion-item");
                item?.querySelector(".accordion-collapse")?.classList.toggle("show");
              }}
            >
              Goals
            </button>
          </h2>
          <div className="accordion-collapse collapse">
            {withPages && <p className="page-numbers-text">Found in pages 3</p>}
          </div>
        </div>
      </div>
    </div>
  </div>
);

interface HarnessProps extends PageProps {
  ready?: boolean;
  blocked?: boolean;
  activeTab?: string;
  replayRequested?: boolean;
  onReplayConsumed?: () => void;
}

const Harness: React.FC<HarnessProps> = ({
  ready = true,
  blocked = false,
  activeTab = "en",
  replayRequested = false,
  onReplayConsumed = () => {},
  ...page
}) => (
  <>
    <button type="button">Before the tour</button>
    <SummaryPage {...page} />
    <SummaryTour
      ready={ready}
      blocked={blocked}
      activeTab={activeTab}
      replayRequested={replayRequested}
      onReplayConsumed={onReplayConsumed}
    />
  </>
);

const withProviders = (ui: React.ReactElement) => (
  <QueryClientProvider client={queryClient}>
    <AppContext.Provider value={appConfig}>
      <LanguageContext.Provider
        value={{
          language: "en",
          setLanguage: vi.fn(),
          t,
          translationsLoaded: true,
          enabledLanguages: ["en"] as SupportedLanguage[],
        }}
      >
        {ui}
      </LanguageContext.Provider>
    </AppContext.Provider>
  </QueryClientProvider>
);

const renderTour = (props: HarnessProps = {}) => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(withProviders(<Harness {...props} />));
  return {
    ...view,
    update: (next: HarnessProps) => view.rerender(withProviders(<Harness {...next} />)),
  };
};

/** Let the profile read land and the effects that follow it run. */
const profileLoaded = () => act(async () => { await Promise.resolve(); });

const queryDialog = () => screen.queryByRole("dialog");
const clickNext = () => userEvent.click(screen.getByRole("button", { name: words["common.next"] }));

describe("when the tour appears", () => {
  test("shows on a first visit, on the summary step", async () => {
    renderTour();

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName(STEP_TITLES.summary);
    expect(dialog).toHaveAccessibleDescription(words["rights.slide7.content"]);
    expect(screen.getByText(words["carousel.section.whatYouWillSeeNext"])).toBeInTheDocument();
  });

  test("does not show once the profile says it was seen", async () => {
    profile = { ...profile, summaryTourSeen: true };
    renderTour();
    await profileLoaded();

    expect(queryDialog()).not.toBeInTheDocument();
  });

  test("does not show when the profile could not be read", async () => {
    // Not knowing is not the same as not having seen it.
    profile = null;
    renderTour();
    await profileLoaded();

    expect(queryDialog()).not.toBeInTheDocument();
  });

  test("waits while the summary is not ready, and shows when it is", async () => {
    const { update } = renderTour({ ready: false });
    await profileLoaded();
    expect(queryDialog()).not.toBeInTheDocument();

    update({ ready: true });

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  test("waits while the glossary drawer is open", async () => {
    const { update } = renderTour({ blocked: true });
    await profileLoaded();
    expect(queryDialog()).not.toBeInTheDocument();

    update({ blocked: false });

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  test("is not pushed again after it was dismissed, even if the page stays ready", async () => {
    const { update } = renderTour();
    await screen.findByRole("dialog");
    await userEvent.click(screen.getByRole("button", { name: words["common.skip"] }));

    update({ ready: true, activeTab: "en" });
    await profileLoaded();

    expect(queryDialog()).not.toBeInTheDocument();
  });

  test("ends without an answer when the summary stops being ready mid-tour", async () => {
    const { update } = renderTour();
    await screen.findByRole("dialog");

    update({ ready: false });

    await waitFor(() => expect(queryDialog()).not.toBeInTheDocument());
    expect(puts()).toEqual([]);
  });
});

describe("the steps", () => {
  const titlesWalked = async () => {
    const titles: string[] = [];
    for (;;) {
      titles.push(screen.getByRole("dialog").getAttribute("aria-labelledby") as string);
      titles[titles.length - 1] = document.getElementById(titles[titles.length - 1])?.textContent ?? "";
      const next = screen.queryByRole("button", { name: words["common.next"] });
      if (!next) return titles;
      await userEvent.click(next);
    }
  };

  test("are the summary, the insights, a glossary term and the page numbers, in that order", async () => {
    renderTour();
    await screen.findByRole("dialog");

    expect(await titlesWalked()).toEqual([
      STEP_TITLES.summary,
      STEP_TITLES.insights,
      STEP_TITLES.glossary,
      STEP_TITLES.pages,
    ]);
  });

  test("leave out the glossary step when the summary has no highlighted term", async () => {
    renderTour({ withGlossary: false });
    await screen.findByRole("dialog");

    expect(await titlesWalked()).toEqual([STEP_TITLES.summary, STEP_TITLES.insights, STEP_TITLES.pages]);
    expect(screen.getByTestId("guided-tour-step")).toHaveTextContent("Step 3 of 3");
  });

  test("leave out the page numbers step when no insight has any", async () => {
    renderTour({ withPages: false });
    await screen.findByRole("dialog");

    expect(await titlesWalked()).toEqual([STEP_TITLES.summary, STEP_TITLES.insights, STEP_TITLES.glossary]);
  });

  test("open the insight the page numbers are in, so there is something to point at", async () => {
    renderTour();
    await screen.findByRole("dialog");
    const collapse = document.querySelector(".accordion-collapse") as HTMLElement;
    expect(collapse).not.toHaveClass("show");

    await clickNext();
    await clickNext();
    expect(collapse).not.toHaveClass("show");
    await clickNext();

    expect(collapse).toHaveClass("show");
  });

  test("look for their targets in the pane of the active language", async () => {
    const { update } = renderTour();
    await screen.findByRole("dialog");

    // The page has no "es" pane, so once the tab changes no step has a target
    // and the tour ends without an answer (nothing is saved).
    update({ activeTab: "es" });

    await waitFor(() => expect(queryDialog()).not.toBeInTheDocument());
    expect(puts()).toEqual([]);
  });
});

describe("what is remembered", () => {
  test.each([
    ["Skip", async () => userEvent.click(screen.getByRole("button", { name: words["common.skip"] }))],
    ["Escape", async () => userEvent.keyboard("{Escape}")],
    [
      "Done",
      async () => {
        for (let step = 0; step < 3; step++) await clickNext();
        await userEvent.click(screen.getByRole("button", { name: words["common.done"] }));
      },
    ],
  ])("%s closes the tour and saves it as seen, once", async (_name, dismiss) => {
    renderTour();
    await screen.findByRole("dialog");

    await dismiss();

    await waitFor(() => expect(queryDialog()).not.toBeInTheDocument());
    expect(puts()).toEqual([{ summaryTourSeen: true }]);
  });

  test("returns focus to what had it, or to the summary heading", async () => {
    const before = document.createElement("button");
    document.body.appendChild(before);
    before.focus();
    renderTour();
    await screen.findByRole("dialog");

    await userEvent.keyboard("{Escape}");

    expect(before).toHaveFocus();
    before.remove();
  });

  test("returns focus to the summary heading when nothing had it", async () => {
    renderTour();
    await screen.findByRole("dialog");

    await userEvent.keyboard("{Escape}");

    expect(document.querySelector(".summary-header")).toHaveFocus();
  });

  test("leaving the page mid-tour does not count, and it is offered again next visit", async () => {
    const first = renderTour();
    await screen.findByRole("dialog");
    await clickNext();

    first.unmount();

    expect(puts()).toEqual([]);
    // The next visit, with the same cache: the profile still says unseen.
    render(withProviders(<Harness />));
    expect(await screen.findByRole("dialog")).toHaveAccessibleName(STEP_TITLES.summary);
  });

  test("updates the shared profile at once, so the page never re-opens it", async () => {
    renderTour();
    await screen.findByRole("dialog");

    await userEvent.keyboard("{Escape}");

    expect(queryClient.getQueryData<{ summaryTourSeen?: boolean }>(["profile"])?.summaryTourSeen).toBe(true);
  });

  test("never re-opens in the session when the save fails, and logs only the error class", async () => {
    putFails = true;
    const first = renderTour();
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(console.error).toHaveBeenCalled());

    // A refetch brings the server's old answer back; the session still knows.
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["profile"] });
    });
    first.unmount();
    render(withProviders(<Harness />));
    await profileLoaded();

    expect(queryDialog()).not.toBeInTheDocument();
    expect(puts()).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith("Could not save the summary tour flag:", "Error");
  });
});

describe("replaying it from the Support page", () => {
  test("shows even though it was seen, and writes nothing when closed", async () => {
    profile = { ...profile, summaryTourSeen: true };
    const onReplayConsumed = vi.fn();
    renderTour({ replayRequested: true, onReplayConsumed });

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(onReplayConsumed).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: words["common.skip"] }));

    await waitFor(() => expect(queryDialog()).not.toBeInTheDocument());
    expect(puts()).toEqual([]);
  });

  test("still waits for a ready summary", async () => {
    profile = { ...profile, summaryTourSeen: true };
    const onReplayConsumed = vi.fn();
    const { update } = renderTour({ replayRequested: true, ready: false, onReplayConsumed });
    await profileLoaded();
    expect(queryDialog()).not.toBeInTheDocument();
    expect(onReplayConsumed).not.toHaveBeenCalled();

    update({ replayRequested: true, ready: true, onReplayConsumed });

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});

describe("focus inside the tour", () => {
  test("takes focus, and Tab does not leave it", async () => {
    renderTour();
    await screen.findByRole("dialog");
    expect(screen.getByRole("dialog")).toHaveFocus();

    // Only Next and Skip on the first step: three Tabs come back around.
    await userEvent.tab();
    const first = document.activeElement;
    await userEvent.tab();
    await userEvent.tab();

    expect(document.activeElement).toBe(first);
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
  });

  test("a click on the page behind lands on the shield, which does nothing", async () => {
    renderTour();
    await screen.findByRole("dialog");

    await userEvent.click(document.querySelector(".guided-tour-shield") as HTMLElement);

    expect(screen.getByRole("dialog")).toHaveAccessibleName(STEP_TITLES.summary);
    expect(puts()).toEqual([]);
  });
});
