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
import MobileTopNavigation from "../../components/MobileTopNavigation";
import { AppContext } from "../../common/app-context";
import { LanguageContext } from "../../common/language-context";
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
const ACCOUNT_LANDING = "you are on the account page";

/**
 * The bottom nav labels its buttons with `Navigate to ${t(key)}`, and t() is the
 * identity here, so these are the keys.
 */
const NAV_TO_ACCOUNT = "Navigate to navigation.account";
const NAV_TO_SUMMARY = "Navigate to navigation.summary";

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

/**
 * Stands in for Account Center. It carries the real bottom nav, because that is
 * how a parent gets back and the tests below need the trip to be a round one.
 */
const AccountPage = () => (
  <div>
    {ACCOUNT_LANDING}
    <MobileTopNavigation />
  </div>
);

const renderPage = (
  language: SupportedLanguage = "es",
  initialPath = "/summary",
) => {
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
    <MemoryRouter initialEntries={[initialPath]}>
      <AppContext.Provider value={appConfig}>
        <LanguageContext.Provider value={languageValue}>
            <Routes>
              <Route path="/summary" element={<IEPSummarizationAndTranslation />} />
              {/* The page's REAL path, and the tab the bottom nav's own buttons
                  point at, so a trip through the nav is a genuine route change
                  rather than a simulated unmount. */}
              <Route
                path="/summary-and-translations"
                element={<IEPSummarizationAndTranslation />}
              />
              <Route path="/account-center" element={<AccountPage />} />
              <Route path="/iep-documents" element={<div>documents page</div>} />
              <Route path="/" element={<div>home page</div>} />
            </Routes>
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

  test("switches the parent onto their language", async () => {
    await arriveTranslated();

    expect(screen.getByTestId("summary-text-es")).toHaveTextContent(SPANISH_SUMMARY);
    // The picker reflecting the new selection is how the language switch shows.
    expect(screen.getByRole("button", { name: "ESPAÑOL" })).toBeInTheDocument();
  });

  test("retires the banner and the progress bar", async () => {
    await arriveTranslated();

    expect(screen.queryByTestId("translate-preferred-language")).not.toBeInTheDocument();
    expect(screen.queryByTestId("translation-progress")).not.toBeInTheDocument();
    // Request finished: the picker is usable again.
    expect(screen.getByRole("button", { name: "ESPAÑOL" })).toBeEnabled();
  });
});

