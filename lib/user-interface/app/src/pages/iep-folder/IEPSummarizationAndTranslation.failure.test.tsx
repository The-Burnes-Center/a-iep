/**
 * The redesigned document-failure screen, exercised through the real page
 * (routing included) rather than in isolation.
 *
 * DocumentFailureState's own rendering — copy, which affordance shows when —
 * is covered in DocumentFailureState.test.tsx, and canRetryFailedDocument's
 * decision is covered on its own in document-failure.test.ts. What only a
 * full render of the page can pin is that the FAILED branch actually reaches
 * that component, that each action navigates somewhere real instead of
 * nowhere, and that a processed document's summary is untouched by the
 * change (the defect this replaces was a dead end, not a missing summary).
 *
 * Only the network boundary is mocked (`fetch`, plus Amplify's `Auth`), same
 * as the sibling *.processing.test.tsx file.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import IEPSummarizationAndTranslation from "./IEPSummarizationAndTranslation";
import { AppContext } from "../../common/app-context";
import { LanguageContext } from "../../common/language-context";
import type { AppConfig } from "../../common/types";
import type { SupportedLanguage } from "../../common/languages";

const Auth = vi.hoisted(() => ({ getCurrentUser: vi.fn(), fetchAuthSession: vi.fn() }));
vi.mock("aws-amplify/auth", () => Auth);

const API_BASE = "https://api.example.test/api";
const CHILD_ID = "child-abc";
const IEP_ID = "doc-1";
const DOCUMENTS_URL = `${API_BASE}/profile/children/${CHILD_ID}/documents`;

const ENGLISH_SUMMARY = "The English summary paragraph.";
const DOCUMENTS_PAGE = "you are on the documents page";

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

const failedDocument = () => ({ documentId: IEP_ID, status: "FAILED" });

const processedDocument = () => ({
  documentId: IEP_ID,
  status: "PROCESSED",
  updatedAt: 1700000000,
  abbreviations: { en: [] },
  summaries: { en: ENGLISH_SUMMARY },
  document_index: { en: "" },
  sections: { en: [] },
});

const finishedProfile = () => ({
  userId: "user-1",
  secondaryLanguage: "en",
  showOnboarding: false,
  children: [{ childId: CHILD_ID, name: "Child" }],
});

let documentPayload: Record<string, unknown>;
let profilePayload: Record<string, unknown>;

/** t() is the identity so assertions read translation KEYS, as in the sibling files. */
const translate = (key: string) => key;

const renderPage = () => {
  const languageValue = {
    language: "en" as SupportedLanguage,
    setLanguage: vi.fn(),
    t: translate,
    translationsLoaded: true,
    enabledLanguages: ["en"] as SupportedLanguage[],
  };

  render(
    <MemoryRouter initialEntries={["/summary-and-translations"]}>
      <AppContext.Provider value={appConfig}>
        <LanguageContext.Provider value={languageValue}>
          <Routes>
            <Route path="/summary-and-translations" element={<IEPSummarizationAndTranslation />} />
            <Route path="/iep-documents" element={<div>{DOCUMENTS_PAGE}</div>} />
          </Routes>
        </LanguageContext.Provider>
      </AppContext.Provider>
    </MemoryRouter>,
  );
};

const settle = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  Auth.getCurrentUser.mockResolvedValue({ username: "test-user", userId: "test-user" });
  Auth.fetchAuthSession.mockResolvedValue({
    tokens: { idToken: { toString: () => "id-token", payload: {} } },
  });
  documentPayload = failedDocument();
  profilePayload = finishedProfile();

  const fetchMock = vi.fn(async (url: string) => {
    if (url === `${API_BASE}/profile`) return jsonResponse(200, { profile: profilePayload });
    if (url === DOCUMENTS_URL) return jsonResponse(200, documentPayload);
    throw new Error(`unexpected fetch to ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the document-failure screen", () => {
  test("a FAILED document reaches the redesigned failure state, not the old alert", async () => {
    renderPage();
    await settle();

    expect(screen.getByTestId("document-failure-state")).toBeInTheDocument();
    expect(screen.getByTestId("summary-failed")).toBeInTheDocument();
  });

  test("offers to try a different file when nothing marks the document unretryable", async () => {
    renderPage();
    await settle();

    // Today's only real case: the backend never sends a failureReason, so
    // canRetryFailedDocument has nothing to disqualify the retry on.
    expect(screen.getByTestId("failure-try-different-file")).toBeInTheDocument();
    expect(screen.queryByTestId("failure-go-to-documents")).not.toBeInTheDocument();
  });

  test("the retry action leads somewhere real, not a dead end", async () => {
    renderPage();
    await settle();

    fireEvent.click(screen.getByTestId("failure-try-different-file"));

    expect(screen.getByText(DOCUMENTS_PAGE)).toBeInTheDocument();
  });

  test("a processed document's summary is unchanged by the redesign", async () => {
    documentPayload = processedDocument();
    renderPage();
    await settle();

    expect(screen.queryByTestId("document-failure-state")).not.toBeInTheDocument();
    expect(screen.queryByTestId("summary-failed")).not.toBeInTheDocument();
    expect(screen.getByTestId("summary-text-en")).toHaveTextContent(ENGLISH_SUMMARY);
  });
});
