/**
 * The controls a parent presses on the summary, reached the way a keyboard or
 * screen reader user reaches them: a glossary term that opens with Enter, the
 * Read More toggle, the one primary action on the screen, and the
 * replace-document button.
 *
 * Only the network boundary is mocked (`fetch`, plus Amplify's `Auth`), the
 * same as the sibling jargon test, so the real page, drawer and click handler
 * all run.
 */
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

// Two paragraphs, so the summary is long enough for Read More to appear.
// Long enough to fold: the preview holds at least PREVIEW_MIN_CHARS of text
// (summary-preview.ts), so the first paragraph alone has to reach that.
const LONG_SUMMARY =
  "The first paragraph of the summary says what the IEP is for, who it covers and how long it lasts, " +
  "in the plain words a parent reads it in, and it is long enough to be the preview on its own." +
  "\n\nThe second paragraph of the summary.";
const GLOSSARY_SUMMARY = "The team agreed on accommodations for reading.";

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

const processedDocument = (summary: string) => ({
  documentId: "doc-1",
  status: "PROCESSED",
  updatedAt: 1700000000,
  abbreviations: { en: [] },
  summaries: { en: summary },
  document_index: { en: "" },
  sections: { en: [] },
});

const finishedProfile = () => ({
  userId: "user-1",
  secondaryLanguage: "en",
  showOnboarding: false,
  summaryTourSeen: true,
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
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/summary-and-translations"]}>
        <AppContext.Provider value={appConfig}>
          <LanguageContext.Provider value={languageValue}>
            <Routes>
              <Route path="/summary-and-translations" element={<IEPSummarizationAndTranslation />} />
              <Route path="*" element={<p>documents-screen</p>} />
            </Routes>
          </LanguageContext.Provider>
        </AppContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const mockDocument = (summary: string) => {
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
      if (url === DOCUMENTS_URL) return jsonResponse(200, processedDocument(summary));
      throw new Error(`unexpected fetch to ${url}`);
    }),
  );
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("a glossary term", () => {
  test("is a button, and Enter opens its definition without a mouse", async () => {
    mockDocument(GLOSSARY_SUMMARY);
    renderPage();

    const summary = await screen.findByTestId("summary-text-en");
    const term = summary.querySelector<HTMLElement>("button.jargon-term");
    if (!term) throw new Error("no glossary term was highlighted");
    expect(term).toHaveAttribute("type", "button");
    expect(term).toHaveAccessibleName("accommodations");

    term.focus();
    await userEvent.keyboard("{Enter}");

    expect(await screen.findByRole("heading", { level: 3 })).toHaveTextContent("Accommodations");
  });
});

describe("Read More", () => {
  test("is a button that shows the rest of a long summary and then folds it back", async () => {
    mockDocument(LONG_SUMMARY);
    renderPage();

    const readMore = await screen.findByRole("button", { name: "summary.readMore" });
    expect(readMore).toHaveAttribute("type", "button");
    expect(screen.getByTestId("summary-text-en")).not.toHaveTextContent("The second paragraph");

    await userEvent.click(readMore);

    expect(screen.getByTestId("summary-text-en")).toHaveTextContent("The second paragraph");
    await userEvent.click(screen.getByRole("button", { name: "summary.showLess" }));
    expect(screen.getByTestId("summary-text-en")).not.toHaveTextContent("The second paragraph");
  });
});

describe("the screen's primary action", () => {
  test("is Download, and it is the only primary button while a summary is on screen", async () => {
    mockDocument(LONG_SUMMARY);
    renderPage();

    const download = await screen.findByTestId("download-pdf-button");
    expect(download.tagName).toBe("BUTTON");
    expect(download).toHaveAccessibleName("common.download");

    const primaries = document.querySelectorAll(".ui-button--primary");
    expect(primaries).toHaveLength(1);
    expect(primaries[0]).toBe(download);
  });
});

describe("replace document", () => {
  test("is a real button that opens the documents page", async () => {
    mockDocument(LONG_SUMMARY);
    renderPage();

    const replace = await screen.findByTestId("replace-document-link");
    expect(replace.tagName).toBe("BUTTON");
    expect(replace).toHaveAccessibleName("upload.replaceDocument");

    await userEvent.click(replace);

    await waitFor(() => expect(screen.getByText("documents-screen")).toBeInTheDocument());
  });
});
