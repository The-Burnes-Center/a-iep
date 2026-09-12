/**
 * AuthProvider surviving a page reload under the `passwordlessAuth` flag.
 *
 * The passwordless flow (docs/AUTH_API_CONTRACT.md) persists exactly one
 * durable value, the session handle, in localStorage. Before this file, the
 * mount check only ever asked Amplify whether there was a session — nothing
 * re-exchanged that handle on a fresh load, so a parent who signed in and hit
 * refresh was bounced back to /login even though their handle was still good.
 *
 * These tests drive the real AuthProvider and the real ProtectedRoute through
 * the DOM (MemoryRouter), mocking only the boundary — Amplify's `Auth` for the
 * legacy path, `fetch` for /auth/token — and assert what a parent actually
 * sees: which screen they land on, and (via a location log) that they get
 * there directly rather than bouncing between /login and the protected route.
 */
import React, { useEffect, useState } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth-provider";
import { ProtectedRoute } from "../components/ProtectedRoute";
import { AppContext } from "./app-context";
import { LanguageContext } from "./language-context";
import type { AppConfig } from "./types";
import type { SupportedLanguage } from "./languages";
import {
  clearCachedTokens,
  getCachedIdToken,
  persistSessionHandle,
  readPersistedSessionHandle,
} from "./auth/passwordless-auth";

const Auth = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  fetchAuthSession: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("aws-amplify/auth", () => Auth);

const HTTP_ENDPOINT = "https://api.example.test/";
const PROTECTED_PATH = "/protected";

/** Records every pathname the router actually lands on, in order. */
const visitedPaths = (): { LocationLogger: React.FC; visited: string[] } => {
  const visited: string[] = [];
  const LocationLogger: React.FC = () => {
    const location = useLocation();
    useEffect(() => {
      visited.push(location.pathname);
    }, [location.pathname]);
    return null;
  };
  return { LocationLogger, visited };
};

const AuthStateProbe = () => {
  const { authenticated, loading } = useAuth();
  return (
    <div data-testid="auth-state">
      {loading ? "loading" : authenticated ? "signed-in" : "anonymous"}
    </div>
  );
};

/**
 * Drives the two context functions the sign-out tests below need, and reports
 * whether logout() settled or threw — a thrown Amplify signOut() must not be
 * allowed to look like a successful sign-out, but it must not undo the local
 * clear either.
 */
const SessionProbe = () => {
  const { logout, checkAuth } = useAuth();
  const [outcome, setOutcome] = useState("idle");
  return (
    <>
      <div data-testid="logout-outcome">{outcome}</div>
      <button
        onClick={async () => {
          try {
            await logout();
            setOutcome("resolved");
          } catch {
            setOutcome("rejected");
          }
        }}
      >
        sign out
      </button>
      <button onClick={() => { void checkAuth(); }}>check again</button>
    </>
  );
};

const renderApp = (opts: { enabledFeatures?: string[] } = {}) => {
  const { enabledFeatures = ["passwordlessAuth"] } = opts;
  const appConfig = {
    httpEndpoint: HTTP_ENDPOINT,
    enabledFeatures,
  } as unknown as AppConfig;
  const languageValue = {
    language: "en" as SupportedLanguage,
    setLanguage: vi.fn(),
    t: (key: string) => key,
    translationsLoaded: true,
    enabledLanguages: ["en"] as SupportedLanguage[],
  };
  const { LocationLogger, visited } = visitedPaths();

  const { unmount } = render(
    <MemoryRouter initialEntries={[PROTECTED_PATH]}>
      <AppContext.Provider value={appConfig}>
        <LanguageContext.Provider value={languageValue}>
          <AuthProvider>
            <LocationLogger />
            <AuthStateProbe />
            <SessionProbe />
            <Routes>
              <Route path="/login" element={<div>sign in form</div>} />
              <Route element={<ProtectedRoute />}>
                <Route path={PROTECTED_PATH} element={<div>protected content</div>} />
              </Route>
            </Routes>
          </AuthProvider>
        </LanguageContext.Provider>
      </AppContext.Provider>
    </MemoryRouter>,
  );

  // `unmount` then a second renderApp() is this suite's page load: a brand new
  // AuthProvider running its mount checkAuth against whatever localStorage
  // still holds, which is exactly what a parent's next visit does.
  return { visited, unmount };
};

