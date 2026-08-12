/**
 * Regression tests for the two onboarding "Back" buttons.
 *
 * Both used to call `navigate('/')`. Nothing signed the parent out, but '/' is
 * the logged-out marketing landing page and the only entry it offers is the
 * login form, so a signed-in parent who pressed Back was shown a sign-in
 * screen with no route back into the app. That is what was reported as "the
 * back button logs you out", and it is a dead end either way.
 *
 * These drive the real components through the DOM with the real router and the
 * real AuthProvider, mocking only the boundary (Amplify's `Auth` and `fetch`),
 * and assert three things per button: where the parent lands, that the session
 * survives, and the thing that must NOT happen — no sign-out, and no landing
 * on '/' or '/login'.
 */
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import ConsentForm from "./ConsentForm";
import OnboardingUser from "./OnboardingUser";
import { AppContext } from "../../common/app-context";
import { LanguageContext } from "../../common/language-context";
import { AuthProvider, useAuth } from "../../common/auth-provider";
import type { AppConfig } from "../../common/types";
import type { SupportedLanguage } from "../../common/languages";

const Auth = vi.hoisted(() => ({
  currentAuthenticatedUser: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("aws-amplify", () => ({ Auth }));

const API_BASE = "https://api.example.test/api";

const appConfig = {
  httpEndpoint: `${API_BASE}/`,
  enabledFeatures: [],
  enabledLanguages: ["en"],
} as unknown as AppConfig;

/** A parent part-way through onboarding: language chosen, consent not yet given. */
const ONBOARDING_PROFILE = {
  userId: "parent-1",
  secondaryLanguage: "en",
  consentGiven: false,
  showOnboarding: true,
  children: [],
};

/** Reports the session state, mounted outside <Routes> so it survives navigation. */
const AuthStateProbe = () => {
  const { authenticated } = useAuth();
  return <div data-testid="auth-state">{authenticated ? "signed-in" : "anonymous"}</div>;
};

const Here = () => {
  const { pathname } = useLocation();
  return <div data-testid="landed-on">{pathname}</div>;
};

/**
 * Mounts `page` at `path` alongside stubs for every route a back button could
 * plausibly reach, so a wrong destination shows up as a wrong `landed-on`
 * rather than as a blank screen.
 */
const renderPage = (path: string, page: React.ReactElement) => {
  // t() is the identity so assertions read translation KEYS: the English
  // wording is not the contract here, the destination is.
  const languageValue = {
    language: "en" as SupportedLanguage,
    setLanguage: vi.fn(),
    t: (key: string) => key,
    translationsLoaded: true,
    enabledLanguages: ["en"] as SupportedLanguage[],
  };

  render(
    <MemoryRouter initialEntries={[path]}>
      <AppContext.Provider value={appConfig}>
        <LanguageContext.Provider value={languageValue}>
          <AuthProvider>
              <AuthStateProbe />
              <Here />
              <Routes>
                <Route path={path} element={page} />
                <Route path="/preferred-language" element={<div>language step</div>} />
                <Route path="/consent-form" element={<div>consent step</div>} />
                <Route path="/iep-documents" element={<div>iep documents</div>} />
                <Route path="/summary-and-translations" element={<div>summary</div>} />
                {/* The two destinations that are the defect */}
                <Route path="/" element={<div>public landing page</div>} />
                <Route path="/login" element={<div>sign in form</div>} />
              </Routes>
          </AuthProvider>
        </LanguageContext.Provider>
      </AppContext.Provider>
    </MemoryRouter>,
  );

  return userEvent.setup();
};

/** The session survived and nothing signed the parent out on the way. */
const expectStillSignedIn = () => {
  expect(screen.getByTestId("auth-state")).toHaveTextContent("signed-in");
  expect(Auth.signOut).not.toHaveBeenCalled();
  expect(screen.queryByText("public landing page")).toBeNull();
  expect(screen.queryByText("sign in form")).toBeNull();
};

beforeEach(() => {
  Auth.currentAuthenticatedUser.mockResolvedValue({
    signInUserSession: { idToken: { jwtToken: "id-token" } },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ profile: ONBOARDING_PROFILE }),
    })),
  );
});

describe("the consent form's Back button", () => {
  test("returns to the previous onboarding step and keeps the parent signed in", async () => {
    const user = renderPage("/consent-form", <ConsentForm />);

    await screen.findByText("consent.title");
    await waitFor(() => expect(screen.getByTestId("auth-state")).toHaveTextContent("signed-in"));

    await user.click(screen.getByRole("button", { name: "common.back" }));

    expect(screen.getByTestId("landed-on")).toHaveTextContent("/preferred-language");
    expectStillSignedIn();
  });
});

describe("the onboarding carousel's Back button", () => {
  test("returns to the previous onboarding step and keeps the parent signed in", async () => {
    const user = renderPage("/onboarding-user", <OnboardingUser />);

    await waitFor(() => expect(screen.getByTestId("auth-state")).toHaveTextContent("signed-in"));

    await user.click(screen.getByRole("button", { name: "common.back" }));

    expect(screen.getByTestId("landed-on")).toHaveTextContent("/preferred-language");
    expectStillSignedIn();
  });

  test("Skip still goes forward into the flow, not out of the app", async () => {
    const user = renderPage("/onboarding-user", <OnboardingUser />);

    await user.click(screen.getByRole("button", { name: "common.skip" }));

    expect(screen.getByTestId("landed-on")).toHaveTextContent("/consent-form");
    expectStillSignedIn();
  });
});
