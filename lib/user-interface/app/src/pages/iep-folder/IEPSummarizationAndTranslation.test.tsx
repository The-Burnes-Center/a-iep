/**
 * Wiring tests for translate-on-demand on the summary page.
 *
 * The pure decision logic (which languages to offer, what an HTTP status
 * means, when the takeover is suppressed) already has 48 tests in
 * test/lambdas/summary-page/translation-flow.test.mjs and is NOT re-tested
 * here. What is uncovered — and what this file pins — is the React wiring
 * around it: the button's click handler, the effects that switch language on
 * success and surface a failure, and `forcePolling` actually reaching the
 * poll interval.
 *
 * Only the network boundary is mocked (`fetch`, plus Amplify's `Auth` for the
 * bearer token). The real IEPDocumentClient, useDocumentFetch, PollingManager
 * and translation-flow modules all run, so a change that unhooks any of them
 * from the page fails here.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import IEPSummarizationAndTranslation from "./IEPSummarizationAndTranslation";
import { AppContext } from "../../common/app-context";
import { LanguageContext } from "../../common/language-context";
import { NotificationProvider, useNotifications } from "../../components/notif-manager";
import type { AppConfig } from "../../common/types";
import type { SupportedLanguage } from "../../common/languages";

const Auth = vi.hoisted(() => ({ currentAuthenticatedUser: vi.fn() }));
vi.mock("aws-amplify", () => ({ Auth }));

const API_BASE = "https://api.example.test/api";
const CHILD_ID = "child-abc";
const IEP_ID = "doc-1";
const POLL_INTERVAL_MS = 5000;
const TRANSLATION_TIMEOUT_MS = 10 * 60 * 1000;

const TRANSLATIONS_URL = `${API_BASE}/profile/children/${CHILD_ID}/documents/${IEP_ID}/translations`;
const DOCUMENTS_URL = `${API_BASE}/profile/children/${CHILD_ID}/documents`;

const ENGLISH_SUMMARY = "The English summary paragraph.";
const SPANISH_SUMMARY = "El resumen en espanol.";

const appConfig = {
  httpEndpoint: `${API_BASE}/`,
  // TTS dark, exactly as production runs it, so no audio buttons are mounted.
  enabledFeatures: [],
  enabledLanguages: ["en", "es"],
} as unknown as AppConfig;

interface StubResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

const jsonResponse = (status: number, body: unknown): StubResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const englishOnlyDocument = (overrides: Record<string, unknown> = {}) => ({
  documentId: IEP_ID,
  status: "PROCESSED",
  updatedAt: 1700000000,
  abbreviations: { en: [] },
  summaries: { en: ENGLISH_SUMMARY },
  document_index: { en: "" },
  sections: {
    en: [{ title: "Goals", content: "Goal content", page_numbers: [3] }],
  },
  ...overrides,
});

const translatedDocument = () =>
  englishOnlyDocument({
    summaries: { en: ENGLISH_SUMMARY, es: SPANISH_SUMMARY },
    sections: {
      en: [{ title: "Goals", content: "Goal content", page_numbers: [3] }],
      es: [{ title: "Goals", content: "Contenido del objetivo", page_numbers: [3] }],
    },
  });

/** Mutable so a later poll can answer differently from the first read. */
let documentPayload: Record<string, unknown>;
/** What the translations endpoint answers, or a throw for a network failure. */
let translationsAnswer: StubResponse | Error;
let fetchMock: ReturnType<typeof vi.fn>;

const countCalls = (url: string) =>
  fetchMock.mock.calls.filter(([called]) => String(called) === url).length;

const translationsBody = () => {
  const call = fetchMock.mock.calls.find(([url]) => String(url) === TRANSLATIONS_URL);
  return call ? JSON.parse(call[1].body as string) : null;
};

/** Renders the notification queue so a success toast is observable. */
const NotificationProbe = () => {
  const { notifications } = useNotifications();
  return (
    <ul data-testid="notifications">
      {notifications.map((notification) => (
        <li key={notification.id}>{notification.content}</li>
      ))}
    </ul>
  );
};

