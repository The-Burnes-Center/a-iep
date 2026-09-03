/**
 * Regression tests for the public header's one entry into the app.
 *
 * This header is all the navigation the public pages have, and its "Upload An
 * IEP" item pointed unconditionally at the login form. A signed-in parent who
 * reached '/' — browser back, a bookmark, or one of the in-app redirects that
 * still send onboarding-incomplete profiles there — was therefore offered a
 * sign-in screen as the only way forward, which is what "the back button logs
 * you out" looked like from the parent's side.
 *
 * The real AuthProvider runs here, so the header's answer is driven by the
 * same session check the rest of the app uses; only Amplify's `Auth` is mocked.
 */
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import LandingTopNavigation from "./LandingTopNavigation";
import { LanguageContext } from "../common/language-context";
import { AuthProvider, useAuth } from "../common/auth-provider";
import type { SupportedLanguage } from "../common/languages";

const Auth = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  fetchAuthSession: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("aws-amplify/auth", () => Auth);

const Here = () => {
  const { pathname } = useLocation();
  const { authenticated } = useAuth();
  return (
    <>
      <div data-testid="landed-on">{pathname}</div>
      <div data-testid="auth-state">{authenticated ? "signed-in" : "anonymous"}</div>
    </>
  );
};

const renderHeader = () => {
  const languageValue = {
    language: "en" as SupportedLanguage,
    setLanguage: vi.fn(),
    // Identity t(): the item is identified by its translation key, and the
    // English label is the same signed in or out — only the target changes.
    t: (key: string) => key,
    translationsLoaded: true,
    enabledLanguages: ["en"] as SupportedLanguage[],
  };

  render(
    <MemoryRouter initialEntries={["/"]}>
      <LanguageContext.Provider value={languageValue}>
        <AuthProvider>
          <Here />
          <LandingTopNavigation />
          <Routes>
            <Route path="/" element={<div>public landing page</div>} />
            <Route path="/login" element={<div>sign in form</div>} />
            <Route path="/iep-documents" element={<div>iep documents</div>} />
          </Routes>
        </AuthProvider>
      </LanguageContext.Provider>
    </MemoryRouter>,
  );

  return userEvent.setup();
};

const clickUploadItem = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Navigate to navigation.uploadIEP" }));

const waitForAuthState = async (state: "signed-in" | "anonymous") =>
  waitFor(() => expect(screen.getByTestId("auth-state")).toHaveTextContent(state));

describe("a signed-in parent who lands on the public site", () => {
  beforeEach(() => {
    Auth.getCurrentUser.mockResolvedValue({ username: "test-user", userId: "test-user" });
  Auth.fetchAuthSession.mockResolvedValue({
    tokens: { idToken: { toString: () => "id-token", payload: {} } },
  });
  });

  test("gets back into the app instead of a sign-in form", async () => {
    const user = renderHeader();
    await waitForAuthState("signed-in");

    await clickUploadItem(user);

    expect(screen.getByTestId("landed-on")).toHaveTextContent("/iep-documents");
    expect(screen.queryByText("sign in form")).toBeNull();
    expect(Auth.signOut).not.toHaveBeenCalled();
    expect(screen.getByTestId("auth-state")).toHaveTextContent("signed-in");
  });
});

describe("a visitor with no session", () => {
  beforeEach(() => {
    Auth.getCurrentUser.mockRejectedValue(new Error("not authenticated"));
  });

  test("still gets the sign-in form, which is the only thing they can do", async () => {
    const user = renderHeader();
    await waitForAuthState("anonymous");

    await clickUploadItem(user);

    expect(screen.getByTestId("landed-on")).toHaveTextContent("/login");
    expect(screen.getByText("sign in form")).toBeInTheDocument();
  });
});
