/**
 * The guided tour on the real summary page: when a parent is offered it, and
 * when they are not.
 *
 * What the tour does once it is open, and what it writes, is pinned in
 * SummaryTour.test.tsx. This file is about the page's side of it: that it is
 * offered on a finished summary and kept away from every other state the page
 * can be in, and that the Support page's replay request reaches it.
 *
 * Only the network boundary is mocked (`fetch`, plus Amplify's `Auth`); the
 * real page, document poller and tour all run. Wording is the English
 * dictionary so the steps are named by what a parent reads.
 */
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import IEPSummarizationAndTranslation from "./IEPSummarizationAndTranslation";
import { REPLAY_TOUR_STATE_KEY } from "./summary-tour";
import en from "../../translations/en.json";
import { AppContext } from "../../common/app-context";
import { LanguageContext } from "../../common/language-context";
import type { AppConfig } from "../../common/types";
import type { SupportedLanguage } from "../../common/languages";

const Auth = vi.hoisted(() => ({ getCurrentUser: vi.fn(), fetchAuthSession: vi.fn() }));
vi.mock("aws-amplify/auth", () => Auth);

const API_BASE = "https://api.example.test/api";
const CHILD_ID = "child-abc";
const PROFILE_URL = `${API_BASE}/profile`;
const DOCUMENTS_URL = `${API_BASE}/profile/children/${CHILD_ID}/documents`;
const SUMMARY_PATH = "/summary-and-translations";

const appConfig = {
  httpEndpoint: `${API_BASE}/`,
  enabledFeatures: [],
  enabledLanguages: ["en"],
} as unknown as AppConfig;

const words = en as Record<string, string>;
const t = (key: string) => words[key] ?? key;
const FIRST_STEP = words["rights.slide7.title"];

const section = { title: "Goals", content: "Goal content", page_numbers: [3] };

const processedDocument = (overrides: Record<string, unknown> = {}) => ({
  documentId: "doc-1",
  iepId: "doc-1",
  status: "PROCESSED",
  updatedAt: 1700000000,
  abbreviations: { en: [] },
  // "accommodations" is a glossary term, so the summary carries a highlighted one.
  summaries: { en: "The team agreed on accommodations for reading." },
  document_index: { en: "" },
  sections: { en: [section] },
  ...overrides,
});

let documentPayload: Record<string, unknown>;
let profilePayload: Record<string, unknown>;
let fetchMock: ReturnType<typeof vi.fn>;

const puts = () =>
  fetchMock.mock.calls.filter(
    ([url, init]) => url === PROFILE_URL && (init as RequestInit | undefined)?.method === "PUT",
  );

beforeEach(() => {
  Auth.getCurrentUser.mockResolvedValue({ username: "u", userId: "u" });
  Auth.fetchAuthSession.mockResolvedValue({
    tokens: { idToken: { toString: () => "id-token", payload: {} } },
  });
  documentPayload = processedDocument();
  profilePayload = {
    userId: "user-1",
    secondaryLanguage: "en",
    showOnboarding: false,
    children: [{ childId: CHILD_ID, name: "Child" }],
  };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === PROFILE_URL && init?.method === "PUT") {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (url === PROFILE_URL) {
      return { ok: true, status: 200, json: async () => ({ profile: profilePayload }) };
    }
    if (url === DOCUMENTS_URL) {
      return { ok: true, status: 200, json: async () => documentPayload };
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const StateProbe = () => <output data-testid="location-state">{JSON.stringify(useLocation().state)}</output>;

const Layout = () => {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate("/account-center")}>
        go to account
      </button>
      <button type="button" onClick={() => navigate(SUMMARY_PATH)}>
        go to summary
      </button>
      <StateProbe />
    </>
  );
};

const renderPage = (entry: string | { pathname: string; state: unknown } = SUMMARY_PATH) => {
  const languageValue = {
    language: "en" as SupportedLanguage,
    setLanguage: vi.fn(),
    t,
    translationsLoaded: true,
    enabledLanguages: ["en"] as SupportedLanguage[],
  };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[entry]}>
        <AppContext.Provider value={appConfig}>
          <LanguageContext.Provider value={languageValue}>
            <Layout />
            <Routes>
              <Route path={SUMMARY_PATH} element={<IEPSummarizationAndTranslation />} />
              <Route path="/account-center" element={<div>account page</div>} />
              <Route path="/iep-documents" element={<div>documents page</div>} />
            </Routes>
          </LanguageContext.Provider>
        </AppContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

/** The page has read the profile and the document and drawn what it will draw. */
const pageDrawn = async () => {
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === DOCUMENTS_URL)).toBe(true));
  await waitFor(() =>
    expect(
      screen.queryByTestId("summary-tab-panel-en") ??
        screen.queryByTestId("processing-modal") ??
        screen.queryByTestId("summary-failed") ??
        screen.queryByTestId("replacement-region") ??
        screen.queryByTestId("summary-empty") ??
        screen.queryByTestId("no-content-available"),
    ).toBeInTheDocument(),
  );
  // Give the tour's effects the turn they would need to open.
  await new Promise((resolve) => setTimeout(resolve, 50));
};

