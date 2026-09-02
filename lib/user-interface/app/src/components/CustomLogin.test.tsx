/**
 * Wiring tests for the phone half of CustomLogin.
 *
 * The behaviour under test is what a parent signing up with a phone number
 * actually experiences, so these drive the real component through the DOM and
 * mock only the boundary: Amplify's `Auth`. Everything else — AuthProvider,
 * the router, AlertMessages — is real, and the assertions are what the parent
 * sees (which screen, which message, where they land) plus what must NOT
 * happen (no second SMS, no confirmation step, no account created).
 *
 * The single most valuable case here is `isSignUpComplete === false`. A PreSignUp
 * trigger now auto-confirms phone-only signups so a new parent gets exactly
 * ONE SMS, and the two-code path is the fallback for when that trigger does
 * not take effect. No E2E journey can cover it: a journey cannot assert
 * "exactly one SMS" and exercise the two-SMS path at the same time.
 */
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import CustomLogin from "./CustomLogin";
import { AuthProvider, useAuth } from "../common/auth-provider";
import { LanguageContext } from "../common/language-context";
import type { SupportedLanguage } from "../common/languages";

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

const PHONE_DIGITS = "5551234567";
const PHONE_E164 = "+15551234567";
const OTP = "123456";
const SECOND_OTP = "654321";

/** An Amplify error as the SDK actually shapes it: a code, not a class. */
const cognitoError = (code: string) =>
  Object.assign(new Error(code), { code });

const LANDING = "you are on the preferred-language page";

/** Surfaces the AuthProvider state that a successful login must produce. */
const AuthStateProbe = () => {
  const { authenticated } = useAuth();
  return <div data-testid="auth-state">{authenticated ? "signed-in" : "anonymous"}</div>;
};

const renderLogin = (language: SupportedLanguage = "en") => {
  const setLanguage = vi.fn();
  // t() is the identity so every assertion reads the translation KEY, which is
  // what the component actually chooses; the English wording is not the
  // contract and changing it must not break these tests.
  const languageValue = {
    language,
    setLanguage,
    t: (key: string) => key,
    translationsLoaded: true,
    enabledLanguages: ["en", "es", "zh", "vi", "ar"] as SupportedLanguage[],
  };

  render(
    <MemoryRouter initialEntries={["/login"]}>
      <LanguageContext.Provider value={languageValue}>
        <AuthProvider>
          {/* Outside <Routes> so it survives the post-login navigation */}
          <AuthStateProbe />
          <Routes>
            <Route path="/login" element={<CustomLogin showLogo={false} />} />
            <Route path="/preferred-language" element={<div>{LANDING}</div>} />
          </Routes>
        </AuthProvider>
      </LanguageContext.Provider>
    </MemoryRouter>,
  );

  return { user: userEvent.setup(), setLanguage };
};

/**
 * Fill the phone field in one change event. The field reformats on every
 * keystroke and rewrites the caret, so per-character typing is a test of the
 * formatter's caret handling rather than of the auth flow.
 */
const fillPhone = (digits = PHONE_DIGITS) => {
  fireEvent.change(screen.getByPlaceholderText("(xxx) xxx-xxxx"), {
    target: { value: `+1 ${digits}` },
  });
};

const submitPhone = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "auth.sendSmsCode" }));
};

const submitCode = async (user: ReturnType<typeof userEvent.setup>, code: string) => {
  await user.type(screen.getByTestId("sms-code-input"), code);
  await user.click(screen.getByRole("button", { name: "auth.verifySmsCode" }));
};

const onOtpScreen = () => screen.queryByTestId("sms-code-input") !== null;
const onPhoneScreen = () => screen.queryByPlaceholderText("(xxx) xxx-xxxx") !== null;

beforeEach(() => {
  // No session: AuthProvider's mount check must report anonymous.
  Auth.getCurrentUser.mockRejectedValue(new Error("not authenticated"));
});

