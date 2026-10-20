/**
 * WebOTP: lets the browser read the SMS code out of the arriving message and
 * hand it to the page, so a parent does not copy six digits between apps.
 *
 * Phones on Chromium-family browsers only (Android Chrome, Samsung Internet).
 * Desktop Chrome and Arc also expose `OTPCredential`, but there it can only
 * read a code from an Android phone signed in to the same Chrome profile. A
 * request left pending there does nothing for a Mac and iPhone household, and
 * on macOS it can sit in front of the system's own suggestion from Messages,
 * so it is skipped on desktops. Safari, Firefox and desktop browsers offer the
 * code through autocomplete="one-time-code".
 *
 * The browser resolves the request only when the message ends with the
 * `@<host> #<code>` line, which the SMS sender appends.
 */

const SMS_TRANSPORT = 'sms';

/**
 * The OTP option, which TypeScript's DOM lib does not declare yet. Kept as an
 * intersection so the rest of the request stays typed.
 */
type OtpCredentialRequest = CredentialRequestOptions & {
  otp: { transport: string[] };
};

/** The UA-CH mobile hint, which TypeScript's DOM lib does not declare yet. */
type NavigatorWithUaData = Navigator & { userAgentData?: { mobile?: boolean } };

/**
 * Feature detection plus the structured `mobile` hint, never a user-agent
 * string. Every browser that has `OTPCredential` also has `userAgentData`, so
 * a missing hint means a browser this API is not meant for.
 */
export const isWebOtpSupported = (): boolean =>
  'OTPCredential' in window && (navigator as NavigatorWithUaData).userAgentData?.mobile === true;

/**
 * Resolves with the code the browser read, or null if the credential carried
 * no string code. Rejects when the request is aborted or the browser refuses
 * it, and the caller decides what that means.
 */
export const requestWebOtpCode = async (signal: AbortSignal): Promise<string | null> => {
  const options: OtpCredentialRequest = { otp: { transport: [SMS_TRANSPORT] }, signal };
  const credential = await navigator.credentials.get(options);
  const code = (credential as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
};

/** True for the rejection a request gets when its AbortController fires. */
export const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
