/**
 * CustomLogin, covering both backends that are live at once behind the
 * `passwordlessAuth` flag (see docs/AUTH_API_CONTRACT.md and
 * common/features.ts).
 *
 * Most of this file replaces the previous suite, which drove the Amplify
 * signIn-then-/auth/signup branch the new backend exists to remove (see
 * CLAUDE.md and AUTH_API_CONTRACT.md §11: "most of them have no successor").
 * These tests drive the real component through the DOM and mock only the
 * boundary — `fetch` for the new flow, Amplify's `Auth` for the legacy one —
 * asserting what a parent actually sees (which screen, which message, where
 * they land) and what must NOT happen (no second code requested, no token
 * written to storage, no raw dot-key rendered).
 *
 * A small second suite renders with the flag off and confirms the legacy
 * Amplify path this repo still serves in production is untouched by this
 * change; it is a smoke check on the gating itself, not a re-litigation of
 * every legacy edge case (those were already covered before this change and
 * their underlying code is unmodified).
 */
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import CustomLogin from "./CustomLogin";
import { AuthProvider, useAuth } from "../common/auth-provider";
import { LanguageContext } from "../common/language-context";
import { AppContext } from "../common/app-context";
import type { SupportedLanguage } from "../common/languages";
import {
  getCachedIdToken,
  persistSessionHandle,
  readPersistedSessionHandle,
  setCachedTokens,
} from "../common/auth/passwordless-auth";
import en from "../translations/en.json";

const Auth = vi.hoisted(() => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
  confirmSignIn: vi.fn(),
  confirmSignUp: vi.fn(),
  resendSignUpCode: vi.fn(),
  getCurrentUser: vi.fn(),
  fetchAuthSession: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("aws-amplify/auth", () => Auth);

const HTTP_ENDPOINT = "https://api.example.test/";
const LANDING = "you are on the preferred-language page";

/** An Amplify error as the SDK actually shapes it: a code, not a class. */
const cognitoError = (code: string) => Object.assign(new Error(code), { code });

/** Surfaces the AuthProvider state a successful login must produce. */
const AuthStateProbe = () => {
  const { authenticated } = useAuth();
  return <div data-testid="auth-state">{authenticated ? "signed-in" : "anonymous"}</div>;
};

interface MockResponse {
  status: number;
  body: unknown;
}

/**
 * A fetch mock keyed by which /auth/* route was called, so a test can queue
 * exactly the sequence of responses one flow needs (e.g. a 202 then a 200)
 * without caring how the other routes behave.
 */
const makeAuthFetch = () => {
  const queues: Record<string, MockResponse[]> = {};
  const calls: Record<string, Record<string, unknown>[]> = {};

  const endpointOf = (url: string): string => /auth\/(start|verify|token|logout)/.exec(url)?.[1] ?? "unknown";

  const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
    const endpoint = endpointOf(String(url));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls[endpoint] = [...(calls[endpoint] ?? []), body];
    const next = (queues[endpoint] ?? []).shift();
    if (!next) throw new Error(`test forgot to queue a response for auth/${endpoint}`);
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body } as Response;
  });

  return {
    fn,
    queue: (endpoint: string, ...responses: MockResponse[]) => {
      queues[endpoint] = [...(queues[endpoint] ?? []), ...responses];
    },
    callsTo: (endpoint: string) => calls[endpoint] ?? [],
    countOf: (endpoint: string) => (calls[endpoint] ?? []).length,
  };
};

let authFetch: ReturnType<typeof makeAuthFetch>;

const ALL_FLAGS_BUT_PASSWORDLESS = ["tts", "referrals"];
const WITH_PASSWORDLESS = ["tts", "referrals", "passwordlessAuth"];