describe("a finished summary", () => {
  test("offers the tour on a first visit, on the summary text", async () => {
    renderPage();

    expect(await screen.findByRole("dialog", { name: FIRST_STEP })).toBeInTheDocument();
    expect(screen.getByTestId("guided-tour-step")).toHaveTextContent("Step 1 of 4");
  });

  test("does not offer it to a parent who has seen it", async () => {
    profilePayload = { ...profilePayload, summaryTourSeen: true };
    renderPage();
    await pageDrawn();

    expect(screen.getByTestId("summary-tab-panel-en")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("walks to the glossary term and the page numbers this document really has", async () => {
    renderPage();
    await screen.findByRole("dialog");

    for (const title of ["rights.slide8.title", "rights.slide9.title", "rights.slide10.title"]) {
      await userEvent.click(screen.getByRole("button", { name: words["common.next"] }));
      expect(screen.getByRole("dialog")).toHaveAccessibleName(words[title]);
    }
    await userEvent.click(screen.getByRole("button", { name: words["common.done"] }));

    expect(puts()).toHaveLength(1);
    expect(JSON.parse(String((puts()[0][1] as RequestInit).body))).toEqual({ summaryTourSeen: true });
  });

  test("drops the steps this document has no target for", async () => {
    documentPayload = processedDocument({
      summaries: { en: "A summary with no glossary words in it." },
      sections: { en: [{ ...section, page_numbers: [] }] },
    });
    renderPage();

    await screen.findByRole("dialog");
    expect(screen.getByTestId("guided-tour-step")).toHaveTextContent("Step 1 of 2");
  });
});

describe("states that are not a finished summary", () => {
  test("not while the document is being processed", async () => {
    documentPayload = processedDocument({ status: "PROCESSING", summaries: { en: "" }, sections: { en: [] } });
    renderPage();
    await pageDrawn();

    expect(screen.getByTestId("processing-modal")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("not while a translation runs behind a summary that is readable", async () => {
    // The page keeps the English summary on screen here (suppressed takeover),
    // so the targets exist: only the status keeps the tour away.
    documentPayload = processedDocument({ status: "PROCESSING_TRANSLATIONS" });
    renderPage();
    await pageDrawn();

    expect(screen.getByTestId("summary-text-en")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("not on the screen for a replacement that is still processing", async () => {
    documentPayload = processedDocument({
      replacement: { iepId: "doc-2", status: "PROCESSING" },
    });
    renderPage();
    await pageDrawn();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("not on a document that failed", async () => {
    documentPayload = processedDocument({ status: "FAILED", summaries: { en: "" }, sections: { en: [] } });
    renderPage();
    await pageDrawn();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("not on a document with no content", async () => {
    documentPayload = processedDocument({ summaries: { en: "" }, sections: { en: [] } });
    renderPage();
    await pageDrawn();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("leaving mid-tour", () => {
  test("does not count as seen, and the tour is there on the way back", async () => {
    renderPage();
    await screen.findByRole("dialog");
    await userEvent.click(screen.getByRole("button", { name: words["common.next"] }));

    await userEvent.click(screen.getByRole("button", { name: "go to account", hidden: true }));
    expect(await screen.findByText("account page")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(puts()).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "go to summary" }));

    expect(await screen.findByRole("dialog", { name: FIRST_STEP })).toBeInTheDocument();
    expect(puts()).toHaveLength(0);
  });
});

describe("a replay asked for by the Support page", () => {
  test("starts the tour for a parent who has already seen it", async () => {
    profilePayload = { ...profilePayload, summaryTourSeen: true };
    renderPage({ pathname: SUMMARY_PATH, state: { [REPLAY_TOUR_STATE_KEY]: true } });

    expect(await screen.findByRole("dialog", { name: FIRST_STEP })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(puts()).toHaveLength(0);
  });

  test("clears the request, so a reload or the back button does not start it again", async () => {
    profilePayload = { ...profilePayload, summaryTourSeen: true };
    renderPage({ pathname: SUMMARY_PATH, state: { [REPLAY_TOUR_STATE_KEY]: true } });
    await screen.findByRole("dialog");

    await waitFor(() => expect(screen.getByTestId("location-state")).toHaveTextContent("null"));
  });

  test("shows nothing without the request, for a parent who has seen it", async () => {
    profilePayload = { ...profilePayload, summaryTourSeen: true };
    renderPage({ pathname: SUMMARY_PATH, state: { somethingElse: true } });
    await pageDrawn();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
