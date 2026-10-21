/**
 * Signing out forgets where the parent was.
 *
 * ProtectedRoute hands the sign-in card the page a signed-out visitor asked
 * for (`state.from`), so a parent who taps a link to the summary while signed
 * out is taken there once they sign in. The same redirect also fires the
 * moment a session ends on a protected page, because the guard re-renders as
 * soon as logout() flips `authenticated`. Without a distinction, Sign Out on
 * the account center (or deleting the account) left `from` pointing at that
 * screen, and the NEXT account to sign in on the device was taken to it: the
 * previous parent's place in the app, on a shared or family computer.
 *
 * These drive the real AuthProvider and ProtectedRoute; only Amplify is mocked.
 */
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { ProtectedRoute } from "./ProtectedRoute";
import { AuthProvider, useAuth } from "../common/auth-provider";
import { AppContext } from "../common/app-context";
import { LanguageContext } from "../common/language-context";
import { SIGN_IN_ROUTE } from "../common/sign-in-location";
import type { SupportedLanguage } from "../common/languages";

const Auth = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  fetchAuthSession: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("aws-amplify/auth", () => Auth);

// The guard renders the in-app chrome around its outlet; the bar is not what
// is under test, so stand a plain outlet in for it.
vi.mock("./RouteChrome", async () => {
  const { Outlet } = await import("react-router-dom");
  return { InAppChrome: () => <Outlet /> };
});

const ACCOUNT_PATH = "/account-center";

const languageValue = {
  language: "en" as SupportedLanguage,
  setLanguage: vi.fn(),
  t: (key: string) => key,
  translationsLoaded: true,
  enabledLanguages: ["en"] as SupportedLanguage[],
};

/** Where the router is and what `from` it carries, as readable DOM. */
const LocationProbe = () => {
  const location = useLocation();
  return (
    <>
      <div data-testid="landed-on">{location.pathname + location.hash}</div>
      <div data-testid="from">
        {(location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? "none"}
      </div>
    </>
  );
};

/**
 * The ways a session ends on a protected page. Sign Out and Delete Account
 * call logout() and then go home; the delete modal calls logout() and leaves
 * the redirect to the guard. On staging the first kind still landed on
 * `/#sign-in` carrying `from`: the guard's <Navigate> runs from the render
 * that saw the session end, after the page's own navigate('/').
 */
const SessionEnder = ({ label, goHome }: { label: string; goHome: boolean }) => {
  const { logout } = useAuth();
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={async () => {
        await logout();
        if (goHome) navigate("/", { replace: true });
      }}
    >
      {label}
    </button>
  );
};

const renderApp = (initialEntry: string) =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AppContext.Provider value={{ httpEndpoint: "https://api.example.test/" } as never}>
        <LanguageContext.Provider value={languageValue}>
          <AuthProvider>
            <LocationProbe />
            <Routes>
              <Route path="/" element={<div>landing</div>} />
              <Route element={<ProtectedRoute />}>
                <Route path={ACCOUNT_PATH} element={<SessionEnder label="sign out" goHome />} />
                <Route path="/account-center/delete-account" element={<SessionEnder label="delete account" goHome />} />
                <Route path="/account-center/profile" element={<SessionEnder label="delete in modal" goHome={false} />} />
                <Route path="/summary-and-translations" element={<div>the summary page</div>} />
              </Route>
            </Routes>
          </AuthProvider>
        </LanguageContext.Provider>
      </AppContext.Provider>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  Auth.fetchAuthSession.mockResolvedValue({ tokens: undefined });
  Auth.signOut.mockResolvedValue(undefined);
});

describe("ending a session on a protected page", () => {
  test.each([
    ["signing out", ACCOUNT_PATH, "sign out"],
    ["deleting the account", "/account-center/delete-account", "delete account"],
    ["deleting from the profile modal", "/account-center/profile", "delete in modal"],
  ])("%s leaves no page for the next sign-in to return to", async (_label, path, button) => {
    Auth.getCurrentUser.mockResolvedValue({ username: "parent-1" });
    renderApp(path);
    await userEvent.click(await screen.findByRole("button", { name: button }));

    await waitFor(() => expect(screen.getByTestId("landed-on").textContent).not.toBe(path));
    expect(screen.getByTestId("from").textContent).toBe("none");
  });

  test("a signed-out visitor's link is still remembered for after sign-in", async () => {
    // The other half: the deliberate sign-out must not cost a parent the
    // journey back to a page they opened from a link.
    Auth.getCurrentUser.mockRejectedValue(new Error("not signed in"));
    renderApp("/summary-and-translations");

    await waitFor(() => expect(screen.getByTestId("landed-on").textContent).toBe(SIGN_IN_ROUTE));
    expect(screen.getByTestId("from").textContent).toBe("/summary-and-translations");
  });

});