describe("phone number handling", () => {
  test("normalizes the formatted field to E.164 before calling Cognito", async () => {
    Auth.signIn.mockResolvedValue({ isSignedIn: false, nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE", additionalInfo: {} } });
    const { user } = renderLogin();

    fillPhone();
    expect(screen.getByPlaceholderText("(xxx) xxx-xxxx")).toHaveValue("+1 (555) 123-4567");
    await submitPhone(user);

    await screen.findByTestId("sms-code-input");
    expect(Auth.signIn).toHaveBeenCalledWith({
      username: PHONE_E164,
      options: { authFlowType: "CUSTOM_WITHOUT_SRP", clientMetadata: { language: "en" } },
    });
  });

  test("rejects a short number without contacting Cognito at all", async () => {
    const { user } = renderLogin();

    fillPhone("55512");
    await submitPhone(user);

    expect(await screen.findByText("auth.errorPhoneFormat")).toBeInTheDocument();
    expect(Auth.signIn).not.toHaveBeenCalled();
    expect(Auth.signUp).not.toHaveBeenCalled();
    expect(onOtpScreen()).toBe(false);
  });
});

describe("applyPhoneSignInResult", () => {
  test("a plain custom challenge parks the parent on the code screen", async () => {
    Auth.signIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE", additionalInfo: {} },
      username: PHONE_E164,
    });
    const { user } = renderLogin();

    fillPhone();
    await submitPhone(user);

    expect(await screen.findByTestId("sms-code-input")).toBeInTheDocument();
    expect(screen.getByText("auth.smsCodeSent")).toBeInTheDocument();
    expect(onPhoneScreen()).toBe(false);
    // An existing user must never be pushed through account creation.
    expect(Auth.signUp).not.toHaveBeenCalled();
  });

  test("a challenge reporting a send failure shows the error and does NOT claim a code was sent", async () => {
    // The SMS lambda reports a failed send through challengeParam.error while
    // still returning a CUSTOM_CHALLENGE. Without the check the UI would park
    // the parent on a code screen waiting for an SMS that never arrives.
    Auth.signIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE", additionalInfo: { error: "SNS publish failed" } },
    });
    const { user } = renderLogin();

    fillPhone();
    await submitPhone(user);

    expect(await screen.findByText("auth.errorSendingCode")).toBeInTheDocument();
    expect(onOtpScreen()).toBe(false);
    expect(onPhoneScreen()).toBe(true);
    expect(screen.queryByText("auth.smsCodeSent")).not.toBeInTheDocument();
  });

  test("no challenge at all means already authenticated: log in and route on", async () => {
    Auth.signIn.mockResolvedValue({ isSignedIn: true, nextStep: { signInStep: "DONE" } });
    Auth.getCurrentUser.mockResolvedValue({ username: PHONE_E164, userId: "test-user" });
    const { user } = renderLogin();

    fillPhone();
    await submitPhone(user);

    expect(await screen.findByText(LANDING)).toBeInTheDocument();
    expect(screen.getByTestId("auth-state")).toHaveTextContent("signed-in");
  });

  test("answers the language handshake round, in the parent's language, before the OTP screen", async () => {
    // Cognito does not forward sign-in clientMetadata to the SMS lambda, so the
    // backend's first round collects the UI language and sends nothing. Answering
    // it DOES forward clientMetadata, and the next round sends the OTP in that
    // language — the whole reason the round exists.
    const handshakeUser = {
      isSignedIn: false,
      nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE", additionalInfo: { challengeType: "LANGUAGE_HANDSHAKE" } },
    };
    Auth.signIn.mockResolvedValue(handshakeUser);
    Auth.confirmSignIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE", additionalInfo: {} },
    });
    const { user } = renderLogin("es");

    fillPhone();
    await submitPhone(user);

    expect(await screen.findByTestId("sms-code-input")).toBeInTheDocument();
    expect(Auth.confirmSignIn).toHaveBeenCalledWith({
      challengeResponse: "HANDSHAKE_ACK",
      options: { clientMetadata: { language: "es" } },
    });
  });
});

