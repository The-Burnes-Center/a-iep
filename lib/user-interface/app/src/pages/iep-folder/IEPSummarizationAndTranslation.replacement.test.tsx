/**
 * What a parent sees on the summary page while they replace their IEP.
 *
 * The old IEP stays on screen until the new one is ready, so the page has to
 * say what is going on or the parent is left guessing whether the upload did
 * anything. Three states, each pinned here against the real page, the real
 * poller and the real hook (only `fetch` and Amplify's Auth are mocked):
 *
 *  - the new one is processing: a polite note, the old summary still there;
 *  - the new one failed: a note saying so, the old summary still there, and the
 *    upload page one tap away;
 *  - the new one is ready: the page switches to it and the note is gone.
 *
 * And the poll that waits for it is bounded by the same visible-time cap as
 * every other wait, ending in the inline check-again pattern rather than the
 * full-screen modal, which would hide the summary being read.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import IEPSummarizationAndTranslation from "./IEPSummarizationAndTranslation";
import { MAX_VISIBLE_POLL_MS } from "../utils/polling-utility";
import { AppContext } from "../../common/app-context";
import { LanguageContext } from "../../common/language-context";
import type { AppConfig } from "../../common/types";
import type { SupportedLanguage } from "../../common/languages";

const Auth = vi.hoisted(() => ({ getCurrentUser: vi.fn(),
  fetchAuthSession: vi.fn(), signOut: vi.fn() }));
vi.mock("aws-amplify/auth", () => Auth);

const API_BASE = "https://api.example.test/api";
const CHILD_ID = "child-abc";
const DOCUMENTS_URL = `${API_BASE}/profile/children/${CHILD_ID}/documents`;
const POLL_INTERVAL_MS = 5000;
const OLD_SUMMARY = "The old IEP summary.";
const NEW_SUMMARY = "The new IEP summary.";

const appConfig = {
  httpEndpoint: `${API_BASE}/`,
  enabledFeatures: [],
  enabledLanguages: ["en"],
} as unknown as AppConfig;

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const section = { title: "Goals", content: "Goal content", page_numbers: [3] };

const oldDocument = (replacement?: { iepId: string; status: string }) => ({
  documentId: "iep-old",
  iepId: "iep-old",
  status: "PROCESSED",
  createdAt: 1000,
  updatedAt: 1700000000,
  abbreviations: { en: [] },
  summaries: { en: OLD_SUMMARY },
  document_index: { en: "" },
  sections: { en: [section] },
  ...(replacement ? { replacement } : {}),
});

const newDocument = () => ({
  ...oldDocument(),
  documentId: "iep-new",
  iepId: "iep-new",
  createdAt: 2000,
  summaries: { en: NEW_SUMMARY },
});

let documentPayload: Record<string, unknown>;
let documentReads: number;

const translate = (key: string) => key;

const renderPage = (language: SupportedLanguage = "en") => {
  const languageValue = {
    language,
    setLanguage: vi.fn(),
    t: translate,
    translationsLoaded: true,
    enabledLanguages: ["en"] as SupportedLanguage[],
  };
  return render(
    // The app's query client sits above every screen (AppConfigured); the
    // page reads the shared ['profile'] cache through it.
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={["/summary-and-translations"]}>
      <AppContext.Provider value={appConfig}>
        <LanguageContext.Provider value={languageValue}>
          <Routes>
            <Route path="/summary-and-translations" element={<IEPSummarizationAndTranslation />} />
            <Route path="/iep-documents" element={<div>documents page</div>} />
            <Route path="/preferred-language" element={<div>onboarding</div>} />
            <Route path="/" element={<div>public site</div>} />
          </Routes>
        </LanguageContext.Provider>
      </AppContext.Provider>
    </MemoryRouter>
    </QueryClientProvider>,
  );
};

const settle = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
  });
};

const region = () => screen.getByTestId("replacement-region");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Math.floor(Date.now() / 1000) * 1000);
  Auth.getCurrentUser.mockResolvedValue({ username: "test-user", userId: "test-user" });
  Auth.fetchAuthSession.mockResolvedValue({
    tokens: { idToken: { toString: () => "id-token", payload: {} } },
  });
  documentReads = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === `${API_BASE}/profile`) {
      return jsonResponse(200, { profile: {
        userId: "user-1", secondaryLanguage: "en", showOnboarding: false,
        children: [{ childId: CHILD_ID, name: "Child" }],
      } });
    }
    if (url === DOCUMENTS_URL) {
      documentReads += 1;
      return jsonResponse(200, documentPayload);
    }
    throw new Error(`unexpected fetch to ${url}`);
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("while the new IEP is being processed", () => {
  beforeEach(() => {
    documentPayload = oldDocument({ iepId: "iep-new", status: "PROCESSING" });
  });

  test("the old summary stays on screen and a note says the new one is on its way", async () => {
    renderPage();
    await settle();

    expect(screen.getByTestId("summary-text-en")).toHaveTextContent(OLD_SUMMARY);
    expect(screen.queryByTestId("processing-modal")).not.toBeInTheDocument();
    expect(within(region()).getByTestId("replacement-processing"))
      .toHaveTextContent("summary.replacement.processing");
  });

  test("the note sits in a polite live region and takes nothing from the parent's focus", async () => {
    renderPage();
    await settle();

    expect(region()).toHaveAttribute("role", "status");
    expect(region()).toHaveAttribute("aria-live", "polite");
    expect(region()).not.toHaveAttribute("aria-live", "assertive");
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
    // Words and an icon, not colour alone; the icon is decorative.
    const note = within(region()).getByTestId("replacement-processing");
    expect(note.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(note.textContent?.trim().length).toBeGreaterThan(0);
  });

  test("the live region is one element throughout, so a change in it is announced", async () => {
    renderPage();
    await settle();
    const before = region();
    expect(before).toHaveTextContent("summary.replacement.processing");

    // The replacement fails: the same region now says so.
    documentPayload = oldDocument({ iepId: "iep-new", status: "FAILED" });
    await settle(POLL_INTERVAL_MS);

    expect(region()).toBe(before);
    expect(before).toHaveTextContent("summary.replacement.failed");
    expect(before).not.toHaveTextContent("summary.replacement.processing");
  });

  test("a page mounted again mid-replacement says the same thing again", async () => {
    const first = renderPage();
    await settle();
    first.unmount();

    renderPage();
    await settle();

    expect(screen.getByTestId("summary-text-en")).toHaveTextContent(OLD_SUMMARY);
    expect(screen.getByTestId("replacement-processing")).toBeInTheDocument();
  });

  test("when the new one is ready the page switches to it and the note is gone", async () => {
    renderPage();
    await settle();
    expect(screen.getByTestId("replacement-processing")).toBeInTheDocument();

    documentPayload = newDocument();
    await settle(POLL_INTERVAL_MS);

    expect(screen.getByTestId("summary-text-en")).toHaveTextContent(NEW_SUMMARY);
    expect(screen.queryByText(OLD_SUMMARY)).not.toBeInTheDocument();
    expect(region()).toBeEmptyDOMElement();
  });
});

describe("when the new IEP could not be processed", () => {
  beforeEach(() => {
    documentPayload = oldDocument({ iepId: "iep-new", status: "FAILED" });
  });

  test("the previous summary stays and a note says what happened", async () => {
    renderPage();
    await settle();

    expect(screen.getByTestId("summary-text-en")).toHaveTextContent(OLD_SUMMARY);
    expect(screen.queryByTestId("summary-failed")).not.toBeInTheDocument();
    expect(within(region()).getByTestId("replacement-failed"))
      .toHaveTextContent("summary.replacement.failed");
    expect(within(region()).getByTestId("replacement-failed").querySelector("svg"))
      .toHaveAttribute("aria-hidden", "true");
  });

  test("the upload page is one tap away", async () => {
    renderPage();
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "summary.replacement.uploadAgain" }));
    await settle();

    expect(screen.getByText("documents page")).toBeInTheDocument();
  });

  test("nothing is polled once there is nothing left to wait for", async () => {
    renderPage();
    await settle();
    const reads = documentReads;

    await settle(MAX_VISIBLE_POLL_MS);

    expect(documentReads).toBe(reads);
    expect(screen.queryByTestId("replacement-check-again")).not.toBeInTheDocument();
  });
});

describe("when the wait outlasts the polling cap", () => {
  beforeEach(() => {
    documentPayload = oldDocument({ iepId: "iep-new", status: "PROCESSING" });
  });

  test("the note becomes the inline stalled notice and the summary stays readable", async () => {
    renderPage();
    await settle();

    await settle(MAX_VISIBLE_POLL_MS + POLL_INTERVAL_MS * 4);

    expect(screen.queryByTestId("replacement-processing")).not.toBeInTheDocument();
    expect(within(region()).getByTestId("replacement-stalled"))
      .toHaveTextContent("summary.processing.stalled");
    expect(screen.getByRole("button", { name: "common.tryAgain" })).toBeInTheDocument();
    expect(screen.getByTestId("summary-text-en")).toHaveTextContent(OLD_SUMMARY);
    expect(screen.queryByTestId("processing-modal")).not.toBeInTheDocument();
  });

  test("polling really stops at the cap", async () => {
    renderPage();
    await settle();
    await settle(MAX_VISIBLE_POLL_MS + POLL_INTERVAL_MS * 4);
    const reads = documentReads;

    await settle(60_000);

    expect(documentReads).toBe(reads);
  });

  test("try again reads the document and, once the new one is ready, shows it", async () => {
    renderPage();
    await settle();
    await settle(MAX_VISIBLE_POLL_MS + POLL_INTERVAL_MS * 4);
    const reads = documentReads;

    documentPayload = newDocument();
    fireEvent.click(screen.getByRole("button", { name: "common.tryAgain" }));
    await settle();

    expect(documentReads).toBeGreaterThan(reads);
    expect(screen.getByTestId("summary-text-en")).toHaveTextContent(NEW_SUMMARY);
    expect(region()).toBeEmptyDOMElement();
  });
});

describe("without a replacement", () => {
  test("the region is there but empty, and says nothing", async () => {
    documentPayload = oldDocument();
    renderPage();
    await settle();

    expect(region()).toBeEmptyDOMElement();
  });
});