const renderPage = (language: SupportedLanguage = "es") => {
  const languageValue = {
    language,
    setLanguage: vi.fn(),
    // Identity t(): assertions read translation KEYS, which is what the page
    // chooses. The English wording is not the contract.
    t: (key: string) => key,
    translationsLoaded: true,
    enabledLanguages: ["en", "es"] as SupportedLanguage[],
  };

  render(
    <MemoryRouter initialEntries={["/summary"]}>
      <AppContext.Provider value={appConfig}>
        <LanguageContext.Provider value={languageValue}>
          <NotificationProvider>
            <NotificationProbe />
            <Routes>
              <Route path="/summary" element={<IEPSummarizationAndTranslation />} />
              <Route path="/iep-documents" element={<div>documents page</div>} />
              <Route path="/" element={<div>home page</div>} />
            </Routes>
          </NotificationProvider>
        </LanguageContext.Provider>
      </AppContext.Provider>
    </MemoryRouter>,
  );
};

/** Advance fake timers and let every queued promise/effect flush. */
const settle = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
  });
};

const clickTranslate = async () => {
  fireEvent.click(screen.getByTestId("translate-now-button"));
  await settle();
};

beforeEach(async () => {
  vi.useFakeTimers();
  Auth.currentAuthenticatedUser.mockResolvedValue({
    signInUserSession: { idToken: { jwtToken: "id-token" } },
  });
  documentPayload = englishOnlyDocument();
  translationsAnswer = jsonResponse(202, {
    status: "PROCESSING_TRANSLATIONS",
    language: "es",
    iepId: IEP_ID,
    alreadyExists: false,
  });

  fetchMock = vi.fn(async (url: string) => {
    if (url === `${API_BASE}/profile`) {
      return jsonResponse(200, {
        profile: {
          userId: "user-1",
          secondaryLanguage: "es",
          showOnboarding: false,
          children: [{ childId: CHILD_ID, name: "Child" }],
        },
      });
    }
    if (url === DOCUMENTS_URL) return jsonResponse(200, documentPayload);
    if (url === TRANSLATIONS_URL) {
      if (translationsAnswer instanceof Error) throw translationsAnswer;
      return translationsAnswer;
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the translate button", () => {
  test("is offered for a preferred language the document has no content for", async () => {
    renderPage();
    await settle();

    expect(screen.getByTestId("translate-preferred-language")).toBeInTheDocument();
    expect(screen.getByTestId("translate-now-button")).toBeInTheDocument();
    // The English content the parent already has stays readable behind it.
    expect(screen.getByTestId("summary-text-en")).toHaveTextContent(ENGLISH_SUMMARY);
  });

  test("posts the preferred language and swaps itself for inline progress", async () => {
    renderPage();
    await settle();

    await clickTranslate();

    expect(countCalls(TRANSLATIONS_URL)).toBe(1);
    expect(translationsBody()).toEqual({ language: "es" });
    expect(screen.getByTestId("translation-progress")).toHaveTextContent(
      "summary.processing.almostThere",
    );
    expect(screen.queryByTestId("translate-now-button")).not.toBeInTheDocument();
    // Inline, NOT the full-screen takeover: the English summary is still there.
    expect(screen.getByTestId("summary-text-en")).toBeInTheDocument();
  });

  test("locks the language picker while the request is in flight", async () => {
    renderPage();
    await settle();
    expect(screen.getByRole("button", { name: "ENGLISH" })).toBeEnabled();

    await clickTranslate();

    // Changing the preference mid-flight would leave the running request
    // pointing at a language the parent no longer wants.
    expect(screen.getByRole("button", { name: "ENGLISH" })).toBeDisabled();
  });
});

describe("forcePolling", () => {
  test("a PROCESSED document is not polled until a translation is requested", async () => {
    renderPage();
    await settle();
    const beforeIdleWait = countCalls(DOCUMENTS_URL);

    await settle(POLL_INTERVAL_MS * 3);

    // Control for the test below: nothing in flight means no interval at all.
    expect(countCalls(DOCUMENTS_URL)).toBe(beforeIdleWait);
  });

  test("keeps re-reading the document every interval while the translation runs", async () => {
    renderPage();
    await settle();
    await clickTranslate();
    const afterRequest = countCalls(DOCUMENTS_URL);

    await settle(POLL_INTERVAL_MS);
    expect(countCalls(DOCUMENTS_URL)).toBe(afterRequest + 1);

    await settle(POLL_INTERVAL_MS);
    expect(countCalls(DOCUMENTS_URL)).toBe(afterRequest + 2);
  });

  test("stops polling once the request has failed", async () => {
    translationsAnswer = jsonResponse(403, { message: "Forbidden" });
    renderPage();
    await settle();

    await clickTranslate();
    const afterFailure = countCalls(DOCUMENTS_URL);
    await settle(POLL_INTERVAL_MS * 3);

    expect(countCalls(DOCUMENTS_URL)).toBe(afterFailure);
  });
});

describe("while the backend is translating", () => {
  test("the full-screen processing takeover never hides the English content", async () => {
    renderPage();
    await settle();
    await clickTranslate();

    // The request flips the document back to PROCESSING_TRANSLATIONS, which
    // normally means "the upload pipeline is running" and hides the page.
    documentPayload = englishOnlyDocument({ status: "PROCESSING_TRANSLATIONS" });
    await settle(POLL_INTERVAL_MS);

    expect(screen.getByTestId("summary-text-en")).toHaveTextContent(ENGLISH_SUMMARY);
    expect(screen.getByTestId("translation-progress")).toBeInTheDocument();
  });
});

describe("when the translation lands", () => {
  const arriveTranslated = async () => {
    renderPage();
    await settle();
    await clickTranslate();
    documentPayload = translatedDocument();
    await settle(POLL_INTERVAL_MS);
  };

  test("switches the parent onto their language and confirms it", async () => {
    await arriveTranslated();

    expect(screen.getByTestId("summary-text-es")).toHaveTextContent(SPANISH_SUMMARY);
    // The picker reflecting the new selection is how the language switch shows.
    expect(screen.getByRole("button", { name: "ESPAÑOL" })).toBeInTheDocument();
    expect(screen.getByTestId("notifications")).toHaveTextContent("summary.translate.ready");
  });

  test("retires the banner and the progress bar", async () => {
    await arriveTranslated();

    expect(screen.queryByTestId("translate-preferred-language")).not.toBeInTheDocument();
    expect(screen.queryByTestId("translation-progress")).not.toBeInTheDocument();
    // Request finished: the picker is usable again.
    expect(screen.getByRole("button", { name: "ESPAÑOL" })).toBeEnabled();
  });
});

describe("when the translation does not land", () => {
  test.each([
    [400, "summary.translate.error.language"],
    [403, "summary.translate.error.notAllowed"],
    [404, "summary.translate.error.notFound"],
    [429, "summary.translate.error.budgetSpent"],
    [500, "summary.translate.error.generic"],
  ])("a %i shows its own message and offers the button again", async (status, messageKey) => {
    translationsAnswer = jsonResponse(status, { message: "server side detail" });
    renderPage();
    await settle();

    await clickTranslate();

    expect(screen.getByTestId("translation-error")).toHaveTextContent(messageKey);
    // The server's own body is generic by design and must never be shown.
    expect(screen.getByTestId("translation-error")).not.toHaveTextContent("server side detail");
    expect(screen.getByTestId("translate-now-button")).toBeInTheDocument();
  });

  test("a request that never reaches the API is a generic, retryable error", async () => {
    translationsAnswer = new TypeError("Failed to fetch");
    renderPage();
    await settle();

    await clickTranslate();

    expect(screen.getByTestId("translation-error")).toHaveTextContent(
      "summary.translate.error.generic",
    );
    expect(screen.getByTestId("translate-now-button")).toBeInTheDocument();
  });

  test("a run that finishes without producing the language becomes retryable at once", async () => {
    renderPage();
    await settle();
    await clickTranslate();

    // The request moves the document to PROCESSING_TRANSLATIONS while the
    // machine runs...
    documentPayload = englishOnlyDocument({ status: "PROCESSING_TRANSLATIONS" });
    await settle(POLL_INTERVAL_MS);
    // ...and a failed add-on translation deliberately leaves it PROCESSED —
    // the parent keeps their English content — recording the outcome here.
    documentPayload = englishOnlyDocument({ current_step: "translation_failed" });
    await settle(POLL_INTERVAL_MS);

    expect(screen.getByTestId("translation-error")).toHaveTextContent(
      "summary.translate.error.failed",
    );
    expect(screen.getByTestId("translate-now-button")).toBeInTheDocument();
    expect(screen.queryByTestId("translation-progress")).not.toBeInTheDocument();
  });

  test("a request that vanishes is failed by the backstop instead of spinning forever", async () => {
    renderPage();
    await settle();
    await clickTranslate();
    expect(screen.getByTestId("translation-progress")).toBeInTheDocument();

    await settle(TRANSLATION_TIMEOUT_MS);

    expect(screen.getByTestId("translation-error")).toHaveTextContent(
      "summary.translate.error.generic",
    );
    expect(screen.getByTestId("translate-now-button")).toBeInTheDocument();
  });
});
