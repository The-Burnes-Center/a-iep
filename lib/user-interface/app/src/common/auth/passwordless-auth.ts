// The client side of docs/AUTH_API_CONTRACT.md: /auth/start, /auth/verify,
// /auth/token and /auth/logout. Framework-agnostic on purpose (no React) so
// the state machine in use-passwordless-auth.ts can be tested against real
// fetch mocks without mounting a component.
//
// Gated behind the `passwordlessAuth` feature flag at the call site
// (CustomLogin.tsx) — nothing in here reads the flag, this module is just the
// wire format and the two durable values the contract says the client stores.

import { StorageHelper } from '../helpers/storage-helper';

export type AuthChannel = 'sms' | 'email';

// ---- Wire shapes, matching docs/AUTH_API_CONTRACT.md sections 2-5 ----

// `ok` is typed as plain `boolean` rather than a `true`/`false` literal on
// purpose: this app's tsconfig runs with `strict: false` (no
// strictNullChecks), and under that setting TS does not narrow a
// discriminated union on a boolean-literal discriminant — `if (!result.ok)`
// leaves `result` as the full union, so `.code` reports as missing on the Ok
// branch. Every result below narrows on property PRESENCE instead (`'code'
// in result`, `'retryAfterMs' in result`), which TS narrows correctly
// regardless of strictNullChecks and which also matches the actual wire
// contract better: the failure branches are identified by which fields showed
// up in the JSON body, not by a client-side type tag.

export interface StartAuthOk {
  ok: boolean;
  challenge: string;
  channel: AuthChannel;
  expiresIn: number;
}
export interface AuthFailure {
  ok: boolean;
  code: string;
  message: string;
  retryAfterSeconds?: number;
  /** Present only when code === 'send_failed'. */
  reason?: string;
}
export type StartAuthResult = StartAuthOk | AuthFailure;

export interface VerifyAuthOk {
  ok: boolean;
  session: string;
  expiresIn: number;
}
export interface VerifyNotReady {
  ok: boolean;
  code: 'not_ready';
  retryAfterMs: number;
}
export type VerifyAuthResult = VerifyAuthOk | VerifyNotReady | AuthFailure;

export interface TokenExchangeOk {
  ok: boolean;
  accessToken: string;
  idToken: string;
  expiresIn: number;
}
export type TokenExchangeResult = TokenExchangeOk | AuthFailure;

interface EndpointArgs {
  httpEndpoint: string;
}

// A response the client cannot parse (network failure, non-JSON body, a
// timeout) is not one of the contract's documented codes. Collapsing it into
// `unavailable` is the same "try again" answer the contract gives for its own
// 503s, and it is the one failure mode every caller already knows how to
// show a parent.
const FALLBACK_MESSAGE = 'Sign-in is temporarily unavailable. Please try again in a little while.';
const unavailableFallback = (): AuthFailure => ({ ok: false, code: 'unavailable', message: FALLBACK_MESSAGE });

const postJson = async (url: string, body: unknown): Promise<unknown> => {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => null);
    if (json && typeof json === 'object') return json;
    return unavailableFallback();
  } catch (err) {
    // Never log the destination or the code: only that the network call itself failed.
    console.error('Auth request failed:', err instanceof Error ? err.message : 'unknown');
    return unavailableFallback();
  }
};

/**
 * POST /auth/start. Unauthenticated at the gateway (contract §2): creates the
 * account if the destination is not already registered, and sends exactly one
 * code either way. The response body is byte-identical for a new and an
 * existing destination — this function does not know or care which happened.
 */
export const startAuth = async (
  args: EndpointArgs & { destination: string; turnstileToken?: string; language?: string },
): Promise<StartAuthResult> => {
  const { httpEndpoint, destination, turnstileToken, language } = args;
  const json = await postJson(`${httpEndpoint}auth/start`, {
    destination,
    // Omitted rather than sent as empty/undefined when no widget rendered a
    // token: the server decides whether that is acceptable, not the client
    // (same convention as the old /auth/signup call this replaces).
    ...(turnstileToken ? { turnstileToken } : {}),
    ...(language ? { language } : {}),
  });
  return json as unknown as StartAuthResult;
};

const verifyAuthOnce = async (
  args: EndpointArgs & { challenge: string; code: string },
): Promise<VerifyAuthResult> => {
  const { httpEndpoint, challenge, code } = args;
  const json = await postJson(`${httpEndpoint}auth/verify`, { challenge, code });
  return json as unknown as VerifyAuthResult;
};

/** Retry budget for a 202 not_ready: 6 retries * 500ms = the contract's 3s cap (§3, §13). */
export const MAX_NOT_READY_RETRIES = 6;
const DEFAULT_RETRY_MS = 500;

export const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * POST /auth/verify, transparently retrying a 202 not_ready. `sleep` is
 * injectable so tests can exercise all 7 possible requests without a real 3s
 * wait.
 *
 * Not_ready with no retries left becomes `unavailable` rather than a code the
 * caller has never seen: the contract prescribes this exact fallback (§3).
 */