const renderLogin = (opts: { language?: SupportedLanguage; flagOn?: boolean; realTranslations?: boolean } = {}) => {
  const { language = "en", flagOn = true, realTranslations = false } = opts;
  const dictionary = en as Record<string, string>;
  const languageValue = {
    language,
    setLanguage: vi.fn(),
    // Identity by default, matching the rest of this suite: assertions read
    // the KEY the component chose, which is the actual contract, not the
    // English wording. One block below opts into the real dictionary
    // specifically to prove a key resolves to words, not to itself.
    t: realTranslations ? (key: string) => dictionary[key] || key : (key: string) => key,
    translationsLoaded: true,
    enabledLanguages: ["en", "es", "zh", "vi", "ar"] as SupportedLanguage[],
  };
  const appConfig = {
    httpEndpoint: HTTP_ENDPOINT,
    enabledFeatures: flagOn ? WITH_PASSWORDLESS : ALL_FLAGS_BUT_PASSWORDLESS,
  } as never;

  const view = render(
    <MemoryRouter initialEntries={["/login"]}>
      <AppContext.Provider value={appConfig}>
        <LanguageContext.Provider value={languageValue}>
          <AuthProvider>
            <AuthStateProbe />
            <Routes>
              <Route path="/login" element={<CustomLogin showLogo={false} />} />
              <Route path="/preferred-language" element={<div>{LANDING}</div>} />
            </Routes>
          </AuthProvider>
        </LanguageContext.Provider>
      </AppContext.Provider>
    </MemoryRouter>,
  );
  return { ...view, user: userEvent.setup() };
};

