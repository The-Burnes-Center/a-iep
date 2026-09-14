/**
 * The summary page against a document whose content came back the wrong TYPE.
 *
 * A document written in the oldest storage layout stored its content already
 * serialized, so the field reads back as {'en': {S: '...'}} rather than
 * {'en': '...'}. Every read path that served it inline unwrapped that on the
 * way out, which hid it for as long as the document stayed in DynamoDB; the
 * lazy migration to S3 copied the wrapper through verbatim and made it
 * permanent. The page then treated the object as present (it is truthy),
 * rendered the summary card, and called .split on it.
 *
 * With no ErrorBoundary above it, that one throw unmounted the whole app: a
 * parent got a white screen, and the network tab showed a healthy 200 the
 * entire time. The fix is at the write end (s3_content_handler no longer
 * stores the wrapper) but the page must not be the thing that decides whether
 * a parent sees anything at all, so these pin the degradation.
 *
 * Only the network boundary is mocked (`fetch`, plus Amplify's `Auth`), same
 * as the sibling *.failure.test.tsx file.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
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

const ENGLISH_SUMMARY = "The English summary paragraph.\n\nA second paragraph.";

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

/** What the API returns today, once the content has been unwrapped. */
const healthyDocument = () => ({
  documentId: IEP_ID,
  status: "PROCESSED",
  updatedAt: 1700000000,
  abbreviations: {},
  summaries: { en: ENGLISH_SUMMARY },
  document_index: { en: "Index text" },
  sections: { en: [{ title: "Goals", content: "Goal content", page_numbers: [3] }] },
});

/**
 * The same document as it was actually served after a lazy migration: every
 * content field still wearing its DynamoDB type descriptor.
 */
const legacyWrappedDocument = () => ({
  documentId: IEP_ID,
  status: "PROCESSED",
  updatedAt: 1700000000,
  abbreviations: {},
  summaries: { en: { S: ENGLISH_SUMMARY } },
  document_index: { en: { S: "Index text" } },
  sections: {
    en: {
      L: [
        {
          M: {
            title: { S: "Goals" },
            content: { S: "Goal content" },
            page_numbers: { L: [{ N: "3" }] },
          },
        },
      ],
    },
  },
});

let documentPayload: Record<string, unknown>;

const renderPage = () => {
  const languageValue = {
    language: "en" as SupportedLanguage,
    setLanguage: vi.fn(),
    /** Identity t(): assertions read translation KEYS, as in the sibling files. */
    t: (key: string) => key,
    translationsLoaded: true,
    enabledLanguages: ["en"] as SupportedLanguage[],
  };

  render(
    <MemoryRouter initialEntries={["/summary-and-translations"]}>
      <AppContext.Provider value={appConfig}>
        <LanguageContext.Provider value={languageValue}>
          <Routes>
            <Route
              path="/summary-and-translations"
              element={<IEPSummarizationAndTranslation />}
            />
            <Route path="/iep-documents" element={<div>documents page</div>} />
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
  documentPayload = legacyWrappedDocument();

  const fetchMock = vi.fn(async (url: string) => {
    if (url === `${API_BASE}/profile`) {
      return jsonResponse(200, {
        profile: {
          userId: "user-1",
          secondaryLanguage: "en",
          showOnboarding: false,
          children: [{ childId: CHILD_ID, name: "Child" }],
        },
      });
    }
    if (url === DOCUMENTS_URL) return jsonResponse(200, documentPayload);
    throw new Error(`unexpected fetch to ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a document whose content is the wrong type", () => {
  test("renders the page instead of throwing out of the render", async () => {
    // The whole point: before the type check, this render threw
    // "content.split is not a function" and took the app down with it.
    renderPage();
    await settle();

    expect(screen.getByTestId("summary-tab-panel-en")).toBeInTheDocument();
  });

  test("says there is no summary rather than showing an empty card", async () => {
    renderPage();
    await settle();

    // A wrapped object is truthy, so the old existence check passed and the
    // card rendered around content it could not read. The parent is better
    // served by the state that already exists for "nothing to show yet",
    // which carries an instruction.
    expect(screen.getByTestId("summary-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("summary-text-en")).not.toBeInTheDocument();
  });

  test("shows no Key Insights sections for a wrapped sections list", async () => {
    renderPage();
    await settle();

    // Array.isArray({L: [...]}) is false, so normalization already yields an
    // empty list. Pinned so a future change to the shape does not start
    // rendering half-built section objects instead.
    expect(screen.queryAllByTestId("summary-section")).toHaveLength(0);
  });

  test("the same document unwrapped renders its summary normally", async () => {
    // The control: the fix is a type check, not a blanket refusal to render.
    documentPayload = healthyDocument();
    renderPage();
    await settle();

    expect(screen.getByTestId("summary-text-en")).toBeInTheDocument();
    expect(screen.queryByTestId("summary-empty")).not.toBeInTheDocument();
    expect(screen.queryAllByTestId("summary-section")).toHaveLength(1);
  });
});
