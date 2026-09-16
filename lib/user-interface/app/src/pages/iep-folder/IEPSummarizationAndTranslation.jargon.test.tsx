/**
 * The glossary drawer a parent opens by tapping a highlighted word.
 *
 * The highlight is case-insensitive, so the word on screen is however the
 * document wrote it. The drawer's title used to be read straight off that
 * text, which titled the drawer "accommodations" whenever the document said
 * "accommodations" mid-sentence. It reads the span's data-term now, which
 * content-processor fills from the glossary key.
 *
 * Only the network boundary is mocked (`fetch`, plus Amplify's `Auth`). The
 * real content-processor, drawer and click handler all run, so this covers
 * both halves of that fix: the attribute being written, and it being read.
 *
 * The rest of this page's behaviour lives in the other test files beside it.
 */
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import IEPSummarizationAndTranslation from "./IEPSummarizationAndTranslation";
import { AppContext } from "../../common/app-context";
import { LanguageContext } from "../../common/language-context";
import type { AppConfig } from "../../common/types";

const Auth = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  fetchAuthSession: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("aws-amplify/auth", () => Auth);

const API_BASE = "https://api.example.test/api";
const CHILD_ID = "child-abc";
const DOCUMENTS_URL = `${API_BASE}/profile/children/${CHILD_ID}/documents`;

// Lowercase mid-sentence, which is how a real summary usually phrases it and
// exactly the case that used to reach the drawer title.
const SUMMARY = "The team agreed on accommodations for reading.";

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

const processedDocument = () => ({
  documentId: "doc-1",
  status: "PROCESSED",
  updatedAt: 1700000000,
  abbreviations: { en: [] },
  summaries: { en: SUMMARY },
  document_index: { en: "" },
  sections: { en: [] },
});

const finishedProfile = () => ({
  userId: "user-1",
  secondaryLanguage: "en",
  showOnboarding: false,
  children: [{ childId: CHILD_ID, name: "Child" }],
});

const renderPage = () => {
  const languageValue = {
    language: "en" as const,
    setLanguage: vi.fn(),
    t: (key: string) => key,
    translationsLoaded: true,
    enabledLanguages: ["en" as const],
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
          </Routes>
        </LanguageContext.Provider>
      </AppContext.Provider>
    </MemoryRouter>,
  );
};

const highlightedWord = async (): Promise<HTMLElement> => {
  const summary = await screen.findByTestId("summary-text-en");
  const span = summary.querySelector<HTMLElement>("span.jargon-term");
  if (!span) throw new Error("no jargon term was highlighted in the summary");
  return span;
};

beforeEach(() => {
  Auth.getCurrentUser.mockResolvedValue({ username: "test-user", userId: "test-user" });
  Auth.fetchAuthSession.mockResolvedValue({
    tokens: { idToken: { toString: () => "id-token", payload: {} } },
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === `${API_BASE}/profile`) {
        return jsonResponse(200, { profile: finishedProfile() });
      }
      if (url === DOCUMENTS_URL) return jsonResponse(200, processedDocument());
      throw new Error(`unexpected fetch to ${url}`);
    }),
  );
});

describe("tapping a highlighted word", () => {
  test("titles the drawer with the glossary's spelling, not the document's", async () => {
    renderPage();
    const word = await highlightedWord();

    expect(word.textContent).toBe("accommodations");
    word.click();

    const title = await screen.findByRole("heading", { level: 3 });
    expect(title).toHaveTextContent("Accommodations");
  });

  test("shows that word's definition", async () => {
    renderPage();
    (await highlightedWord()).click();

    await waitFor(() =>
      expect(
        screen.getByText(/Accommodations are adaptations made for specific individuals/),
      ).toBeInTheDocument(),
    );
  });

  test("leaves the summary itself phrased the way the document phrased it", async () => {
    renderPage();
    (await highlightedWord()).click();

    // The drawer is titled from the attribute; the child's document is not
    // re-cased on screen to match it.
    await screen.findByRole("heading", { level: 3 });
    expect(screen.getByTestId("summary-text-en")).toHaveTextContent(SUMMARY);
  });
});