describe("stepping away to another tab mid-translation", () => {
  // REGRESSION, and the exact reported journey: start a translation, tap
  // Account, come back. The bottom nav is a ROUTE change, so the trip unmounts
  // this page and resets translationRequest to idle. The backend kept working
  // and the content did land, but for the rest of the wait the parent got the
  // "Translate it now" button back as if nothing had happened, the arrival
  // neither switched them onto their language nor said anything, and a run that
  // failed reported nothing at all. Every one of those reads the phase.
  //
  // These go through the nav's own buttons rather than calling unmount(),
  // because "leaving this page is an unmount" IS the premise under test.

  const arriveMidTranslation = async () => {
    renderPage("es", "/summary-and-translations");
    await settle();
    await clickTranslate();
    // The request flips the document server-side; the poller reads that back.
    documentPayload = englishOnlyDocument({ status: "PROCESSING_TRANSLATIONS" });
    await settle(POLL_INTERVAL_MS);
  };

  const stepAwayAndBack = async () => {
    fireEvent.click(screen.getByRole("button", { name: NAV_TO_ACCOUNT }));
    await settle();
    // The premise, asserted rather than assumed: the summary page is really
    // gone while the parent is on Account. If this ever stops being true the
    // tests below would pass for the wrong reason.
    expect(screen.getByText(ACCOUNT_LANDING)).toBeInTheDocument();
    expect(screen.queryByTestId("translation-progress")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: NAV_TO_SUMMARY }));
    await settle();
  };

  test("the wait is still on screen when they come back", async () => {
    await arriveMidTranslation();
    expect(screen.getByTestId("translation-progress")).toBeInTheDocument();

    await stepAwayAndBack();

    expect(screen.getByTestId("translation-progress")).toBeInTheDocument();
    // And the button is NOT back offering work that is already running.
    expect(screen.queryByTestId("translate-now-button")).not.toBeInTheDocument();
  });

  test("it says the work is already under way, not that it is starting", async () => {
    await arriveMidTranslation();

    await stepAwayAndBack();

    // They did not just press anything, so the 202's wording would misdescribe
    // both what happened and how much longer it takes.
    expect(screen.getByTestId("translation-progress")).toHaveTextContent(
      "summary.translate.alreadyRunning",
    );
  });

  test("the English content is still readable behind it", async () => {
    await arriveMidTranslation();

    await stepAwayAndBack();

    expect(screen.getByTestId("summary-text-en")).toHaveTextContent(ENGLISH_SUMMARY);
  });

  test("the document keeps being polled after the return", async () => {
    await arriveMidTranslation();
    await stepAwayAndBack();
    const afterReturn = countCalls(DOCUMENTS_URL);

    await settle(POLL_INTERVAL_MS);

    expect(countCalls(DOCUMENTS_URL)).toBe(afterReturn + 1);
  });

  test("the arrival still puts them on their language", async () => {
    await arriveMidTranslation();
    await stepAwayAndBack();

    documentPayload = translatedDocument();
    await settle(POLL_INTERVAL_MS);

    expect(screen.getByTestId("summary-text-es")).toHaveTextContent(SPANISH_SUMMARY);
    expect(screen.getByRole("button", { name: "ESPAÑOL" })).toBeInTheDocument();
  });

  test("a run that fails while they are away is still reported", async () => {
    await arriveMidTranslation();
    await stepAwayAndBack();

    // A failed add-on translation deliberately leaves the document PROCESSED,
    // so current_step is the only signal there is.
    documentPayload = englishOnlyDocument({ current_step: "translation_failed" });
    await settle(POLL_INTERVAL_MS);

    expect(screen.getByTestId("translation-error")).toHaveTextContent(
      "summary.translate.error.failed",
    );
    expect(screen.getByTestId("translate-now-button")).toBeInTheDocument();
    expect(screen.queryByTestId("translation-progress")).not.toBeInTheDocument();
  });

  test("a request that vanished while they were away still hits the backstop", async () => {
    await arriveMidTranslation();
    await stepAwayAndBack();

    await settle(TRANSLATION_TIMEOUT_MS);

    expect(screen.getByTestId("translation-error")).toHaveTextContent(
      "summary.translate.error.generic",
    );
    expect(screen.getByTestId("translate-now-button")).toBeInTheDocument();
  });

  test("no wait is invented for a document that is not translating", async () => {
    // Control for all of the above: the progress state is rebuilt from the
    // document, so a document with nothing running must rebuild nothing.
    renderPage("es", "/summary-and-translations");
    await settle();

    await stepAwayAndBack();

    expect(screen.queryByTestId("translation-progress")).not.toBeInTheDocument();
    expect(screen.getByTestId("translate-now-button")).toBeInTheDocument();
  });

  test("waits for the profile before deciding which language is running", async () => {
    // preferredLanguage falls back to the language CONTEXT until the profile
    // lands, so a document read that wins the race would pin the resumed
    // request to the wrong language — and because a request is only adopted
    // from idle, that wrong answer would then stick for the whole run: the
    // arrival is never recognised and the parent watches the bar until the
    // backstop fires.
    let releaseProfile = () => {};
    const pageProfileLoaded = new Promise<void>((resolve) => {
      releaseProfile = resolve;
    });

    // TWO independent /profile reads race here: this page loads the profile
    // for itself, and IEPDocumentClient loads it again to find the child id
    // before it can read the document. Holding only the page's own (issued
    // first, its effect is declared before useDocumentFetch's) lets a document
    // status arrive while preferredLanguage is still falling back to the
    // language CONTEXT. That is the whole race, and it is reachable precisely
    // because the two reads are separate calls.
    let profileReads = 0;
    documentPayload = englishOnlyDocument({ status: "PROCESSING_TRANSLATIONS" });
    fetchMock = vi.fn(async (url: string) => {
      if (url === `${API_BASE}/profile`) {
        profileReads += 1;
        if (profileReads === 1) await pageProfileLoaded;
        // The profile says Spanish; the context below says Chinese.
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
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const languageValue = {
      language: "zh" as SupportedLanguage,
      setLanguage: vi.fn(),
      t: (key: string) => key,
      translationsLoaded: true,
      enabledLanguages: ["en", "es", "zh"] as SupportedLanguage[],
    };
    render(
      <MemoryRouter initialEntries={["/summary-and-translations"]}>
        <AppContext.Provider
          value={{ ...appConfig, enabledLanguages: ["en", "es", "zh"] } as unknown as AppConfig}
        >
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

    // The document lands first, while the profile is still in flight.
    await settle();
    releaseProfile();
    await settle();

    // Spanish is what the backend is producing, so Spanish arriving is what
    // must end the wait.
    documentPayload = translatedDocument();
    await settle(POLL_INTERVAL_MS);

    expect(screen.getByTestId("summary-text-es")).toHaveTextContent(SPANISH_SUMMARY);
    expect(screen.queryByTestId("translation-progress")).not.toBeInTheDocument();
    // The load-bearing one. Pinning the request to the wrong language leaves
    // the phase running forever, because the language it is waiting for is
    // never coming, and the picker stays locked against a parent who is no
    // longer waiting for anything. The banner is already gone by now (their
    // language arrived), so this lock is the only surviving symptom.
    expect(screen.getByRole("button", { name: "ESPAÑOL" })).toBeEnabled();
  });

  test("an error already shown is not resurrected into a spinner", async () => {
    // The backstop fires while the document still says PROCESSING_TRANSLATIONS.
    // Rebuilding the running phase from that status would undo the backstop and
    // loop for as long as the status held, which is worse than the bug this
    // whole block fixes: a spinner that provably cannot end.
    await arriveMidTranslation();
    await settle(TRANSLATION_TIMEOUT_MS);

    expect(screen.getByTestId("translation-error")).toHaveTextContent(
      "summary.translate.error.generic",
    );
    expect(screen.queryByTestId("translation-progress")).not.toBeInTheDocument();

    // Still PROCESSING_TRANSLATIONS, and still not a spinner, one poll later.
    await settle(POLL_INTERVAL_MS * 2);
    expect(screen.queryByTestId("translation-progress")).not.toBeInTheDocument();
    expect(screen.getByTestId("translate-now-button")).toBeInTheDocument();
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

describe("the English content stays readable while a translation runs", () => {
  // REGRESSION. processLanguageSections used to bail unless the status was
  // exactly PROCESSED, and it is what fills in each section's displayName.
  // Requesting a translation moves an already-processed document to
  // PROCESSING_TRANSLATIONS, so every Key Insights header rendered blank for
  // the entire minutes-long wait -- a row of empty accordions above the
  // English summary the parent was meant to keep reading.
  test("Key Insights headers are still named during PROCESSING_TRANSLATIONS", async () => {
    renderPage();
    await settle();
    // Exactly the reported journey: ask for a translation, which flips the
    // already-processed document to PROCESSING_TRANSLATIONS while the parent
    // stays on the page reading the English summary.
    documentPayload = englishOnlyDocument({ status: "PROCESSING_TRANSLATIONS" });
    await clickTranslate();
    await settle();

    const sections = screen.getAllByTestId("summary-section");
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      // The accordion header must carry its localized name, not be empty.
      expect(section.textContent?.trim()).not.toBe("");
    }
    expect(screen.getByText("Goals")).toBeInTheDocument();
  });

  test("a still-processing document has no sections to name", async () => {
    // The guard must still hold where it was right: mid-pipeline the section
    // content is half-written, so normalizing it would show a parent partial
    // data. Only the already-processed states are safe.
    documentPayload = englishOnlyDocument({ status: "PROCESSING" });
    renderPage();
    await settle();

    expect(screen.queryAllByTestId("summary-section")).toHaveLength(0);
  });
});