const fillPhone = (digits = "5551234567") => {
  const input = screen.getByPlaceholderText("(xxx) xxx-xxxx") as HTMLInputElement;
  // Single change event: the field reformats on every keystroke, so
  // per-character typing tests the formatter's caret handling, not the flow.
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  nativeSetter.call(input, `+1 ${digits}`);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const onCodeScreen = () => screen.queryByTestId("sms-code-input") !== null;
const onIdentifierScreen = () => screen.queryByPlaceholderText("(xxx) xxx-xxxx") !== null;

beforeEach(() => {
  localStorage.clear();
  Auth.getCurrentUser.mockRejectedValue(new Error("not authenticated"));
  authFetch = makeAuthFetch();
  vi.stubGlobal("fetch", authFetch.fn);
});

describe("passwordless flow: identifier screen (flag on)", () => {
  test("a phone number normalizes to E.164 and starts the flow in the parent's language", async () => {
    authFetch.queue("start", { status: 200, body: { ok: true, challenge: "c1", channel: "sms", expiresIn: 300 } });
    const { user } = renderLogin({ language: "es" });

    fillPhone();
    await user.click(screen.getByRole("button", { name: "auth.sendCode" }));

    expect(await screen.findByTestId("sms-code-input")).toBeInTheDocument();
    expect(authFetch.callsTo("start")[0]).toEqual({ destination: "+15551234567", language: "es" });
  });

  test("a short phone number is rejected locally: no request is made at all", async () => {
    const { user } = renderLogin();

    fillPhone("55512");
    await user.click(screen.getByRole("button", { name: "auth.sendCode" }));

    expect(await screen.findByText("auth.errorPhoneFormat")).toBeInTheDocument();
    expect(authFetch.countOf("start")).toBe(0);
    expect(onCodeScreen()).toBe(false);
  });

  test("the browser's own required/type=email validation blocks an empty email submit, same as the legacy form", async () => {
    // No custom JS blank-check in PasswordlessAuthForm for the email tab —
    // EmailInput is required + type="email", so onSubmit never fires at all
    // for an empty field. Asserted here so a future removal of `required`
    // gets caught: without it, an empty destination would reach /auth/start.
    const { user } = renderLogin();

    await user.click(screen.getByRole("button", { name: "auth.emailLogin" }));
    await user.click(screen.getByRole("button", { name: "auth.sendCode" }));

    expect(authFetch.countOf("start")).toBe(0);
    expect(onCodeScreen()).toBe(false);
  });

  test("the email tab sends a lowercased address instead of a phone number", async () => {
    authFetch.queue("start", { status: 200, body: { ok: true, challenge: "c1", channel: "email", expiresIn: 300 } });
    const { user } = renderLogin();

    await user.click(screen.getByRole("button", { name: "auth.emailLogin" }));
    await user.type(screen.getByPlaceholderText("auth.enterEmail"), "Parent@Example.com");
    await user.click(screen.getByRole("button", { name: "auth.sendCode" }));

    await screen.findByTestId("sms-code-input");
    expect(authFetch.callsTo("start")[0]).toMatchObject({ destination: "parent@example.com" });
  });

  test("sends the turnstile token when the widget produced one, and omits it otherwise", async () => {
    authFetch.queue("start", { status: 200, body: { ok: true, challenge: "c1", channel: "sms", expiresIn: 300 } });
    const { user } = renderLogin();

    fillPhone();
    await user.click(screen.getByRole("button", { name: "auth.sendCode" }));

    await screen.findByTestId("sms-code-input");
    // No turnstileSiteKey configured in this render, so no widget and no
    // token — the same "server decides" convention the legacy flow uses.
    expect("turnstileToken" in authFetch.callsTo("start")[0]).toBe(false);
  });

  test.each([
    ["invalid_destination", "auth.error.invalidDestination"],
    ["unsupported_destination", "auth.error.unsupportedDestination"],
    ["bot_check_failed", "auth.error.botCheckFailed"],
    ["rate_limited", "auth.error.rateLimited"],
    ["unavailable", "auth.error.unavailable"],
  ])("/auth/start %s shows %s and stays on the identifier screen", async (code, key) => {
    authFetch.queue("start", { status: 400, body: { ok: false, code, message: "english fallback text" } });
    const { user } = renderLogin();

    fillPhone();
    await user.click(screen.getByRole("button", { name: "auth.sendCode" }));

    expect(await screen.findByText(key)).toBeInTheDocument();
    expect(onCodeScreen()).toBe(false);
    expect(onIdentifierScreen()).toBe(true);
  });
});

describe("passwordless flow: code screen (flag on)", () => {
  const startThenAwaitCode = async (user: ReturnType<typeof userEvent.setup>) => {
    authFetch.queue("start", { status: 200, body: { ok: true, challenge: "c1", channel: "sms", expiresIn: 300 } });
    fillPhone();
    await user.click(screen.getByRole("button", { name: "auth.sendCode" }));
    await screen.findByTestId("sms-code-input");
  };

  const submitCode = async (user: ReturnType<typeof userEvent.setup>, code = "123456") => {
    await user.type(screen.getByTestId("sms-code-input"), code);
    await user.click(screen.getByRole("button", { name: "auth.verify" }));
  };

  test("a 202 not_ready is retried transparently and the parent still lands on the app", async () => {
    authFetch.queue("verify",
      { status: 202, body: { ok: false, code: "not_ready", retryAfterMs: 5 } },
      { status: 200, body: { ok: true, session: "sess-1", expiresIn: 2592000 } },
    );
    authFetch.queue("token", { status: 200, body: { ok: true, accessToken: "a1", idToken: "i1", expiresIn: 3600 } });
    const { user } = renderLogin();
    await startThenAwaitCode(user);

    await submitCode(user);

    expect(await screen.findByText(LANDING)).toBeInTheDocument();
    expect(authFetch.countOf("verify")).toBe(2);
  });

  test("bad_code keeps the parent on the code screen so they can retype", async () => {
    authFetch.queue("verify", { status: 401, body: { ok: false, code: "bad_code", message: "nope" } });
    const { user } = renderLogin();
    await startThenAwaitCode(user);

    await submitCode(user);

    expect(await screen.findByText("auth.error.badCode")).toBeInTheDocument();
    expect(onCodeScreen()).toBe(true);
    expect(screen.getByTestId("sms-code-input")).toHaveValue("");
  });

  test("a third wrong code in a row forces a fresh start rather than a fourth dead attempt", async () => {
    authFetch.queue(
      "verify",
      { status: 401, body: { ok: false, code: "bad_code", message: "nope" } },
      { status: 401, body: { ok: false, code: "bad_code", message: "nope" } },
      { status: 401, body: { ok: false, code: "bad_code", message: "nope" } },
    );
    const { user } = renderLogin();
    await startThenAwaitCode(user);

    await submitCode(user);
    await screen.findByText("auth.error.badCode");
    await submitCode(user);
    await screen.findByText("auth.error.badCode");
    await submitCode(user);

    // Back on the identifier screen: Cognito's own three-answer budget is
    // spent, and a fourth submit would only get bad_code again for a reason
    // the client cannot tell apart from the first three (contract §3).
    await waitFor(() => expect(onIdentifierScreen()).toBe(true));
    expect(onCodeScreen()).toBe(false);
    expect(authFetch.countOf("verify")).toBe(3);
  });

  test("too_many_codes locks the parent out with the wait time, then returns to the identifier screen", async () => {
    // Real dictionary here, not the identity t(): the {minutes} substitution
    // is a string .replace() in the component, and the identity function's
    // output ("auth.error.tooManyCodes") has no "{minutes}" substring in it
    // for that replace to find, so it would pass this assertion vacuously.
    const dict = en as Record<string, string>;
    authFetch.queue("start", { status: 200, body: { ok: true, challenge: "c1", channel: "sms", expiresIn: 300 } });
    authFetch.queue("verify", { status: 429, body: { ok: false, code: "too_many_codes", message: "nope", retryAfterSeconds: 1 } });
    const { user } = renderLogin({ realTranslations: true });

    fillPhone();
    await user.click(screen.getByRole("button", { name: dict["auth.sendCode"] }));
    await screen.findByTestId("sms-code-input");
    await user.type(screen.getByTestId("sms-code-input"), "123456");
    await user.click(screen.getByRole("button", { name: dict["auth.verify"] }));

    const locked = await screen.findByTestId("passwordless-locked-out");
    expect(locked).toHaveTextContent(dict["auth.error.tooManyCodes"].replace("{minutes}", "1"));
    expect(onCodeScreen()).toBe(false);

    await waitFor(() => expect(onIdentifierScreen()).toBe(true), { timeout: 3000 });
  });

  test.each([
    ["unsupported_destination", "auth.error.sendFailed.unsupportedDestination"],
    ["budget_exhausted", "auth.error.sendFailed.budgetExhausted"],
    ["rate_limited", "auth.error.sendFailed.rateLimited"],
    ["delivery_failed", "auth.error.sendFailed.deliveryFailed"],
  ])("send_failed reason %s shows %s and sends the parent back to start", async (reason, key) => {
    authFetch.queue("verify", { status: 409, body: { ok: false, code: "send_failed", message: "x", reason } });
    const { user } = renderLogin();
    await startThenAwaitCode(user);

    await submitCode(user);

    expect(await screen.findByText(key)).toBeInTheDocument();
    expect(onIdentifierScreen()).toBe(true);
  });

  test("unavailable from /auth/verify keeps the challenge so the parent can just retry", async () => {
    authFetch.queue("verify", { status: 503, body: { ok: false, code: "unavailable", message: "x" } });
    const { user } = renderLogin();
    await startThenAwaitCode(user);

    await submitCode(user);

    expect(await screen.findByText("auth.error.unavailable")).toBeInTheDocument();
    expect(onCodeScreen()).toBe(true); // handle kept; contract says retry, not restart
  });

  test("session_invalid from /auth/token does NOT sign the parent in: it sends them back to start", async () => {
    authFetch.queue("verify", { status: 200, body: { ok: true, session: "sess-1", expiresIn: 2592000 } });
    authFetch.queue("token", { status: 401, body: { ok: false, code: "session_invalid", message: "x" } });
    const { user } = renderLogin();
    await startThenAwaitCode(user);

    await submitCode(user);

    expect(await screen.findByText("auth.error.sessionInvalid")).toBeInTheDocument();
    expect(screen.getByTestId("auth-state")).toHaveTextContent("anonymous");
    expect(screen.queryByText(LANDING)).not.toBeInTheDocument();
    expect(readPersistedSessionHandle()).toBeNull();
  });

  test("a correct code signs the parent in and never writes accessToken/idToken to storage", async () => {
    authFetch.queue("verify", { status: 200, body: { ok: true, session: "sess-1", expiresIn: 2592000 } });
    authFetch.queue("token", { status: 200, body: { ok: true, accessToken: "secret-access", idToken: "secret-id", expiresIn: 3600 } });
    const { user } = renderLogin();
    await startThenAwaitCode(user);

    await submitCode(user);

    expect(await screen.findByText(LANDING)).toBeInTheDocument();
    expect(screen.getByTestId("auth-state")).toHaveTextContent("signed-in");

    // The one durable value the contract allows (§6, §8).
    expect(readPersistedSessionHandle()).toBe("sess-1");
    // The in-memory cache got it...
    expect(getCachedIdToken()).toBe("secret-id");
    // ...but neither raw token string is anywhere in localStorage.
    const storedValues = Object.keys(localStorage).map((k) => localStorage.getItem(k)).join("\n");
    expect(storedValues).not.toContain("secret-access");
    expect(storedValues).not.toContain("secret-id");
  });

  test("a code typed while the previous attempt is still in flight is not erased", async () => {
    // Regression. handleVerify used to clear the field AFTER awaiting the
    // request, so the clear landed on whatever was in the box when the
    // response arrived rather than on what had been submitted. Two staging
    // E2E journeys died on it, and a parent on a slow connection hits the
    // same window: they tap Verify, start retyping, and watch their code
    // vanish and the button grey out.
    let releaseVerify: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => { releaseVerify = resolve; });
    const passThrough = authFetch.fn;
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      if (!/auth\/verify/.test(String(url))) return passThrough(url, init);
      await inFlight;
      return {
        ok: false,
        status: 401,
        json: async () => ({ ok: false, code: "bad_code", message: "nope" }),
      } as Response;
    }));

    const { user } = renderLogin();
    await startThenAwaitCode(user);

    const field = screen.getByTestId("sms-code-input");
    await user.type(field, "111111");
    await user.click(screen.getByRole("button", { name: "auth.verify" }));

    // Still hanging. The parent gives up on it and types the code again.
    await user.clear(field);
    await user.type(field, "222222");

    releaseVerify();
    await screen.findByText("auth.error.badCode");

    expect(field).toHaveValue("222222");
    expect(screen.getByRole("button", { name: "auth.verify" })).toBeEnabled();
  });

});

