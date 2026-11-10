/**
 * My children showed "Reading the IEP" for a child whose summary had been
 * ready for minutes (staging, 2026-11-10). It read each child's status from
 * the five-minute query cache, filled earlier by the survey while the IEP was
 * still being read, and never asked again while the parent sat on the page.
 * The summary page reads the server, so it showed the summary.
 *
 * The server owns the state of server work: the screen has to read it on
 * arrival, and keep reading while an IEP is still being read.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppContext } from "../../common/app-context";
import { LanguageContext } from "../../common/language-context";
import type { AppConfig } from "../../common/types";
import type { SupportedLanguage } from "../../common/languages";
import { PROFILE_QUERY_KEY } from "../../common/hooks/use-language-preference";
import MyChildren from "./MyChildren";

const Auth = vi.hoisted(() => ({ getCurrentUser: vi.fn(), fetchAuthSession: vi.fn() }));
vi.mock("aws-amplify/auth", () => Auth);

const API = "https://api.example.test/api";
const KIDS = [
  { childId: "c-1", name: "Maya", schoolCity: "x" },
  { childId: "c-2", name: "Leo", schoolCity: "x" },
];
const PROFILE = { userId: "u", consentGiven: true, showOnboarding: false, children: KIDS };
const READING = { documentId: "d", status: "PROCESSING" };
const READY = { documentId: "d", status: "PROCESSED", summaries: { en: "s" } };
let serverStatus: Record<string, unknown>;

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const renderWith = (client: QueryClient) => {
  const appConfig = { httpEndpoint: `${API}/`, enabledFeatures: ["multiChild"], enabledLanguages: ["en"] } as unknown as AppConfig;
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/account-center/children"]}>
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
            <MyChildren />
          </LanguageContext.Provider>
        </AppContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const advance = async (ms: number) => {
  await act(async () => {
    for (let elapsed = 0; elapsed < ms; elapsed += 50) await vi.advanceTimersByTimeAsync(50);
  });
};
const statusOf = (name: string) =>
  screen.getAllByTestId("my-children-card").find((card) => card.textContent?.includes(name))?.textContent ?? "";

beforeEach(() => {
  vi.useFakeTimers();
  Auth.getCurrentUser.mockResolvedValue({ username: "u", userId: "u" });
  Auth.fetchAuthSession.mockResolvedValue({ tokens: { idToken: { toString: () => "tok", payload: {} } } });
  serverStatus = { "c-1": READY, "c-2": READING };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === `${API}/profile`) return json({ profile: PROFILE });
    const docs = /\/profile\/children\/([^/]+)\/documents$/.exec(url);
    if (docs) return json(serverStatus[docs[1]]);
    return json({});
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("My children reads each IEP's state from the server", () => {
  test("on arrival, not from a cache another screen filled while it was being read", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000 } } });
    client.setQueryData(PROFILE_QUERY_KEY, PROFILE);
    client.setQueryData(["child-document", "c-2"], READING); // fresh, and wrong
    serverStatus["c-2"] = READY;

    renderWith(client);
    await advance(500);
    expect(statusOf("Leo")).toContain("myChildren.status.ready");
  });

  test("and again while an IEP is still being read, so it turns ready without a reload", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000 } } });
    client.setQueryData(PROFILE_QUERY_KEY, PROFILE);
    renderWith(client);
    await advance(500);
    expect(statusOf("Leo")).toContain("myChildren.status.reading");

    serverStatus["c-2"] = READY;
    await advance(11_000);
    expect(statusOf("Leo")).toContain("myChildren.status.ready");
  });
});
