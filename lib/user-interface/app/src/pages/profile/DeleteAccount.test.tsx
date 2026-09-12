/**
 * Deleting an account, and the order the session ends in.
 *
 * This page used to navigate to '/' and sign out behind the navigation. That
 * window is the one the repo has already been bitten by: a page load inside it
 * rehydrates a session for a user who no longer exists, and the parent can
 * never sign up again (see clearStaleSession in components/CustomLogin.tsx).
 * Under passwordlessAuth it also left the durable session handle in
 * localStorage, because Amplify's signOut() does not know about it. That
 * handle would 401 session_invalid and self-clear on next use, but relying on
 * that is relying on the server to undo something we should not have left.
 *
 * Real page, real AuthProvider, real router; only the boundary is mocked.
 */
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import DeleteAccount from "./DeleteAccount";
import { AppContext } from "../../common/app-context";
import { LanguageContext } from "../../common/language-context";
import { AuthProvider } from "../../common/auth-provider";
import { ProtectedRoute } from "../../components/ProtectedRoute";
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
const DELETE_PATH = "/account-center/delete-account";

const renderDeleteAccount = () => {
  const appConfig = {
    httpEndpoint: HTTP_ENDPOINT,
    enabledFeatures: ["passwordlessAuth"],
    enabledLanguages: ["en"],
  } as unknown as AppConfig;
  const languageValue = {
    language: "en" as SupportedLanguage,
    setLanguage: vi.fn(),
    t: (key: string) => key,
    translationsLoaded: true,
    enabledLanguages: ["en"] as SupportedLanguage[],
  };

  return render(
    <MemoryRouter initialEntries={[DELETE_PATH]}>
      <AppContext.Provider value={appConfig}>
        <LanguageContext.Provider value={languageValue}>
          <AuthProvider>
            <Routes>
              <Route path="/" element={<div>public landing page</div>} />
              <Route path="/login" element={<div>sign in form</div>} />
              <Route element={<ProtectedRoute />}>
                <Route path={DELETE_PATH} element={<DeleteAccount />} />
              </Route>
            </Routes>
          </AuthProvider>
        </LanguageContext.Provider>
      </AppContext.Provider>
    </MemoryRouter>,
  );
};

/**
 * Answers /auth/token, /auth/logout and the profile DELETE, and records the
 * order they were called in — ordering is the whole point of this file.
 */
const stubEndpoints = ({ deleteFails = false } = {}) => {
  const calls: { path: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = String(url);
      const method = init?.method ?? "GET";
      calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (path.includes("auth/logout")) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (path.includes("auth/token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, accessToken: "access-1", idToken: "id-1", expiresIn: 3600 }),
        };
      }
      if (deleteFails) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ message: "deleted" }) };
    }),
  );
  return {
    calls,
    find: (fragment: string) => calls.filter((c) => c.path.includes(fragment)),
  };
};

/** Signs a parent in passwordlessly, then presses Delete my account. */
const deleteTheAccount = async (opts: { deleteFails?: boolean } = {}) => {
  persistSessionHandle("sess-valid");
  Auth.getCurrentUser.mockRejectedValue(new Error("no amplify session"));
  const endpoints = stubEndpoints(opts);

  const view = renderDeleteAccount();
  const button = await screen.findByRole("button", { name: /deleteAccount\.button\.deleteMyAccount/ });
  await userEvent.click(button);
  return { ...view, ...endpoints };
};

beforeEach(() => {
  localStorage.clear();
  clearCachedTokens();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("deleting an account", () => {
  test("leaves nothing behind that a later page load could resume", async () => {
    const { unmount, find } = await deleteTheAccount();

    expect(await screen.findByText("public landing page")).toBeInTheDocument();
    expect(readPersistedSessionHandle()).toBeNull();
    expect(getCachedIdToken()).toBeNull();
    expect(Auth.signOut).toHaveBeenCalled();

    // The page load. Nothing to exchange, so /auth/token is not called a
    // second time and the parent lands on the sign-in form.
    unmount();
    renderDeleteAccount();
    expect(await screen.findByText("sign in form")).toBeInTheDocument();
    expect(find("auth/token")).toHaveLength(1);
  });

  test("ends the session before routing away, not behind the navigation", async () => {
    const { calls, find } = await deleteTheAccount();

    await waitFor(() => expect(find("auth/logout")).toHaveLength(1));
    const deleteAt = calls.findIndex((c) => c.method === "DELETE");
    const revokeAt = calls.findIndex((c) => c.path.includes("auth/logout"));
    expect(deleteAt).toBeGreaterThanOrEqual(0);
    // The revoke carries the handle that was actually held, and it happens
    // after the account is gone rather than racing the deletion.
    expect(revokeAt).toBeGreaterThan(deleteAt);
    expect(calls[revokeAt].body).toEqual({ session: "sess-valid" });
    // The handle was already gone by the time the parent reached '/'.
    expect(screen.getByText("public landing page")).toBeInTheDocument();
    expect(readPersistedSessionHandle()).toBeNull();
  });

  test("a failed deletion keeps the parent signed in, on the page, with the error", async () => {
    // The session must survive here: nothing was deleted, so signing them out
    // would strand a parent who still has an account and documents in it.
    await deleteTheAccount({ deleteFails: true });

    expect(await screen.findByText("delete.error.failed")).toBeInTheDocument();
    expect(screen.queryByText("public landing page")).not.toBeInTheDocument();
    expect(readPersistedSessionHandle()).toBe("sess-valid");
    expect(Auth.signOut).not.toHaveBeenCalled();
  });
});
