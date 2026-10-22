/**
 * The Support page's "Show me around" button: offered only to a parent who has
 * a finished summary for the tour to point at, and what it sends the summary
 * page when pressed.
 *
 * Only the network boundary is mocked (`fetch`, plus Amplify's `Auth`).
 */
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SupportCenter from "./SupportCenter";
import { REPLAY_TOUR_STATE_KEY } from "../iep-folder/summary-tour";
import { AppContext } from "../../common/app-context";
import { LanguageContext } from "../../common/language-context";
import type { AppConfig } from "../../common/types";
import type { SupportedLanguage } from "../../common/languages";

const Auth = vi.hoisted(() => ({ getCurrentUser: vi.fn(), fetchAuthSession: vi.fn() }));
vi.mock("aws-amplify/auth", () => Auth);

const API_BASE = "https://api.example.test/api";
const CHILD_ID = "child-abc";
const DOCUMENTS_URL = `${API_BASE}/profile/children/${CHILD_ID}/documents`;
const BUTTON = "supportCenter.showMeAround";

const appConfig = { httpEndpoint: `${API_BASE}/` } as unknown as AppConfig;

let documentAnswer: { ok: boolean; body: unknown };

beforeEach(() => {
  Auth.getCurrentUser.mockResolvedValue({ username: "u", userId: "u" });
  Auth.fetchAuthSession.mockResolvedValue({
    tokens: { idToken: { toString: () => "id-token", payload: {} } },
  });
  documentAnswer = {
    ok: true,
    body: { status: "PROCESSED", summaries: { en: "A summary." }, sections: { en: [] } },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === `${API_BASE}/profile`) {
        return { ok: true, status: 200, json: async () => ({ profile: { children: [{ childId: CHILD_ID }] } }) };
      }
      if (url === DOCUMENTS_URL) {
        return { ok: documentAnswer.ok, status: documentAnswer.ok ? 200 : 500, json: async () => documentAnswer.body };
      }
      throw new Error(`unexpected fetch to ${url}`);
    }),
  );
});

const SummaryProbe = () => (
  <output data-testid="summary-route">{JSON.stringify(useLocation().state)}</output>
);

const renderSupport = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/support-center"]}>
        <AppContext.Provider value={appConfig}>
          <LanguageContext.Provider
            value={{
              language: "en",
              setLanguage: vi.fn(),
              t: (key: string) => key,
              translationsLoaded: true,
              enabledLanguages: ["en"] as SupportedLanguage[],
            }}
          >
            <Routes>
              <Route path="/support-center" element={<SupportCenter />} />
              <Route path="/summary-and-translations" element={<SummaryProbe />} />
            </Routes>
          </LanguageContext.Provider>
        </AppContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

const documentsRead = () =>
  waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url === DOCUMENTS_URL)).toBe(true));

describe("Show me around", () => {
  test("is offered to a parent with a finished summary, and replays the tour on the summary page", async () => {
    renderSupport();

    await userEvent.click(await screen.findByRole("button", { name: BUTTON }));

    expect(await screen.findByTestId("summary-route")).toHaveTextContent(
      JSON.stringify({ [REPLAY_TOUR_STATE_KEY]: true }),
    );
  });

  test.each([
    ["no document", { ok: true, body: {} }],
    ["a document still processing", { ok: true, body: { status: "PROCESSING", summaries: { en: "x" } } }],
    ["a failed document", { ok: true, body: { status: "FAILED" } }],
    ["a finished document with nothing in it", { ok: true, body: { status: "PROCESSED", summaries: { en: "" }, sections: { en: [] } } }],
    ["the documents read failing", { ok: false, body: {} }],
  ])("is not offered with %s", async (_name, answer) => {
    documentAnswer = answer;
    renderSupport();
    await documentsRead();
    await screen.findByText("supportCenter.title");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.queryByRole("button", { name: BUTTON })).not.toBeInTheDocument();
  });
});