/** A fetch mock that only answers /auth/token, and records how it was called. */
const stubTokenEndpoint = (answer: "valid" | "expired" | "unreachable") => {
  const fn = vi.fn(async (url: unknown) => {
    expect(String(url)).toContain("auth/token");
    if (answer === "unreachable") throw new Error("network down");
    if (answer === "expired") {
      return {
        ok: false,
        status: 401,
        json: async () => ({ ok: false, code: "session_invalid", message: "expired" }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, accessToken: "access-1", idToken: "id-1", expiresIn: 3600 }),
    };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
};

/**
 * A fetch mock covering both endpoints a sign-out touches: /auth/token (the
 * resume on load) and /auth/logout (the revoke). Records every call so a test
 * can assert what was sent and, just as importantly, what was not sent again
 * after the parent signed out.
 */
const stubSignOutEndpoints = (opts: { revoke?: "ok" | "unreachable" } = {}) => {
  const { revoke = "ok" } = opts;
  const calls: { path: string; body: unknown }[] = [];
  const fn = vi.fn(async (url: unknown, init?: { body?: string }) => {
    const path = String(url);
    calls.push({ path, body: init?.body ? JSON.parse(init.body) : null });
    if (path.includes("auth/logout")) {
      if (revoke === "unreachable") throw new Error("network down");
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    expect(path).toContain("auth/token");
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, accessToken: "access-1", idToken: "id-1", expiresIn: 3600 }),
    };
  });
  vi.stubGlobal("fetch", fn);
  return {
    tokenCalls: () => calls.filter((c) => c.path.includes("auth/token")),
    logoutCalls: () => calls.filter((c) => c.path.includes("auth/logout")),
  };
};

/**
 * Signs a parent in through the passwordless route, then taps Sign Out.
 * Every test below starts here, because the defect only exists for a parent
 * who got in this way.
 */
const signInThenSignOut = async (opts: { revoke?: "ok" | "unreachable" } = {}) => {
  persistSessionHandle("sess-valid");
  Auth.getCurrentUser.mockRejectedValue(new Error("no amplify session"));
  const endpoints = stubSignOutEndpoints(opts);
  const app = renderApp();
  expect(await screen.findByText("protected content")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "sign out" }));
  await waitFor(() => expect(screen.getByTestId("logout-outcome")).not.toHaveTextContent("idle"));
  return { ...app, ...endpoints };
};

beforeEach(() => {
  localStorage.clear();
  clearCachedTokens();
  // The "unreachable" scenario drives a real rejected fetch through
  // postJson's own catch, which logs on purpose (see passwordless-auth.ts) —
  // suppressed here the same way app-configured.test.tsx suppresses its own
  // deliberately-triggered error log.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a reload with a valid persisted handle", () => {
  test("signs the parent in directly, with no visit to /login and no /auth/start", async () => {
    persistSessionHandle("sess-valid");
    Auth.getCurrentUser.mockRejectedValue(new Error("no amplify session"));
    const tokenFetch = stubTokenEndpoint("valid");

    const { visited } = renderApp();

    expect(await screen.findByText("protected content")).toBeInTheDocument();
    expect(screen.getByTestId("auth-state")).toHaveTextContent("signed-in");
    expect(tokenFetch).toHaveBeenCalledTimes(1);
    // The Amplify check never runs at all: this is a short-circuit (checked
    // and awaited BEFORE falling through), not a race between the two.
    expect(Auth.getCurrentUser).not.toHaveBeenCalled();
    // The in-memory cache got the fresh ID token...
    expect(getCachedIdToken()).toBe("id-1");
    // ...and the handle itself is untouched (still the one durable value).
    expect(readPersistedSessionHandle()).toBe("sess-valid");
    // Landed directly: never rendered /login on the way.
    expect(visited).toEqual([PROTECTED_PATH]);
  });
});

describe("the loading state while the exchange is in flight", () => {
  test("shows neither the login screen nor the protected content until the exchange resolves", async () => {
    persistSessionHandle("sess-valid");
    Auth.getCurrentUser.mockRejectedValue(new Error("no amplify session"));
    let resolveFetch!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        expect(String(url)).toContain("auth/token");
        return pending;
      }),
    );

    renderApp();

    // Still in flight: ProtectedRoute's `loading` gate must be showing its
    // spinner, not a flash of the login screen (the defect this exists to
    // fix) and not the protected content before the exchange actually
    // resolved either.
    expect(screen.queryByText("sign in form")).not.toBeInTheDocument();
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
    expect(screen.getByTestId("auth-state")).toHaveTextContent("loading");

    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, accessToken: "access-1", idToken: "id-1", expiresIn: 3600 }),
    });

    expect(await screen.findByText("protected content")).toBeInTheDocument();
    expect(screen.queryByText("sign in form")).not.toBeInTheDocument();
  });
});

