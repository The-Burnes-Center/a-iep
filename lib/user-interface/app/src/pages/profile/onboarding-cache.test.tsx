/**
 * The summary page and the language screen once bounced a parent between
 * them several times a second (staging, 2026-11-10: 695 profile reads in a
 * minute, a flickering spinner). The summary page reads the shared ['profile']
 * cache; the language screen reads the server. A cache still holding the
 * profile from mid-onboarding (showOnboarding: true) sent the summary to the
 * language screen, which read the real profile (onboarding done) and sent the
 * parent back, forever.
 *
 * This seeds exactly that cache and asserts the parent ends on the summary
 * after a handful of reads, not a loop.
 */
import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppContext } from "../../common/app-context";
import { LanguageContext } from "../../common/language-context";
import type { AppConfig } from "../../common/types";
import type { SupportedLanguage } from "../../common/languages";
import { PROFILE_QUERY_KEY } from "../../common/hooks/use-language-preference";
import SummaryAndTranslationsPage from "../iep-folder/SummaryAndTranslationsPage";
import PreferredLanguage from "./PreferredLanguage";

const Auth = vi.hoisted(() => ({ getCurrentUser: vi.fn(), fetchAuthSession: vi.fn() }));
vi.mock("aws-amplify/auth", () => Auth);

const API = "https://api.example.test/api";
const CHILD = { childId: "c-1", name: "Maya", schoolCity: "Lakeview" };
const DONE = { userId: "u", secondaryLanguage: "en", consentGiven: true, showOnboarding: false, summaryTourSeen: true, children: [CHILD] };
let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const profileReads = () => fetchMock.mock.calls.filter(([u]) => String(u) === `${API}/profile`).length;

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

beforeEach(() => {
  vi.useFakeTimers();
  Auth.getCurrentUser.mockResolvedValue({ username: "u", userId: "u" });
  Auth.fetchAuthSession.mockResolvedValue({ tokens: { idToken: { toString: () => "tok", payload: {} } } });
  fetchMock = vi.fn(async (url: string) => {
    if (url === `${API}/profile`) return json({ profile: DONE });
    if (/\/documents$/.test(url)) {
      return json({ documentId: "d-1", status: "PROCESSED", summaries: { en: "Summary." }, sections: { en: [] }, document_index: { en: "" }, abbreviations: { en: [] } });
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
});

test("a cache left from mid-onboarding cannot bounce the parent between the summary and the language screen", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000 } } });
  // What the cache held after onboarding: fresh, and wrong.
  client.setQueryData(PROFILE_QUERY_KEY, { ...DONE, showOnboarding: true });
  // The summary page checks the real address bar before it redirects.
  window.history.replaceState(null, "", "/summary-and-translations");
  const appConfig = { httpEndpoint: `${API}/`, enabledFeatures: [], enabledLanguages: ["en"] } as unknown as AppConfig;

  render(
    <QueryClientProvider client={client}>
      <BrowserRouter>
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
            <Routes>
              <Route path="/summary-and-translations" element={<SummaryAndTranslationsPage />} />
              <Route path="/preferred-language" element={<PreferredLanguage />} />
            </Routes>
            <Where />
          </LanguageContext.Provider>
        </AppContext.Provider>
      </BrowserRouter>
    </QueryClientProvider>,
  );

  await act(async () => {
    for (let i = 0; i < 300; i++) await vi.advanceTimersByTimeAsync(10);
  });

  expect(screen.getByTestId("where").textContent).toBe("/summary-and-translations");
  expect(profileReads(), "the two screens are still bouncing the parent between them").toBeLessThan(10);
});