describe("unknown number falls back to sign-up", () => {
  test.each(["UserNotFoundException", "NotAuthorizedException"])(
    "%s creates the account with the phone number and UI locale",
    async (code) => {
      // NotAuthorizedException matters as much as UserNotFoundException: the app
      // client has PreventUserExistenceErrors on, so an unknown number surfaces
      // as a failed auth rather than a missing user.
      Auth.signIn.mockRejectedValueOnce(cognitoError(code));
      Auth.signUp.mockResolvedValue({ isSignUpComplete: true });
      Auth.signIn.mockResolvedValueOnce({
        isSignedIn: false,
        nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE", additionalInfo: {} },
      });
      const { user } = renderLogin("vi");

      fillPhone();
      await submitPhone(user);

      expect(await screen.findByTestId("sms-code-input")).toBeInTheDocument();
      expect(Auth.signUp).toHaveBeenCalledTimes(1);
      expect(Auth.signUp.mock.calls[0][0]).toMatchObject({
        username: PHONE_E164,
        options: {
          userAttributes: { phone_number: PHONE_E164, locale: "vi" },
          clientMetadata: { language: "vi" },
        },
      });
    },
  );

  test("an unrelated Cognito error creates no account and shows its own message", async () => {
    Auth.signIn.mockRejectedValue(cognitoError("InvalidParameterException"));
    const { user } = renderLogin();

    fillPhone();
    await submitPhone(user);

    expect(await screen.findByText("auth.errorPhoneFormat")).toBeInTheDocument();
    expect(Auth.signUp).not.toHaveBeenCalled();
    expect(onOtpScreen()).toBe(false);
  });

  test("a number created between the two calls retries the sign-in instead of failing", async () => {
    Auth.signIn.mockRejectedValueOnce(cognitoError("UserNotFoundException"));
    Auth.signUp.mockRejectedValue(cognitoError("UsernameExistsException"));
    Auth.signIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE", additionalInfo: {} },
    });
    const { user } = renderLogin();

    fillPhone();
    await submitPhone(user);

    expect(await screen.findByTestId("sms-code-input")).toBeInTheDocument();
    expect(screen.getByText("auth.smsCodeSent")).toBeInTheDocument();
    expect(Auth.signIn).toHaveBeenCalledTimes(2);
  });
});

describe("single-SMS signup (isSignUpComplete: true)", () => {
  const arrangeAutoConfirmedSignup = () => {
    Auth.signIn.mockRejectedValueOnce(cognitoError("UserNotFoundException"));
    Auth.signUp.mockResolvedValue({ isSignUpComplete: true });
    Auth.signIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE", additionalInfo: {} },
      username: PHONE_E164,
    });
  };

  test("skips the confirmation step and goes straight to the login OTP", async () => {
    arrangeAutoConfirmedSignup();
    const { user } = renderLogin();

    fillPhone();
    await submitPhone(user);

    expect(await screen.findByTestId("sms-code-input")).toBeInTheDocument();
    expect(screen.getByText("auth.smsCodeSentNewUser")).toBeInTheDocument();
    // The PreSignUp trigger minted no signup code, so there is nothing to
    // confirm — asking for one would strand the parent on a dead screen.
    expect(Auth.confirmSignUp).not.toHaveBeenCalled();
    expect(Auth.resendSignUpCode).not.toHaveBeenCalled();
    expect(Auth.signUp).toHaveBeenCalledTimes(1);
  });

  test("the one code the parent receives is the custom-auth code, and it logs them in", async () => {
    arrangeAutoConfirmedSignup();
    Auth.confirmSignIn.mockResolvedValue({
      isSignedIn: true, nextStep: { signInStep: "DONE" },
    });
    Auth.getCurrentUser.mockResolvedValue({ username: PHONE_E164, userId: "test-user" });
    const { user } = renderLogin();

    fillPhone();
    await submitPhone(user);
    await screen.findByTestId("sms-code-input");
    await submitCode(user, OTP);

    expect(await screen.findByText("auth.phoneVerificationSuccess")).toBeInTheDocument();
    expect(screen.getByTestId("auth-state")).toHaveTextContent("signed-in");
    expect(Auth.confirmSignIn).toHaveBeenCalledWith({
      challengeResponse: OTP,
      options: { clientMetadata: { language: "en" } },
    });
    expect(Auth.confirmSignUp).not.toHaveBeenCalled();
    // The redirect is deliberately delayed a beat so the success alert is read.
    expect(await screen.findByText(LANDING, undefined, { timeout: 3000 })).toBeInTheDocument();
  });
});