describe("passwordless flow: leaving and returning mid-flow", () => {
  test("a challenge left mid-flow resumes the code screen on remount, with no second /auth/start", async () => {
    authFetch.queue("start", { status: 200, body: { ok: true, challenge: "c1", channel: "sms", expiresIn: 300 } });
    const first = renderLogin();
    fillPhone();
    await first.user.click(screen.getByRole("button", { name: "auth.sendCode" }));
    await screen.findByTestId("sms-code-input");

    // The bottom nav is a route change: leaving unmounts this component.
    first.unmount();

    renderLogin();

    // First render after remount — not asserting after an action, per
    // CLAUDE.md's rule for this exact defect class (resumeTranslationRequest).
    expect(onCodeScreen()).toBe(true);
    expect(onIdentifierScreen()).toBe(false);
    expect(authFetch.countOf("start")).toBe(1);
  });

  test("an expired persisted challenge is not resumed: a stale code screen never traps a parent", async () => {
    const { persistChallenge } = await import("../common/auth/passwordless-auth");
    persistChallenge({ challenge: "stale", destination: "+15551234567", channel: "sms", expiresAt: Date.now() - 1000 });

    renderLogin();

    expect(onIdentifierScreen()).toBe(true);
    expect(onCodeScreen()).toBe(false);
  });
});