describe("a reload with an expired or revoked handle", () => {
  test("clears the handle and lands cleanly on /login, exactly once", async () => {
    persistSessionHandle("sess-expired");
    Auth.getCurrentUser.mockRejectedValue(new Error("no amplify session"));
    const tokenFetch = stubTokenEndpoint("expired");

    const { visited } = renderApp();

    expect(await screen.findByText("sign in form")).toBeInTheDocument();
    expect(screen.getByTestId("auth-state")).toHaveTextContent("anonymous");
    expect(readPersistedSessionHandle()).toBeNull();
    expect(tokenFetch).toHaveBeenCalledTimes(1);
    // Redirected exactly once — not bounced back and forth between the two
    // routes. A loop would show up here as a longer, repeating path list.
    expect(visited).toEqual([PROTECTED_PATH, "/login"]);
  });
});

describe("a reload with the backend unreachable", () => {
  test("does not destroy the handle, and still lands cleanly on /login rather than spinning forever", async () => {
    persistSessionHandle("sess-maybe-still-good");
    Auth.getCurrentUser.mockRejectedValue(new Error("no amplify session"));
    const tokenFetch = stubTokenEndpoint("unreachable");

    const { visited } = renderApp();

    expect(await screen.findByText("sign in form")).toBeInTheDocument();
    expect(screen.getByTestId("auth-state")).toHaveTextContent("anonymous");
    expect(tokenFetch).toHaveBeenCalledTimes(1);
    // Not proven invalid (contract §4: only session_invalid is), so the
    // handle a parent might still be able to use survives for a retry.
    expect(readPersistedSessionHandle()).toBe("sess-maybe-still-good");
    expect(visited).toEqual([PROTECTED_PATH, "/login"]);
  });
});

describe("no redirect loop", () => {
  test("neither the expired-handle nor the unreachable-backend case ever bounces back to the protected route", async () => {
    persistSessionHandle("sess-expired");
    Auth.getCurrentUser.mockRejectedValue(new Error("no amplify session"));
    const tokenFetch = stubTokenEndpoint("expired");

    const { visited } = renderApp();

    await waitFor(() => expect(screen.getByTestId("auth-state")).toHaveTextContent("anonymous"));
    // Give any stray effect one more tick to fire before declaring the route
    // settled — a loop would add a third entry (back to PROTECTED_PATH) here.
    await waitFor(() => expect(visited).toEqual([PROTECTED_PATH, "/login"]));
    expect(visited).toEqual([PROTECTED_PATH, "/login"]);
    // A loop would also mean checkAuth (and so /auth/token) ran more than once.
    expect(tokenFetch).toHaveBeenCalledTimes(1);
  });
});

/**
 * Sign-out. The one thing these have to prove is that the NEXT page load does
 * not hand the account back.
 *
 * Asserting that Amplify's signOut() was called proves nothing here: that is
 * precisely what the broken version did, and it is why the defect survived to
 * a promotion. Once passwordlessAuth is on, signOut() is not a sign-out —
 * checkAuth tries the persisted handle BEFORE the Amplify check, so a handle
 * left in localStorage signs the parent straight back in. On a shared or
 * family computer that is the next person reading a child's IEP.
 */