export const verifyAuth = async (
  args: EndpointArgs & { challenge: string; code: string },
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<VerifyAuthResult> => {
  let result = await verifyAuthOnce(args);
  let retries = 0;
  while ('retryAfterMs' in result && retries < MAX_NOT_READY_RETRIES) {
    await sleep(result.retryAfterMs || DEFAULT_RETRY_MS);
    result = await verifyAuthOnce(args);
    retries += 1;
  }
  if ('retryAfterMs' in result) {
    // Retry budget spent (contract §3): treat it as unavailable rather than
    // surface a state (not_ready) the rest of the app has no handling for.
    return unavailableFallback();
  }
  return result;
};

/** POST /auth/token: exchange the durable session handle for short-lived tokens. */
export const exchangeSession = async (
  args: EndpointArgs & { session: string },
): Promise<TokenExchangeResult> => {
  const json = await postJson(`${args.httpEndpoint}auth/token`, { session: args.session });
  return json as unknown as TokenExchangeResult;
};

/** POST /auth/logout. Always 200 per the contract (§5); best-effort either way. */
export const logoutSession = async (args: EndpointArgs & { session: string }): Promise<void> => {
  await postJson(`${args.httpEndpoint}auth/logout`, { session: args.session });
};

// ---- Persistence: exactly the two durable values the contract names (§6, §8) ----
//
// The challenge handle is harmless to persist (single-use, five-minute life,
// worthless without the code) and doing so is what lets a parent who leaves
// mid-flow — the bottom nav is a route change — come back to the code screen
// instead of a reset form. The session handle is the one value the contract
// says the client stores durably at all.

const CHALLENGE_STORAGE_KEY = 'aiep.auth.challenge';
const SESSION_STORAGE_KEY = 'aiep.auth.session';

export interface PersistedChallenge {
  challenge: string;
  destination: string;
  channel: AuthChannel;
  /** Wall-clock deadline (ms since epoch), computed from expiresIn at start time. */
  expiresAt: number;
}

export const persistChallenge = (value: PersistedChallenge): void => {
  StorageHelper.setItem(CHALLENGE_STORAGE_KEY, JSON.stringify(value));
};

/** Null when there is nothing usable: absent, unparsable, or past its own expiresAt. */
export const readPersistedChallenge = (): PersistedChallenge | null => {
  const raw = StorageHelper.getItem(CHALLENGE_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedChallenge>;
    if (!parsed.challenge || !parsed.destination || !parsed.expiresAt) return null;
    if (Date.now() >= parsed.expiresAt) return null;
    return parsed as PersistedChallenge;
  } catch {
    return null;
  }
};

export const clearPersistedChallenge = (): void => {
  StorageHelper.removeItem(CHALLENGE_STORAGE_KEY);
};

export const persistSessionHandle = (session: string): void => {
  StorageHelper.setItem(SESSION_STORAGE_KEY, session);
};

export const readPersistedSessionHandle = (): string | null => StorageHelper.getItem(SESSION_STORAGE_KEY);

export const clearPersistedSessionHandle = (): void => {
  StorageHelper.removeItem(SESSION_STORAGE_KEY);
};

// ---- In-memory access/ID token cache. NEVER persisted (contract §4: "Keep
// them in memory only. Writing them to localStorage re-creates the thing this
// design exists to remove."). Module-level so it survives this component
// unmounting/remounting within the same page load, but a full reload starts
// clean, which is correct: nothing here claims to solve reload persistence. ----

interface CachedTokens {
  accessToken: string;
  idToken: string;
  expiresAt: number;
}
let cachedTokens: CachedTokens | null = null;

/** Refresh once under this many ms of remaining life, matching the contract's own threshold (§4). */
const REFRESH_THRESHOLD_MS = 300_000;

export const setCachedTokens = (tokens: { accessToken: string; idToken: string; expiresIn: number }): void => {
  cachedTokens = {
    accessToken: tokens.accessToken,
    idToken: tokens.idToken,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
  };
};

/** The cached ID token, or null if there is none or it is due for a refresh. */
export const getCachedIdToken = (): string | null => {
  if (!cachedTokens) return null;
  if (cachedTokens.expiresAt - Date.now() < REFRESH_THRESHOLD_MS) return null;
  return cachedTokens.idToken;
};

export const clearCachedTokens = (): void => {
  cachedTokens = null;
};

// ---- Copy: map the contract's `code` (never `message`, per §9 and the
// contract's repeated instruction) to a translation key. Unrecognised codes
// fall back to the app's existing generic error key rather than showing
// nothing or a raw code. ----

const ERROR_KEYS: Record<string, string> = {
  invalid_request: 'auth.error.invalidRequest',
  invalid_destination: 'auth.error.invalidDestination',
  unsupported_destination: 'auth.error.unsupportedDestination',
  bot_check_failed: 'auth.error.botCheckFailed',
  rate_limited: 'auth.error.rateLimited',
  unavailable: 'auth.error.unavailable',
  bad_code: 'auth.error.badCode',
  too_many_codes: 'auth.error.tooManyCodes',
  session_invalid: 'auth.error.sessionInvalid',
};

const SEND_FAILED_REASON_KEYS: Record<string, string> = {
  unsupported_destination: 'auth.error.sendFailed.unsupportedDestination',
  budget_exhausted: 'auth.error.sendFailed.budgetExhausted',
  rate_limited: 'auth.error.sendFailed.rateLimited',
  delivery_failed: 'auth.error.sendFailed.deliveryFailed',
};

export const authErrorKey = (code: string, reason?: string): string => {
  if (code === 'send_failed') {
    return (reason && SEND_FAILED_REASON_KEYS[reason]) || 'auth.errorGeneric';
  }
  return ERROR_KEYS[code] || 'auth.errorGeneric';
};
