// Cognito error messages always arrive in English, so they must never be
// shown directly — map the stable error `code` to a translation key instead.
// Keys not in this map (and errors without a code) fall back to the generic
// message rather than leaking untranslated backend text into the UI.

const COGNITO_ERROR_KEYS: Record<string, string> = {
  CodeMismatchException: 'auth.errorInvalidCode',
  ExpiredCodeException: 'auth.errorExpiredCode',
  LimitExceededException: 'auth.tooManyAttempts',
  TooManyRequestsException: 'auth.tooManyAttempts',
  TooManyFailedAttemptsException: 'auth.tooManyAttempts',
  InvalidPasswordException: 'auth.errorInvalidPassword',
  InvalidParameterException: 'auth.errorInvalidParameter',
  UsernameExistsException: 'auth.errorUserExists',
  UserNotFoundException: 'auth.errorUserNotFound',
  UserNotConfirmedException: 'auth.errorUserNotConfirmed',
};

/**
 * Translate a Cognito/Amplify error into a translation key for AlertMessages.
 *
 * NotAuthorizedException is deliberately absent from the default map: its
 * meaning depends on the flow (wrong password on sign-in, unconfirmable user
 * on reset, ...), so callers that can interpret it pass it via `overrides`.
 *
 * @param err        the caught error (Amplify errors expose `code`; newer
 *                   versions use `name`)
 * @param overrides  flow-specific code → key mappings, checked first
 * @param fallbackKey key used when the code is unknown
 */
export function cognitoErrorKey(
  err: unknown,
  overrides?: Record<string, string>,
  fallbackKey = 'auth.errorGeneric'
): string {
  const code = (err as { code?: string; name?: string })?.code
    ?? (err as { name?: string })?.name;
  if (!code) return fallbackKey;
  return overrides?.[code] ?? COGNITO_ERROR_KEYS[code] ?? fallbackKey;
}