describe("signing out, then loading the page again", () => {
  test("does not sign the parent back in: the reload lands on /login, not in the account", async () => {
    const { unmount, tokenCalls } = await signInThenSignOut();

    expect(screen.getByTestId("auth-state")).toHaveTextContent("anonymous");
    expect(tokenCalls()).toHaveLength(1); // the sign-in resume, and only that

    // The page load. A brand new AuthProvider, same localStorage.
    unmount();
    const { visited } = renderApp();

    expect(await screen.findByText("sign in form")).toBeInTheDocument();
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
    expect(screen.getByTestId("auth-state")).toHaveTextContent("anonymous");
    expect(visited).toEqual([PROTECTED_PATH, "/login"]);
    // Nothing left to exchange, so the resume never even reached the network.
    expect(tokenCalls()).toHaveLength(1);
  });

  test("re-running checkAuth within the same page load does not resume the session either", async () => {
    // The unmount/remount case above is the page load; this is the softer one
    // that still hands the account back — any code path that calls checkAuth
    // again (a route change, a focus handler) after a sign-out.
    const { tokenCalls } = await signInThenSignOut();

    await userEvent.click(screen.getByRole("button", { name: "check again" }));

    await waitFor(() => expect(screen.getByTestId("auth-state")).toHaveTextContent("anonymous"));
    expect(screen.queryByText("protected content")).not.toBeInTheDocument();
    expect(tokenCalls()).toHaveLength(1);
  });

  test("leaves no persisted handle and no cached tokens behind", async () => {
    const { logoutCalls } = await signInThenSignOut();

    expect(readPersistedSessionHandle()).toBeNull();
    expect(getCachedIdToken()).toBeNull();
    // And the row was revoked server-side, with the handle that was actually
    // held — best-effort on top of the local clear, not instead of it.
    expect(logoutCalls()).toHaveLength(1);
    expect(logoutCalls()[0].body).toEqual({ session: "sess-valid" });
  });

  test("still signs the parent out on this device when the revoke call fails", async () => {
    // A parent on a dead connection taps Sign Out. The revoke cannot happen,
    // and the row's own TTL will have to do it later — but this browser must
    // not be able to resume regardless, which is what the local-clear-first
    // ordering buys.
    const { unmount, logoutCalls, tokenCalls } = await signInThenSignOut({ revoke: "unreachable" });

    expect(logoutCalls()).toHaveLength(1); // attempted...
    expect(readPersistedSessionHandle()).toBeNull(); // ...and cleared anyway
    expect(getCachedIdToken()).toBeNull();
    expect(screen.getByTestId("auth-state")).toHaveTextContent("anonymous");

    unmount();
    renderApp();
    expect(await screen.findByText("sign in form")).toBeInTheDocument();
    expect(tokenCalls()).toHaveLength(1);
  });

  test("still signs the parent out on this device when Amplify's signOut throws", async () => {
    persistSessionHandle("sess-valid");
    Auth.getCurrentUser.mockRejectedValue(new Error("no amplify session"));
    Auth.signOut.mockRejectedValue(new Error("amplify unreachable"));
    const { tokenCalls } = stubSignOutEndpoints();

    const { unmount } = renderApp();
    expect(await screen.findByText("protected content")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "sign out" }));

    // The caller is told it failed — that is what lets a call site show the
    // parent something — but the handle is already gone by the time it throws.
    await waitFor(() => expect(screen.getByTestId("logout-outcome")).toHaveTextContent("rejected"));
    expect(readPersistedSessionHandle()).toBeNull();
    expect(getCachedIdToken()).toBeNull();

    unmount();
    renderApp();
    expect(await screen.findByText("sign in form")).toBeInTheDocument();
    expect(tokenCalls()).toHaveLength(1);
  });
});

describe("the legacy Amplify path is unaffected", () => {
  test("flag off: a valid Amplify session still signs the parent in, with no /auth/token call", async () => {
    Auth.getCurrentUser.mockResolvedValue({ username: "parent-1" });
    const tokenFetch = vi.fn();
    vi.stubGlobal("fetch", tokenFetch);

    const { visited } = renderApp({ enabledFeatures: [] });

    expect(await screen.findByText("protected content")).toBeInTheDocument();
    expect(tokenFetch).not.toHaveBeenCalled();
    expect(visited).toEqual([PROTECTED_PATH]);
  });

  test("flag off: no Amplify session lands on /login, same as before this change", async () => {
    Auth.getCurrentUser.mockRejectedValue(new Error("not authenticated"));
    const tokenFetch = vi.fn();
    vi.stubGlobal("fetch", tokenFetch);

    const { visited } = renderApp({ enabledFeatures: [] });

    expect(await screen.findByText("sign in form")).toBeInTheDocument();
    expect(tokenFetch).not.toHaveBeenCalled();
    expect(visited).toEqual([PROTECTED_PATH, "/login"]);
  });

  test("flag off with a handle persisted anyway: the resume is skipped entirely, not just failed", async () => {
    // Guards against a regression where the flag check is weakened to "try
    // anyway" — the handle here would make that indistinguishable from the
    // on case if the gate did not actually skip the network call.
    persistSessionHandle("sess-valid");
    Auth.getCurrentUser.mockResolvedValue({ username: "parent-1" });
    const tokenFetch = vi.fn();
    vi.stubGlobal("fetch", tokenFetch);

    const { visited } = renderApp({ enabledFeatures: [] });

    expect(await screen.findByText("protected content")).toBeInTheDocument();
    expect(tokenFetch).not.toHaveBeenCalled();
    expect(visited).toEqual([PROTECTED_PATH]);
  });

  test("flag on but nothing persisted: falls through to the Amplify check untouched", async () => {
    Auth.getCurrentUser.mockResolvedValue({ username: "parent-1" });
    const tokenFetch = vi.fn();
    vi.stubGlobal("fetch", tokenFetch);

    const { visited } = renderApp({ enabledFeatures: ["passwordlessAuth"] });

    expect(await screen.findByText("protected content")).toBeInTheDocument();
    // No handle to resume, so the new code path took zero network calls of
    // its own — the Amplify check alone did the work, unmodified.
    expect(tokenFetch).not.toHaveBeenCalled();
    expect(visited).toEqual([PROTECTED_PATH]);
  });
});
