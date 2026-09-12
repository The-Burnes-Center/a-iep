/**
 * The language picker, rebuilt to the designer's screen: one line of copy and
 * one full-width pill per language, each written in the language it offers.
 *
 * The thing worth a test here is that the list comes from the environment's
 * enabled-language config rather than from four hard-coded buttons. Arabic
 * ships everywhere and is enabled outside production, so a hard-coded list
 * would silently drop it where it is on, and nothing else in the app would
 * notice.
 *
 * Second: the selected language used to be marked by its fill and nothing
 * else. WCAG 1.4.1 wants a second signal, so the state is also announced
 * (aria-pressed) and carries a tick.
 *
 * The real component is driven through the DOM with the real router, mocking
 * only the boundary (Amplify's `Auth` and `fetch`). t() is the identity, so
 * the only English here is the language names, which are the same string in
 * every dictionary by design (LANGUAGES in common/languages.ts).
 */
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import PreferredLanguage from "./PreferredLanguage";
import { AppContext } from "../../common/app-context";
import { LanguageContext } from "../../common/language-context";
import { LANGUAGES } from "../../common/languages";
import type { AppConfig } from "../../common/types";
import type { SupportedLanguage } from "../../common/languages";

const Auth = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  fetchAuthSession: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("aws-amplify/auth", () => Auth);

const API_BASE = "https://api.example.test/api";
const PAGE = "/preferred-language";

/** Mid-onboarding: a language on file, consent not yet given, so the screen
 * stays put instead of redirecting onward. */
const ONBOARDING_PROFILE = {
  userId: "parent-1",
  secondaryLanguage: "es",
  consentGiven: false,
  showOnboarding: true,
  children: [],
};

const setLanguage = vi.fn();

const appConfig = (enabledLanguages: SupportedLanguage[]): AppConfig =>
  ({
    httpEndpoint: `${API_BASE}/`,
    enabledFeatures: [],
    enabledLanguages,
  }) as unknown as AppConfig;

let requests: { url: string; method: string; body: Record<string, unknown> | null }[] = [];

const stubFetch = (profile: Record<string, unknown>) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return { ok: true, status: 200, json: async () => ({ profile }) };
    }),
  );
};

const Here = () => <div data-testid="landed-on">{useLocation().pathname}</div>;

const renderPage = (
  {
    enabledLanguages = ["en", "es", "zh", "vi", "ar"] as SupportedLanguage[],
    profile = ONBOARDING_PROFILE as Record<string, unknown>,
  } = {},
) => {
  stubFetch(profile);
  render(
    <MemoryRouter initialEntries={[PAGE]}>
      <AppContext.Provider value={appConfig(enabledLanguages)}>
        <LanguageContext.Provider
          value={{
            language: "en" as SupportedLanguage,
            setLanguage,
            t: (key: string) => key,
            translationsLoaded: true,
            enabledLanguages,
          }}
        >
          <Here />
          <Routes>
            <Route path={PAGE} element={<PreferredLanguage />} />
            <Route path="/consent-form" element={<div>consent step</div>} />
            <Route path="/iep-documents" element={<div>iep documents</div>} />
            <Route path="/summary-and-translations" element={<div>summary</div>} />
          </Routes>
        </LanguageContext.Provider>
      </AppContext.Provider>
    </MemoryRouter>,
  );

  return userEvent.setup();
};

const optionFor = (code: SupportedLanguage) =>
  LANGUAGES.find((meta) => meta.value === code)!.translatedPreference;

/** The picker is on screen once the mount-time profile load has resolved. */
const waitForChoices = () => screen.findByRole("button", { name: optionFor("en") });

beforeEach(() => {
  requests = [];
  setLanguage.mockClear();
  Auth.getCurrentUser.mockResolvedValue({ username: "test-user", userId: "test-user" });
  Auth.fetchAuthSession.mockResolvedValue({
    tokens: { idToken: { toString: () => "id-token", payload: {} } },
  });
});

describe("the screen", () => {
  test("asks one question, with no heading above it", async () => {
    renderPage();
    await waitForChoices();

    expect(screen.getByText("preferredLanguage.lede")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).toBeNull();
  });

  test("renders one button per language, written in that language", async () => {
    renderPage();
    await waitForChoices();

    for (const meta of LANGUAGES) {
      expect(
        screen.getByRole("button", { name: meta.translatedPreference }),
      ).toBeInTheDocument();
    }
  });
});

describe("the enabled-language list", () => {
  test("offers Arabic where the environment enables it", async () => {
    // The design shows four languages. Arabic is enabled outside production,
    // so a hard-coded four would drop it exactly where it is meant to appear.
    renderPage({ enabledLanguages: ["en", "es", "zh", "vi", "ar"] });
    await waitForChoices();

    expect(
      screen.getByRole("button", { name: optionFor("ar") }),
    ).toBeInTheDocument();
  });

  test("offers only the languages the environment enables", async () => {
    renderPage({ enabledLanguages: ["en", "es", "ar"] });
    await waitForChoices();

    expect(screen.getByRole("button", { name: optionFor("es") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: optionFor("ar") })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: optionFor("zh") })).toBeNull();
    expect(screen.queryByRole("button", { name: optionFor("vi") })).toBeNull();
  });
});

describe("the selected language", () => {
  test("is marked by something other than its colour", async () => {
    // The fill is the only visual difference between chosen and not, and
    // WCAG 1.4.1 does not accept colour on its own. The state is announced,
    // and it carries a tick a parent can see.
    renderPage();
    await waitForChoices();

    const chosen = screen.getByRole("button", { name: optionFor("es") });
    expect(chosen).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("language-selected-es")).toBeInTheDocument();
  });

  test("leaves every other button marked as not chosen", async () => {
    renderPage();
    await waitForChoices();

    for (const meta of LANGUAGES.filter((l) => l.value !== "es")) {
      expect(
        screen.getByRole("button", { name: meta.translatedPreference }),
      ).toHaveAttribute("aria-pressed", "false");
      expect(screen.queryByTestId(`language-selected-${meta.value}`)).toBeNull();
    }
  });
});

describe("choosing a language", () => {
  test("saves it and goes on to consent", async () => {
    const user = renderPage();
    await waitForChoices();

    await user.click(screen.getByRole("button", { name: optionFor("vi") }));

    await waitFor(() =>
      expect(screen.getByTestId("landed-on")).toHaveTextContent("/consent-form"),
    );
    expect(setLanguage).toHaveBeenCalledWith("vi");
    const write = requests.find((r) => r.method === "PUT");
    expect(write?.body).toMatchObject({ secondaryLanguage: "vi", primaryLanguage: "en" });
  });
});
