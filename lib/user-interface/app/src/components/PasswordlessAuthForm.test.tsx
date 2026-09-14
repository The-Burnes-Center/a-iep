/**
 * The code step of the passwordlessAuth screen: asking for another code, and
 * being told a code went out at all.
 *
 * Both were missing when the flag went into PROD_FEATURES. A parent whose text
 * never arrived had no resend at all, and nothing on the screen ever changed
 * to say a code had been sent, so the one workaround that did work (go back,
 * retype the number) was invisible as well.
 *
 * Driven through CustomLogin rather than PasswordlessAuthForm directly, on
 * purpose. The turnstile prop is the REAL useTurnstile hook in production, and
 * the central claim here — that a resend carries a fresh token and never the
 * one the first send already spent — is a property of the widget's mount /
 * unmount lifecycle. Handing the form a hand-made prop would assert the mock.
 * Only `fetch` and Cloudflare's own global are stubbed.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import CustomLogin from "./CustomLogin";
import { AuthProvider } from "../common/auth-provider";
import { LanguageContext } from "../common/language-context";
import { AppContext } from "../common/app-context";
import type { SupportedLanguage } from "../common/languages";
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
const SITE_KEY = "test-site-key";
const WITH_PASSWORDLESS = ["tts", "referrals", "passwordlessAuth"];
const PHONE = "5551234567";
const E164 = "+15551234567";
const dictionary = en as Record<string, string>;

/**
 * PasswordlessAuthForm's own RESEND_COOLDOWN_SECONDS, restated rather than
 * exported: the number is a product decision (see the constant's docblock),
 * so a change to it should have to be made here too, deliberately.
 */
const COOLDOWN_MS = 60 * 1000;

interface MockResponse {
  status: number;
  body: unknown;
}

/** Per-route response queues, same shape CustomLogin.test.tsx uses. */
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

const started = (channel: "sms" | "email" = "sms", challenge = "c1"): MockResponse => ({
  status: 200,
  body: { ok: true, challenge, channel, expiresIn: 300 },
});

/** Every widget useTurnstile has rendered, in order, plus what was torn down. */
type Options = { callback: (token: string) => void };
let widgets: { id: string; options: Options }[] = [];
let removed: string[] = [];
let resets: string[] = [];

const installTurnstile = () => {
  let nextId = 0;
  window.turnstile = {
    render: (_node, options) => {
      const id = `widget-${nextId++}`;
      widgets.push({ id, options: options as Options });
      return id;
    },
    // Neither of these hands back a token on its own: a real widget solves
    // asynchronously, so the test says when that happened, with `solve`.
    reset: (id: string) => { resets.push(id); },
    remove: (id: string) => { removed.push(id); },
  };
};

/** The newest widget finishes its challenge and produces `token`. */
const solve = (token: string) => {
  const widget = widgets[widgets.length - 1];
  if (!widget) throw new Error("no Turnstile widget is mounted to solve");
  act(() => { widget.options.callback(token); });
};

/**
 * Wall clock, moved by the test instead of waited out. The cooldown is
 * computed against Date.now() every tick, so advancing it is enough; the
 * one-second ticker itself is left real (a tick lands inside waitFor).
 */
let clockOffset = 0;
const realNow = Date.now.bind(Date);

let authFetch: ReturnType<typeof makeAuthFetch>;

const renderLogin = (
  opts: { language?: SupportedLanguage; realTranslations?: boolean; withSiteKey?: boolean } = {},
) => {
  const { language = "en", realTranslations = false, withSiteKey = false } = opts;
  const languageValue = {
    language,
    setLanguage: vi.fn(),
    // Identity by default: assertions then read the KEY the component chose,
    // which is the contract. The blocks that care about the wording a parent
    // reads opt into the real dictionary.
    t: realTranslations ? (key: string) => dictionary[key] || key : (key: string) => key,
    translationsLoaded: true,
    enabledLanguages: ["en", "es", "zh", "vi", "ar"] as SupportedLanguage[],
  };
  const appConfig = {
    httpEndpoint: HTTP_ENDPOINT,
    enabledFeatures: WITH_PASSWORDLESS,
    ...(withSiteKey ? { turnstileSiteKey: SITE_KEY } : {}),
  } as never;

  const view = render(
    <MemoryRouter initialEntries={["/login"]}>
      <AppContext.Provider value={appConfig}>
        <LanguageContext.Provider value={languageValue}>
          <AuthProvider>
            <Routes>
              <Route path="/login" element={<CustomLogin showLogo={false} />} />
              <Route path="/preferred-language" element={<div>landed</div>} />
            </Routes>
          </AuthProvider>
        </LanguageContext.Provider>
      </AppContext.Provider>
    </MemoryRouter>,
  );
  return { ...view, user: userEvent.setup() };
};

