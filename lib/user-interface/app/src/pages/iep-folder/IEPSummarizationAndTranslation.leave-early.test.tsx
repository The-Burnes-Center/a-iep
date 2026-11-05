/**
 * Leaving the summary before its first load finishes must not drag the parent
 * back to the upload page.
 *
 * The page used to call navigate('/iep-documents') during render whenever the
 * document fetch answered "No document found", and so again on EVERY later
 * render. React Router runs a tab tap as a transition, so while that tap was
 * still pending the old page kept re-rendering (profile refetches land then)
 * and each render re-issued the redirect, overriding the tap. The staging
 * nightly caught it on 2026-11-05: the referral journey tapped Account right
 * after sign-in, reached /account-center, and was then pushed to
 * /iep-documents for an account with no IEP.
 *
 * `navigate` is a spy so the page stays mounted and every redirect it issues
 * can be counted. The browser URL is set with history.replaceState, which is
 * what BrowserRouter does synchronously on a tap, before React commits.
 * Only the network boundary is otherwise mocked, as in *.failure.test.tsx.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import IEPSummarizationAndTranslation from "./IEPSummarizationAndTranslation";
import { AppContext } from "../../common/app-context";
import { LanguageContext } from "../../common/language-context";
import type { AppConfig } from "../../common/types";
import type { SupportedLanguage } from "../../common/languages";

const Auth = vi.hoisted(() => ({ getCurrentUser: vi.fn(), fetchAuthSession: vi.fn() }));
vi.mock("aws-amplify/auth", () => Auth);

const navigateSpy = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigateSpy,
}));

const API_BASE = "https://api.example.test/api";
const CHILD_ID = "child-abc";
const DOCUMENTS_URL = `${API_BASE}/profile/children/${CHILD_ID}/documents`;
const NO_DOCUMENT = { message: "No document found for this child" };
const SUMMARY_PATH = "/summary-and-translations";
const UPLOAD_PATH = "/iep-documents";

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

const finishedProfile = () => ({
  userId: "user-1",
  secondaryLanguage: "en",
  showOnboarding: false,
  summaryTourSeen: true,
  children: [{ childId: CHILD_ID, name: "Child" }],
});

/** Holds the documents response until the test releases it. */
let releaseDocuments: (() => void) | null;

const tree = () => (
  <QueryClientProvider client={queryClient}>
    <MemoryRouter initialEntries={[SUMMARY_PATH]}>
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
          <IEPSummarizationAndTranslation />
        </LanguageContext.Provider>
      </AppContext.Provider>
    </MemoryRouter>
  </QueryClientProvider>
);
let queryClient: QueryClient;

const settle = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
  });
};

const uploadRedirects = () => navigateSpy.mock.calls.filter(([to]) => to === UPLOAD_PATH).length;

/** Render, and wait until the documents request is in flight. */
const renderWaitingForDocuments = async () => {
  const view = render(tree());
  await settle();
  expect(releaseDocuments).not.toBeNull();
  return view;
};

beforeEach(() => {
  vi.useFakeTimers();
  navigateSpy.mockReset();
  releaseDocuments = null;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  window.history.replaceState(null, "", SUMMARY_PATH);
  Auth.getCurrentUser.mockResolvedValue({ username: "test-user", userId: "test-user" });
  Auth.fetchAuthSession.mockResolvedValue({
    tokens: { idToken: { toString: () => "id-token", payload: {} } },
  });

  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === `${API_BASE}/profile`) return jsonResponse(200, { profile: finishedProfile() });
    if (url === DOCUMENTS_URL) {
      await new Promise<void>((resolve) => { releaseDocuments = resolve; });
      return jsonResponse(200, NO_DOCUMENT);
    }
    throw new Error(`unexpected fetch to ${url}`);
  }));
});

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

describe("the no-document redirect", () => {
  test("a parent with no IEP who stays on the summary is sent to the upload page", async () => {
    await renderWaitingForDocuments();

    await act(async () => { releaseDocuments?.(); });
    await settle();

    expect(uploadRedirects()).toBe(1);
  });

  test("is issued once, not again on every later render", async () => {
    const view = await renderWaitingForDocuments();
    await act(async () => { releaseDocuments?.(); });
    await settle();

    // The parent taps a tab; the page re-renders while that change is pending.
    window.history.replaceState(null, "", "/account-center");
    for (let i = 0; i < 3; i++) {
      view.rerender(tree());
      await settle();
    }

    expect(uploadRedirects()).toBe(1);
  });

  test("never overrides a tab the parent tapped before the answer arrived", async () => {
    await renderWaitingForDocuments();

    window.history.replaceState(null, "", "/account-center");
    await act(async () => { releaseDocuments?.(); });
    await settle();

    expect(uploadRedirects()).toBe(0);
  });
});
