/**
 * What the security check tells a parent who cannot see it.
 *
 * An interactive Turnstile challenge is a mandatory, focusable control sitting
 * between the phone field and the submit button. Before 2026-09-10 it
 * contributed nothing to the accessibility tree from this page: the form read
 * as label, phone field, hidden field, button, with the gate invisible. These
 * tests are the counterpart to use-turnstile.test.tsx, which covers the hook's
 * state; this covers what that state is turned into for a parent.
 *
 * `t()` here is the REAL en.json lookup, not the identity function the rest of
 * CustomLogin.test.tsx uses. That is deliberate and load-bearing. The app's
 * t() is `translations[key] || key` with no English fallback, so a key that is
 * missing or blank in a dictionary renders "auth.securityCheck" verbatim to a
 * parent. An identity t() cannot tell those two apart; this one asserts the
 * announcement is words rather than a dot-separated key.
 */
import React from "react";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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

const SITE_KEY = "test-site-key";
const dictionary = en as Record<string, string>;

/** The app's own lookup, copied exactly: no fallback, "" counts as missing. */
const translate = (key: string): string => dictionary[key] || key;

type Options = {
  callback: (token: string) => void;
  "before-interactive-callback"?: () => void;
  "expired-callback"?: () => void;
  "timeout-callback"?: () => void;
};
let rendered: { id: string; options: Options }[] = [];

const installTurnstile = () => {
  let nextId = 0;
  window.turnstile = {
    render: (_node, options) => {
      const id = `widget-${nextId++}`;
      rendered.push({ id, options: options as Options });
      return id;
    },
    reset: vi.fn(),
    remove: vi.fn(),
    execute: vi.fn(),
  };
};