const fillPhone = (digits = PHONE) => {
  const input = screen.getByPlaceholderText("(xxx) xxx-xxxx") as HTMLInputElement;
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  nativeSetter.call(input, `+1 ${digits}`);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const resendButton = () => screen.getByTestId("resend-code");
const onCodeScreen = () => screen.queryByTestId("sms-code-input") !== null;
const onIdentifierScreen = () => screen.queryByPlaceholderText("(xxx) xxx-xxxx") !== null;

/** Phone identifier -> code screen, with the first code already sent. */
const startPhoneFlow = async (
  user: ReturnType<typeof userEvent.setup>,
  labels: { send: string } = { send: "auth.sendCode" },
) => {
  authFetch.queue("start", started("sms"));
  fillPhone();
  await user.click(screen.getByRole("button", { name: labels.send }));
  await screen.findByTestId("sms-code-input");
};

/** Let the cooldown expire without the test sitting through a minute of it. */
const waitOutCooldown = async () => {
  clockOffset += COOLDOWN_MS;
  await waitFor(() => expect(resendButton()).toBeEnabled(), { timeout: 3000 });
};

beforeEach(() => {
  localStorage.clear();
  widgets = [];
  removed = [];
  resets = [];
  clockOffset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
  document.getElementById("cf-turnstile")?.remove();
  Auth.getCurrentUser.mockRejectedValue(new Error("not authenticated"));
  Auth.fetchAuthSession.mockResolvedValue({});
  authFetch = makeAuthFetch();
  vi.stubGlobal("fetch", authFetch.fn);
});

afterEach(() => {
  delete window.turnstile;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("asking for another code", () => {
  test("the button belongs to the code step, not the destination step", async () => {
    const { user } = renderLogin();

    expect(screen.queryByTestId("resend-code")).not.toBeInTheDocument();

    await startPhoneFlow(user);

    expect(resendButton()).toBeInTheDocument();
  });

  test("it asks for a code for the destination already entered, with nothing retyped", async () => {
    const { user } = renderLogin();
    await startPhoneFlow(user);
    await waitOutCooldown();

    authFetch.queue("start", started("sms", "c2"));
    await user.click(resendButton());

    await waitFor(() => expect(authFetch.countOf("start")).toBe(2));
    expect(authFetch.callsTo("start")[1]).toMatchObject({ destination: E164 });
    // Still on the code step: the parent never saw the phone field again.
    expect(onCodeScreen()).toBe(true);
    expect(onIdentifierScreen()).toBe(false);
  });

  test("the parent is not asked to solve the security check again to send the first code", async () => {
    // The widget on the code step is there for the resend, but it must not
    // hold the code screen hostage: the code already sent stays verifiable.
    installTurnstile();
    const { user } = renderLogin({ withSiteKey: true });
    solve("token-first");
    await startPhoneFlow(user);

    authFetch.queue("verify", { status: 200, body: { ok: true, session: "s1", expiresIn: 2592000 } });
    authFetch.queue("token", { status: 200, body: { ok: true, accessToken: "a", idToken: "i", expiresIn: 3600 } });
    await user.type(screen.getByTestId("sms-code-input"), "123456");
    await user.click(screen.getByRole("button", { name: "auth.verify" }));

    expect(await screen.findByText("landed")).toBeInTheDocument();
  });
});

describe("the security check on a resend", () => {
  test("it carries a FRESH token, never the one the first send spent", async () => {
    installTurnstile();
    const { user } = renderLogin({ withSiteKey: true });

    solve("token-first");
    await startPhoneFlow(user);
    expect(authFetch.callsTo("start")[0]).toMatchObject({ turnstileToken: "token-first" });

    // Reaching the code step tore the first widget down, which is what makes
    // the spent token unreachable rather than merely unused.
    expect(removed).toContain("widget-0");
    expect(widgets.length).toBe(2);
    solve("token-fresh");

    await waitOutCooldown();
    authFetch.queue("start", started("sms", "c2"));
    await user.click(resendButton());

    await waitFor(() => expect(authFetch.countOf("start")).toBe(2));
    const resend = authFetch.callsTo("start")[1];
    expect(resend.turnstileToken).toBe("token-fresh");
    expect(resend.turnstileToken).not.toBe("token-first");
    // And the fresh one is spent now too, so a third send cannot reuse it.
    expect(resets).toContain("widget-1");
  });

  test("with no token in hand it is refused here, not sent to be refused as a 403", async () => {
    installTurnstile();
    const { user } = renderLogin({ withSiteKey: true });
    solve("token-first");
    await startPhoneFlow(user);
    await waitOutCooldown();

    // The code step's widget has rendered but nobody has solved it.
    await user.click(resendButton());

    expect(await screen.findByText("auth.securityCheckInteractive")).toBeInTheDocument();
    expect(authFetch.countOf("start")).toBe(1);
  });

  test("where no key is configured there is no widget, and the resend simply sends no token", async () => {
    // Local dev and any environment rolled out to before the secret exists.
    // The server decides whether that is acceptable, not this form.
    const { user } = renderLogin();
    await startPhoneFlow(user);
    await waitOutCooldown();

    authFetch.queue("start", started("sms", "c2"));
    await user.click(resendButton());

    await waitFor(() => expect(authFetch.countOf("start")).toBe(2));
    expect("turnstileToken" in authFetch.callsTo("start")[1]).toBe(false);
  });
});

describe("the cooldown", () => {
  test("a second tap straight away reaches nothing, and says when it will", async () => {
    const { user } = renderLogin({ realTranslations: true });
    await startPhoneFlow(user, { send: dictionary["auth.sendCode"] });

    await user.click(resendButton());

    expect(authFetch.countOf("start")).toBe(1);
    expect(resendButton()).toBeDisabled();
    // The number is a real countdown, and the sentence is real words: t() has
    // no English fallback, so a missing key would render its own dot-path.
    const wait = screen.getByText(/You can ask for a new code in \d+ seconds\./);
    expect(wait).toBeInTheDocument();
    expect(wait.textContent).not.toContain("{seconds}");
  });

  test("it survives leaving the page and coming back", async () => {
    // The bottom nav is a route change, so returning remounts this component
    // with a resumed challenge. A cooldown that lived only in component state
    // would be back at zero, and tapping Resend is how a parent would find out.
    const first = renderLogin();
    await startPhoneFlow(first.user);
    first.unmount();

    const second = renderLogin();
    expect(onCodeScreen()).toBe(true);
    expect(resendButton()).toBeDisabled();

    await second.user.click(resendButton());
    expect(authFetch.countOf("start")).toBe(1);
  });

  test("once it is over the code goes out", async () => {
    const { user } = renderLogin();
    await startPhoneFlow(user);
    await waitOutCooldown();

    authFetch.queue("start", started("sms", "c2"));
    await user.click(resendButton());

    await waitFor(() => expect(authFetch.countOf("start")).toBe(2));
  });
});

describe("when a resend cannot be honoured", () => {
  test("the per-destination limit shows the lockout with its wait, not a generic error", async () => {
    // Real dictionary deliberately: {minutes} is substituted by a .replace()
    // on the translated string, and the identity t() has no such placeholder
    // in its output for that replace to find.
    const { user } = renderLogin({ realTranslations: true });
    await startPhoneFlow(user, { send: dictionary["auth.sendCode"] });
    await waitOutCooldown();

    authFetch.queue("start", {
      status: 429,
      body: { ok: false, code: "too_many_codes", message: "nope", retryAfterSeconds: 120 },
    });
    await user.click(resendButton());

    const locked = await screen.findByTestId("passwordless-locked-out");
    expect(locked).toHaveTextContent(dictionary["auth.error.tooManyCodes"].replace("{minutes}", "2"));
    expect(onCodeScreen()).toBe(false);
    expect(screen.queryByText(dictionary["auth.errorGeneric"])).not.toBeInTheDocument();
  });

  test("a failure says so, in the parent's language, and claims nothing was sent", async () => {
    const { user } = renderLogin({ realTranslations: true });
    await startPhoneFlow(user, { send: dictionary["auth.sendCode"] });
    await waitOutCooldown();

    authFetch.queue("start", { status: 503, body: { ok: false, code: "unavailable", message: "english fallback" } });
    await user.click(resendButton());

    expect(await screen.findByText(dictionary["auth.error.unavailable"])).toBeInTheDocument();
    expect(onCodeScreen()).toBe(true);
    // Above all: no "a new code is on its way" for a code that is not.
    expect(screen.queryByText(dictionary["auth.smsCodeResent"])).not.toBeInTheDocument();
  });
});

describe("a code the parent was part way through typing", () => {
  test("a resend that works clears it, because the new code kills the old one", async () => {
    const { user } = renderLogin();
    await startPhoneFlow(user);
    await user.type(screen.getByTestId("sms-code-input"), "1234");
    await waitOutCooldown();

    authFetch.queue("start", started("sms", "c2"));
    await user.click(resendButton());

    // Those digits belong to a code the new one just invalidated; submitting
    // them would spend one of the three answers Cognito allows.
    await waitFor(() => expect(screen.getByTestId("sms-code-input")).toHaveValue(""));
  });

  test("a resend that fails leaves it alone, because their code still works", async () => {
    const { user } = renderLogin();
    await startPhoneFlow(user);
    await user.type(screen.getByTestId("sms-code-input"), "1234");
    await waitOutCooldown();

    authFetch.queue("start", { status: 503, body: { ok: false, code: "unavailable", message: "x" } });
    await user.click(resendButton());

    await screen.findByText("auth.error.unavailable");
    expect(screen.getByTestId("sms-code-input")).toHaveValue("1234");
  });
});

describe("telling a parent a code went out", () => {
  test("the first code by SMS is confirmed in SMS wording", async () => {
    const { user } = renderLogin({ realTranslations: true });
    await startPhoneFlow(user, { send: dictionary["auth.sendCode"] });

    expect(await screen.findByText(dictionary["auth.smsCodeSent"])).toBeInTheDocument();
  });

  test("the first code by email is confirmed in email wording, never the SMS copy", async () => {
    authFetch.queue("start", started("email"));
    const { user } = renderLogin({ realTranslations: true });

    await user.click(screen.getByRole("button", { name: dictionary["auth.emailLogin"] }));
    await user.type(screen.getByPlaceholderText(dictionary["auth.enterEmail"]), "parent@example.com");
    await user.click(screen.getByRole("button", { name: dictionary["auth.sendCode"] }));
    await screen.findByTestId("sms-code-input");

    expect(await screen.findByText(dictionary["auth.verificationCodeSent"])).toBeInTheDocument();
    expect(screen.queryByText(dictionary["auth.smsCodeSent"])).not.toBeInTheDocument();
  });

  test("a resent code says it is a new one, and says it per channel", async () => {
    const { user } = renderLogin({ realTranslations: true });
    await startPhoneFlow(user, { send: dictionary["auth.sendCode"] });
    await waitOutCooldown();

    authFetch.queue("start", started("sms", "c2"));
    await user.click(resendButton());

    expect(await screen.findByText(dictionary["auth.smsCodeResent"])).toBeInTheDocument();
    // The email wording is for the email channel only.
    expect(screen.queryByText(dictionary["auth.successCodeResent"])).not.toBeInTheDocument();
  });

  test("a resent code on the email channel uses the email wording", async () => {
    authFetch.queue("start", started("email"));
    const { user } = renderLogin({ realTranslations: true });

    await user.click(screen.getByRole("button", { name: dictionary["auth.emailLogin"] }));
    await user.type(screen.getByPlaceholderText(dictionary["auth.enterEmail"]), "parent@example.com");
    await user.click(screen.getByRole("button", { name: dictionary["auth.sendCode"] }));
    await screen.findByTestId("sms-code-input");
    await waitOutCooldown();

    authFetch.queue("start", started("email", "c2"));
    await user.click(resendButton());

    expect(await screen.findByText(dictionary["auth.successCodeResent"])).toBeInTheDocument();
    expect(screen.queryByText(dictionary["auth.smsCodeResent"])).not.toBeInTheDocument();
  });

  test("it does not outlive the answer: a wrong code replaces it, it does not sit beside it", async () => {
    const { user } = renderLogin({ realTranslations: true });
    await startPhoneFlow(user, { send: dictionary["auth.sendCode"] });
    await screen.findByText(dictionary["auth.smsCodeSent"]);

    authFetch.queue("verify", { status: 401, body: { ok: false, code: "bad_code", message: "nope" } });
    await user.type(screen.getByTestId("sms-code-input"), "123456");
    await user.click(screen.getByRole("button", { name: dictionary["auth.verify"] }));

    expect(await screen.findByText(dictionary["auth.error.badCode"])).toBeInTheDocument();
    expect(screen.queryByText(dictionary["auth.smsCodeSent"])).not.toBeInTheDocument();
  });

  test("going back to the destination step leaves nothing from the last attempt behind", async () => {
    installTurnstile();
    const { user } = renderLogin({ withSiteKey: true });
    solve("token-first");
    await startPhoneFlow(user);
    await user.type(screen.getByTestId("sms-code-input"), "1234");
    await waitOutCooldown();

    // Produces a message on the code step without touching the network.
    await user.click(resendButton());
    await screen.findByText("auth.securityCheckInteractive");

    await user.click(screen.getByRole("button", { name: "auth.backToLogin" }));

    expect(onIdentifierScreen()).toBe(true);
    expect(screen.queryByText("auth.securityCheckInteractive")).not.toBeInTheDocument();

    // And the next code screen starts empty rather than holding digits typed
    // against a challenge that was abandoned.
    authFetch.queue("start", started("sms", "c2"));
    solve("token-again");
    fillPhone();
    await user.click(screen.getByRole("button", { name: "auth.sendCode" }));

    expect(await screen.findByTestId("sms-code-input")).toHaveValue("");
  });
});
