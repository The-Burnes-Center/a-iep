/**
 * WebOTP: lets the browser read the SMS code out of the arriving message and
 * hand it to the page, so a parent does not copy six digits between apps.
 *
 * Chromium-family browsers only (Android Chrome, Samsung Internet). Anywhere
 * else `OTPCredential` is absent and callers do nothing. Safari and Firefox
 * already offer the code through autocomplete="one-time-code".
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

/** Feature detection only. Never a user-agent check. */
export const isWebOtpSupported = (): boolean => 'OTPCredential' in window;

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