const renderLogin = (language: SupportedLanguage = "en") => {
  const languageValue = {
    language,
    setLanguage: vi.fn(),
    t: translate,
    translationsLoaded: true,
    enabledLanguages: ["en", "es", "zh", "vi", "ar"] as SupportedLanguage[],
  };
  const appConfig = {
    httpEndpoint: "https://api.example.test/",
    turnstileSiteKey: SITE_KEY,
    // This suite is written against the legacy Amplify phone/email flow,
    // where Turnstile lives on the phone tab only and switching to email
    // unmounts it with nothing to replace it. Pinned explicitly rather than
    // left to fall back (an absent field defaults to every feature ON,
    // including passwordlessAuth): the new flow renders Turnstile on both
    // tabs since /auth/start needs a token regardless of destination type, so
    // switching tabs there mounts a fresh widget instead of leaving none, and
    // "was reset" is no longer the right thing to announce. That behaviour
    // has its own coverage in PasswordlessAuthForm.test.tsx.
    enabledFeatures: ["tts", "referrals"],
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

/** The region every non-error announcement is written into. */
const liveRegion = (container: HTMLElement): HTMLElement => {
  const region = container.querySelector('[aria-live="polite"]');
  if (!(region instanceof HTMLElement)) {
    throw new Error("the security check has no polite live region to announce into");
  }
  return region;
};

const fire = (name: keyof Options) => {
  const handler = rendered[0].options[name];
  if (typeof handler !== "function") {
    throw new Error(`useTurnstile never wired ${String(name)}`);
  }
  act(() => { (handler as () => void)(); });
};

beforeEach(() => {
  rendered = [];
  document.getElementById("cf-turnstile")?.remove();
  Auth.getCurrentUser.mockRejectedValue(new Error("nobody signed in"));
  Auth.fetchAuthSession.mockResolvedValue({});
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
});

afterEach(() => {
  delete window.turnstile;
  vi.unstubAllGlobals();
});

describe("the security check is invisible until a parent has to act", () => {
  // The widget is `interaction-only` and runs on send. Most parents never see
  // it, so a heading asking them to prove they are not a robot, next to a box
  // that is not there, would be a question with nothing to answer.
  test("before Cloudflare asks for anything there is no heading, no group and no reserved space", async () => {
    installTurnstile();
    const { container } = renderLogin();
    await waitFor(() => expect(rendered).toHaveLength(1));

    expect(screen.queryByRole("group", { name: translate("auth.securityCheck") })).toBeNull();
    expect(screen.queryByText(translate("auth.securityCheckHelp"))).toBeNull();
    const slot = container.querySelector(".justify-content-center") as HTMLElement;
    expect(slot.style.minHeight).toBe("");
  });

  test("an interactive challenge becomes a named group with instructions", async () => {
    // Turnstile renders into a closed shadow root the page cannot name, so
    // without this the challenge is a focusable, unnamed, mandatory gate.
    installTurnstile();
    const { container } = renderLogin();
    await waitFor(() => expect(rendered).toHaveLength(1));

    fire("before-interactive-callback");

    const group = screen.getByRole("group", { name: translate("auth.securityCheck") });
    const describedBy = group.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const help = container.querySelector(`#${describedBy}`);
    expect(help?.textContent?.trim()).toBe(translate("auth.securityCheckHelp"));
    // Reserved while it shows, so the box does not move the button under them.
    const slot = group.querySelector(".justify-content-center") as HTMLElement;
    expect(slot.style.minHeight).not.toBe("");
  });

  test("turning interactive does not remount the widget", async () => {
    // The group appears around the container. If that remounted it, the
    // callback ref would detach and remove the widget mid-challenge.
    installTurnstile();
    renderLogin();
    await waitFor(() => expect(rendered).toHaveLength(1));

    fire("before-interactive-callback");

    expect(rendered).toHaveLength(1);
    expect(window.turnstile?.remove).not.toHaveBeenCalled();
  });

  test("the name and the instruction are words, not raw translation keys", () => {
    // t() is `translations[key] || key`, so a key that is missing or blank in
    // any of the five dictionaries renders itself. That is the exact failure
    // an identity-function t() in the other suites cannot see.
    expect(translate("auth.securityCheck")).not.toBe("auth.securityCheck");
    expect(translate("auth.securityCheckHelp")).not.toBe("auth.securityCheckHelp");
  });
});

describe("the security check announces only what a parent must act on", () => {
  test("the live region is present and EMPTY at first paint", () => {
    // A live region inserted with its content already inside it is not
    // announced by NVDA or JAWS — only role="alert" gets that treatment. So
    // this region has to exist first and only ever have its text swapped.
    const { container } = renderLogin();

    expect(liveRegion(container).textContent).toBe("");
  });

  test("an invisible widget arriving, passing, expiring or resetting says nothing", async () => {
    // Each of these used to be announced, which was right for a visible box
    // a parent could see change. For an invisible one it narrates a control
    // nobody can find about a step nobody has to take.
    installTurnstile();
    const { container, user } = renderLogin();
    await waitFor(() => expect(rendered).toHaveLength(1));
    expect(liveRegion(container).textContent).toBe("");

    act(() => { rendered[0].options.callback("a-token"); });
    expect(liveRegion(container).textContent).toBe("");

    fire("expired-callback");
    expect(liveRegion(container).textContent).toBe("");

    act(() => { rendered[0].options.callback("a-token"); });
    await user.click(screen.getByRole("button", { name: translate("auth.emailLogin") }));
    expect(liveRegion(container).textContent).toBe("");
  });

  test("a challenge that turns interactive is announced and shown", async () => {
    installTurnstile();
    const { container } = renderLogin();
    await waitFor(() => expect(rendered).toHaveLength(1));

    fire("before-interactive-callback");

    const expected = translate("auth.securityCheckInteractive");
    expect(liveRegion(container)).toHaveTextContent(expected);
    // ...and sighted parents get the same news, inside the group, without a
    // screen reader. Two copies, but only one of them is a live region, so it
    // is said once.
    const group = screen.getByRole("group", { name: translate("auth.securityCheck") });
    expect(within(group).getByText(expected)).toBeInTheDocument();
  });

  test("every message the check can show is words, not a raw translation key", () => {
    const keys = [
      "auth.securityCheckInteractive",
      "auth.securityCheckTimedOut",
      "auth.securityCheckRetry",
      "auth.errorTurnstileUnavailable",
    ];
    expect(keys.filter((key) => translate(key) === key)).toEqual([]);
  });
});

describe("the security check reports its own failures", () => {
  test("a challenge that times out gets an alert and a way out", async () => {
    installTurnstile();
    renderLogin();
    await waitFor(() => expect(rendered).toHaveLength(1));

    fire("timeout-callback");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(translate("auth.securityCheckTimedOut"));
    expect(
      screen.getByRole("button", { name: translate("auth.securityCheckRetry") }),
    ).toBeInTheDocument();
  });

  test("a check that cannot run at all announces itself through role=alert", async () => {
    // No window.turnstile, so the hook appends the script tag; failing that
    // load is what a parent behind a network or extension that blocks
    // challenges.cloudflare.com actually experiences.
    renderLogin();
    const script = document.getElementById("cf-turnstile");
    expect(script).not.toBeNull();

    act(() => { script?.dispatchEvent(new Event("error")); });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(translate("auth.errorTurnstileUnavailable"));
  });

  test("the failure alert reads as English, not as auth.errorTurnstileUnavailable", async () => {
    renderLogin();
    act(() => { document.getElementById("cf-turnstile")?.dispatchEvent(new Event("error")); });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toBe("auth.errorTurnstileUnavailable");
    expect(alert.textContent?.trim()).toBe(translate("auth.errorTurnstileUnavailable"));
  });
});

describe("the challenge speaks the app's language", () => {
  test.each(["en", "es", "zh", "vi", "ar"] as SupportedLanguage[])(
    "a parent reading %s gets the challenge in %s",
    async (code) => {
      installTurnstile();
      renderLogin(code);

      await waitFor(() => expect(rendered).toHaveLength(1));
      expect((rendered[0].options as unknown as { language?: string }).language).toBe(code);
    },
  );
});