describe("passwordless flow: copy is real words, not raw translation keys", () => {
  test("an error code the parent hits resolves to English text, not its own dot-key", async () => {
    authFetch.queue("start", { status: 429, body: { ok: false, code: "rate_limited", message: "english fallback" } });
    const { user } = renderLogin({ realTranslations: true });

    fillPhone();
    await user.click(screen.getByRole("button", { name: en["auth.sendCode"] }));

    const shown = await screen.findByText((_, node) => node?.textContent === en["auth.error.rateLimited"]);
    expect(shown).toBeInTheDocument();
    expect(shown.textContent).not.toBe("auth.error.rateLimited");
  });
});

describe("legacy Amplify flow still renders when the flag is off", () => {
  const signupFetchAsLegacy = () => {
    // The legacy flow's own fetch is exercised through the same global mock;
    // it never calls auth/start|verify|token, so any queued response there
    // would simply never be consumed. Route it to the old signup shape.
    authFetch.fn.mockImplementation(async (url: unknown) => {
      if (String(url).includes("auth/signup")) {
        return { ok: true, status: 200, json: async () => ({ created: true }) } as Response;
      }
      throw new Error(`unexpected fetch to ${String(url)} in legacy-flow test`);
    });
  };

  test("an unknown phone number still falls back to the legacy /auth/signup endpoint", async () => {
    signupFetchAsLegacy();
    Auth.signIn.mockRejectedValueOnce(cognitoError("UserNotFoundException"));
    Auth.signIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE", additionalInfo: {} },
    });
    const { user } = renderLogin({ flagOn: false });

    fillPhone();
    await user.click(screen.getByRole("button", { name: "auth.sendSmsCode" }));

    expect(await screen.findByTestId("sms-code-input")).toBeInTheDocument();
    expect(authFetch.fn).toHaveBeenCalledWith(
      expect.stringContaining("auth/signup"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("the email tab still shows the legacy password form, not the new identifier-only one", async () => {
    const { user } = renderLogin({ flagOn: false });

    await user.click(screen.getByRole("button", { name: "auth.emailLogin" }));

    expect(screen.getByPlaceholderText("auth.enterPassword")).toBeInTheDocument();
    // The new flow's button never renders on this path.
    expect(screen.queryByRole("button", { name: "auth.sendCode" })).not.toBeInTheDocument();
  });

  test("a leftover passwordless handle is dropped before the new sign-in starts", async () => {
    // clearStaleSession used to return early right here — nobody is signed in
    // via Amplify, which is this suite's default and the normal case on a
    // login screen. A passwordless handle is invisible to getCurrentUser(),
    // so it survived, and checkAuth prefers the handle over the Amplify
    // session: the next page load would sign the app in as whoever used this
    // browser last, not as whoever just authenticated.
    persistSessionHandle("sess-previous-parent");
    setCachedTokens({ accessToken: "access-previous", idToken: "id-previous", expiresIn: 3600 });
    signupFetchAsLegacy();
    Auth.signIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE", additionalInfo: {} },
    });
    const { user } = renderLogin({ flagOn: false });

    fillPhone();
    await user.click(screen.getByRole("button", { name: "auth.sendSmsCode" }));

    expect(await screen.findByTestId("sms-code-input")).toBeInTheDocument();
    expect(readPersistedSessionHandle()).toBeNull();
    expect(getCachedIdToken()).toBeNull();
    // Local only. Deleting the browser's only copy already puts the handle
    // beyond use, so the revoke that belongs on Sign Out is not also put on
    // the critical path of every sign-in attempt.
    expect(authFetch.fn).not.toHaveBeenCalledWith(
      expect.stringContaining("auth/logout"),
      expect.anything(),
    );
  });
});
