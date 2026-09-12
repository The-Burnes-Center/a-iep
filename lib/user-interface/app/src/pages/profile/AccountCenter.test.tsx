/**
 * The Sign Out button a parent actually taps.
 *
 * AuthProvider.logout knows how to end a passwordless session; this row did
 * not go through it. It called Amplify's signOut() directly, which leaves the
 * durable session handle in localStorage, and checkAuth exchanges that handle
 * BEFORE it ever asks Amplify — so the parent tapped Sign Out, the app looked
 * signed out, and the next page load handed the account back. On a shared or
 * family computer that is the next person reading a child's IEP.
 *
 * So the assertion that matters here is not "signOut was called" — the broken
 * version did that — it is that a fresh mount afterwards lands on /login.
 * These drive the real AccountCenter, the real AuthProvider and the real
 * ProtectedRoute through the DOM, mocking only the boundary (Amplify, fetch).
 */
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AccountCenter from "./AccountCenter";
import { AuthProvider } from "../../common/auth-provider";
import { ProtectedRoute } from "../../components/ProtectedRoute";
import { AppContext } from "../../common/app-context";
import { LanguageContext } from "../../common/language-context";
import {
  clearCachedTokens,
  getCachedIdToken,
  persistSessionHandle,
  readPersistedSessionHandle,
} from "../../common/auth/passwordless-auth";
import type { AppConfig } from "../../common/types";
import type { SupportedLanguage } from "../../common/languages";

const Auth = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  fetchAuthSession: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("aws-amplify/auth", () => Auth);

const HTTP_ENDPOINT = "https://api.example.test/";
const ACCOUNT_PATH = "/account-center";
const SIGN_OUT_ROW = "account-center-log-out";

const renderAccountCenter = () => {
  const appConfig = {
    httpEndpoint: HTTP_ENDPOINT,
    enabledFeatures: ["passwordlessAuth"],
  } as unknown as AppConfig;
  // t() is the identity, so the assertions below never depend on the English
  // wording of a row a parent reads in their own language.
  const languageValue = {
    language: "en" as SupportedLanguage,
    setLanguage: vi.fn(),
    t: (key: string) => key,
    translationsLoaded: true,
    enabledLanguages: ["en"] as SupportedLanguage[],
  };

  return render(
    <MemoryRouter initialEntries={[ACCOUNT_PATH]}>
      <AppContext.Provider value={appConfig}>
        <LanguageContext.Provider value={languageValue}>
          <AuthProvider>
            <Routes>
              <Route path="/" element={<div>public landing page</div>} />
              <Route path="/login" element={<div>sign in form</div>} />
              <Route element={<ProtectedRoute />}>
                <Route path={ACCOUNT_PATH} element={<AccountCenter />} />
              </Route>
            </Routes>
          </AuthProvider>
        </LanguageContext.Provider>
      </AppContext.Provider>
    </MemoryRouter>,
  );
};

/** Answers /auth/token and /auth/logout, and records both. */
const stubAuthEndpoints = () => {
  const calls: { path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { body?: string }) => {
      const path = String(url);
      calls.push({ path, body: init?.body ? JSON.parse(init.body) : null });
      if (path.includes("auth/logout")) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, accessToken: "access-1", idToken: "id-1", expiresIn: 3600 }),
      };
    }),
  );
  return {
    tokenCalls: () => calls.filter((c) => c.path.includes("auth/token")),
    logoutCalls: () => calls.filter((c) => c.path.includes("auth/logout")),
  };
};

/** Signs a parent in through the passwordless route and taps the Sign Out row. */
const signInThenTapSignOut = async () => {
  persistSessionHandle("sess-valid");
  // A passwordless parent has no Amplify session at all: the real Cognito
  // tokens live server-side against the handle. This is what makes signOut()
  // alone a no-op for them.
  Auth.getCurrentUser.mockRejectedValue(new Error("no amplify session"));
  Auth.fetchAuthSession.mockRejectedValue(new Error("no amplify session"));
  const endpoints = stubAuthEndpoints();

  const { unmount } = renderAccountCenter();
  const row = await screen.findByTestId(SIGN_OUT_ROW);
  await userEvent.click(within(row).getByRole("button"));

  return { unmount, ...endpoints };
};

beforeEach(() => {
  localStorage.clear();
  clearCachedTokens();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the Sign Out row in Account Center", () => {
  test("does not let the next page load sign the parent back in", async () => {
    const { unmount, tokenCalls } = await signInThenTapSignOut();

    // Signed out here first: the parent is off the account screen.
    expect(await screen.findByText("public landing page")).toBeInTheDocument();
    expect(tokenCalls()).toHaveLength(1); // the sign-in resume, and only that

    // The page load. A brand new AuthProvider against the same localStorage,
    // asking for the protected route again.
    unmount();
    renderAccountCenter();

    expect(await screen.findByText("sign in form")).toBeInTheDocument();
    expect(screen.queryByTestId(SIGN_OUT_ROW)).not.toBeInTheDocument();
    // Nothing was left to exchange, so the resume never reached the network.
    expect(tokenCalls()).toHaveLength(1);
  });

  test("clears the persisted handle and the cached tokens, and revokes the session", async () => {
    const { logoutCalls } = await signInThenTapSignOut();

    await waitFor(() => expect(readPersistedSessionHandle()).toBeNull());
    expect(getCachedIdToken()).toBeNull();
    expect(logoutCalls()).toHaveLength(1);
    expect(logoutCalls()[0].body).toEqual({ session: "sess-valid" });
    // The Amplify sign-out still happens for a parent who got in the old way.
    expect(Auth.signOut).toHaveBeenCalled();
  });

  test("still signs the parent out on this device when the network is down", async () => {
    // A parent on a dead connection taps Sign Out. The revoke cannot happen
    // and the row's TTL has to do it later, but this browser must not be able
    // to resume either way.
    persistSessionHandle("sess-valid");
    Auth.getCurrentUser.mockRejectedValue(new Error("no amplify session"));
    Auth.fetchAuthSession.mockRejectedValue(new Error("no amplify session"));
    let exchanged = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        if (String(url).includes("auth/logout")) throw new Error("network down");
        exchanged = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, accessToken: "access-1", idToken: "id-1", expiresIn: 3600 }),
        };
      }),
    );

    const { unmount } = renderAccountCenter();
    const row = await screen.findByTestId(SIGN_OUT_ROW);
    await userEvent.click(within(row).getByRole("button"));

    expect(await screen.findByText("public landing page")).toBeInTheDocument();
    await waitFor(() => expect(readPersistedSessionHandle()).toBeNull());
    expect(getCachedIdToken()).toBeNull();

    exchanged = false;
    unmount();
    renderAccountCenter();
    expect(await screen.findByText("sign in form")).toBeInTheDocument();
    expect(exchanged).toBe(false);
  });
});