describe("two-code fallback (isSignUpComplete: false)", () => {
  /**
   * The PreSignUp trigger did not take effect, so Cognito minted a signup code
   * and the parent must confirm the account before the login OTP is issued.
   * Unreachable from an E2E journey that asserts a single SMS.
   */
  const arrangeUnconfirmedSignup = async () => {
    Auth.signIn.mockRejectedValueOnce(cognitoError("UserNotFoundException"));
    Auth.signUp.mockResolvedValue({ isSignUpComplete: false });
    const { user } = renderLogin();

    fillPhone();
    await submitPhone(user);
    await screen.findByTestId("sms-code-input");
    return user;
  };

  test("collects the signup code without asking Cognito for a second SMS", async () => {
    await arrangeUnconfirmedSignup();

    expect(screen.getByText("auth.smsCodeSentNewUser")).toBeInTheDocument();
    expect(onOtpScreen()).toBe(true);
    // The code already in flight is Cognito's signup code. Starting custom auth
    // here would send a second SMS and the parent would not know which to type.
    // (Call 1 is the probe that threw UserNotFoundException.)
    expect(Auth.signIn).toHaveBeenCalledTimes(1);
    expect(Auth.resendSignUpCode).not.toHaveBeenCalled();
  });

  test("the first code confirms the account, then a login code is requested", async () => {
    const user = await arrangeUnconfirmedSignup();
    Auth.signIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE", additionalInfo: {} },
      username: PHONE_E164,
    });

    await submitCode(user, OTP);

    expect(await screen.findByText("auth.accountConfirmedNewCode")).toBeInTheDocument();
    expect(Auth.confirmSignUp).toHaveBeenCalledWith({
      username: PHONE_E164,
      confirmationCode: OTP,
    });
    // The signup code is a confirmation code, never a custom-auth answer.
    expect(Auth.confirmSignIn).not.toHaveBeenCalled();
    expect(Auth.signIn).toHaveBeenCalledTimes(2);
    // Cleared so the parent types the NEW code into an empty field.
    expect(screen.getByTestId("sms-code-input")).toHaveValue("");
  });

  test("the second code completes the login", async () => {
    const user = await arrangeUnconfirmedSignup();
    Auth.signIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE", additionalInfo: {} },
      username: PHONE_E164,
    });
    await submitCode(user, OTP);
    await screen.findByText("auth.accountConfirmedNewCode");

    Auth.confirmSignIn.mockResolvedValue({
      isSignedIn: true, nextStep: { signInStep: "DONE" },
    });
    Auth.getCurrentUser.mockResolvedValue({ username: PHONE_E164, userId: "test-user" });
    await submitCode(user, SECOND_OTP);

    expect(await screen.findByText("auth.phoneVerificationSuccess")).toBeInTheDocument();
    expect(screen.getByTestId("auth-state")).toHaveTextContent("signed-in");
    expect(Auth.confirmSignIn).toHaveBeenCalledWith({
      challengeResponse: SECOND_OTP,
      options: { clientMetadata: { language: "en" } },
    });
  });

  test("a wrong signup code keeps the parent on the code screen with a retryable message", async () => {
    const user = await arrangeUnconfirmedSignup();
    Auth.confirmSignUp.mockRejectedValue(cognitoError("CodeMismatchException"));

    await submitCode(user, OTP);

    expect(await screen.findByText("auth.invalidSmsCode")).toBeInTheDocument();
    expect(onOtpScreen()).toBe(true);
    expect(screen.getByTestId("sms-code-input")).toHaveValue("");
    expect(Auth.signIn).toHaveBeenCalledTimes(1);
  });

  test("a post-confirmation SMS failure sends the parent back to the phone screen", async () => {
    const user = await arrangeUnconfirmedSignup();
    // Confirmed, but the follow-up custom auth could not send its code.
    Auth.signIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE", additionalInfo: { error: "SNS publish failed" } },
    });

    await submitCode(user, OTP);

    await waitFor(() => expect(onPhoneScreen()).toBe(true));
    expect(screen.getByText("auth.errorGeneric")).toBeInTheDocument();
    expect(onOtpScreen()).toBe(false);
  });
});
