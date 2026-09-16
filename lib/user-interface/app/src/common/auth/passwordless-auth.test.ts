/**
 * Unit coverage for the pure client side of docs/AUTH_API_CONTRACT.md:
 * request shapes, the 202 not_ready retry budget, the two pieces of durable
 * storage, and the code -> translation-key map. No DOM here — the same
 * behaviour driven through the real component lives in
 * CustomLogin.test.tsx and PasswordlessAuthForm is exercised through it.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  MAX_NOT_READY_RETRIES,
  authErrorKey,
  clearCachedTokens,
  clearPersistedChallenge,
  clearPersistedSessionHandle,
  exchangeSession,
  getCachedIdToken,
  logoutSession,
  persistChallenge,
  persistSessionHandle,
  readPersistedChallenge,
  readPersistedSessionHandle,
  SESSION_INVALID_EVENT,
  configureSessionRefresh,
  needsRenewal,
  persistSessionHandle as persistHandle,
  renewIdToken,
  setCachedTokens,
  startAuth,
  verifyAuth,
} from './passwordless-auth';

const HTTP_ENDPOINT = 'https://api.example.test/';

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

beforeEach(() => {
  localStorage.clear();
  clearCachedTokens();
  configureSessionRefresh(null);
});

describe('startAuth', () => {
  test('posts destination, turnstileToken and language to /auth/start', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, challenge: 'c1', channel: 'sms', expiresIn: 300 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await startAuth({
      httpEndpoint: HTTP_ENDPOINT,
      destination: '+15551234567',
      turnstileToken: 'tok-abc',
      language: 'es',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.example.test/auth/start');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      destination: '+15551234567',
      turnstileToken: 'tok-abc',
      language: 'es',
    });
    expect(result).toMatchObject({ challenge: 'c1', channel: 'sms' });
    vi.unstubAllGlobals();
  });

  test('omits turnstileToken entirely rather than sending it empty when none was produced', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, challenge: 'c1', channel: 'email', expiresIn: 300 }));
    vi.stubGlobal('fetch', fetchMock);

    await startAuth({ httpEndpoint: HTTP_ENDPOINT, destination: 'a@example.com' });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect('turnstileToken' in body).toBe(false);
    expect('language' in body).toBe(false);
    vi.unstubAllGlobals();
  });

  test('a network failure becomes the unavailable code, not an uncaught rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const result = await startAuth({ httpEndpoint: HTTP_ENDPOINT, destination: '+15551234567' });

    expect(result).toMatchObject({ ok: false, code: 'unavailable' });
    vi.unstubAllGlobals();
  });
});

describe('verifyAuth retry on 202 not_ready', () => {
  const sleepSpy = () => vi.fn().mockResolvedValue(undefined);

  test('retries with the server-given retryAfterMs and succeeds once the code is ready', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(202, { ok: false, code: 'not_ready', retryAfterMs: 750 }))
      .mockResolvedValueOnce(jsonResponse(202, { ok: false, code: 'not_ready', retryAfterMs: 750 }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, session: 's1', expiresIn: 2592000 }));
    vi.stubGlobal('fetch', fetchMock);
    const sleep = sleepSpy();

    const result = await verifyAuth({ httpEndpoint: HTTP_ENDPOINT, challenge: 'c1', code: '123456' }, sleep);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(750);
    expect(result).toMatchObject({ session: 's1' });
    vi.unstubAllGlobals();
  });

  test('gives up after exactly 6 retries (7 requests total) and reports unavailable, not not_ready', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(202, { ok: false, code: 'not_ready', retryAfterMs: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const sleep = sleepSpy();

    const result = await verifyAuth({ httpEndpoint: HTTP_ENDPOINT, challenge: 'c1', code: '123456' }, sleep);

    expect(fetchMock).toHaveBeenCalledTimes(MAX_NOT_READY_RETRIES + 1);
    expect(sleep).toHaveBeenCalledTimes(MAX_NOT_READY_RETRIES);
    expect(result).toMatchObject({ code: 'unavailable' });
    // The caller must never see the raw not_ready code once the budget is spent:
    // there is no translation key for it and it has no UI meaning past this point.
    expect((result as { code: string }).code).not.toBe('not_ready');
    vi.unstubAllGlobals();
  });

  test('defaults the wait to 500ms if the server sends a falsy retryAfterMs', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(202, { ok: false, code: 'not_ready', retryAfterMs: 0 }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, session: 's1', expiresIn: 2592000 }));
    vi.stubGlobal('fetch', fetchMock);
    const sleep = sleepSpy();

    await verifyAuth({ httpEndpoint: HTTP_ENDPOINT, challenge: 'c1', code: '123456' }, sleep);

    expect(sleep).toHaveBeenCalledWith(500);
    vi.unstubAllGlobals();
  });

  test('a bad_code answer is returned immediately, with no retry and no extra request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, { ok: false, code: 'bad_code', message: 'nope' }));
    vi.stubGlobal('fetch', fetchMock);
    const sleep = sleepSpy();

    const result = await verifyAuth({ httpEndpoint: HTTP_ENDPOINT, challenge: 'c1', code: '000000' }, sleep);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(result).toMatchObject({ code: 'bad_code' });
    vi.unstubAllGlobals();
  });
});

describe('exchangeSession and logoutSession', () => {
  test('exchangeSession posts only the session handle', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, accessToken: 'a', idToken: 'i', expiresIn: 3600 }));
    vi.stubGlobal('fetch', fetchMock);

    await exchangeSession({ httpEndpoint: HTTP_ENDPOINT, session: 's1' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.example.test/auth/token');
    expect(JSON.parse(init.body)).toEqual({ session: 's1' });
    vi.unstubAllGlobals();
  });

  test('logoutSession posts to /auth/logout and never throws even if the network call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(logoutSession({ httpEndpoint: HTTP_ENDPOINT, session: 's1' })).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe('persisted challenge handle', () => {
  test('round-trips through storage', () => {
    persistChallenge({ challenge: 'c1', destination: '+15551234567', channel: 'sms', expiresAt: Date.now() + 60_000 });
    expect(readPersistedChallenge()).toMatchObject({ challenge: 'c1', destination: '+15551234567' });
    clearPersistedChallenge();
    expect(readPersistedChallenge()).toBeNull();
  });

  test('an expired challenge is never resumed', () => {
    persistChallenge({ challenge: 'c1', destination: '+15551234567', channel: 'sms', expiresAt: Date.now() - 1 });
    expect(readPersistedChallenge()).toBeNull();
  });

  test('unparsable storage is treated as absent, not thrown', () => {
    localStorage.setItem('aiep.auth.challenge', '{not json');
    expect(readPersistedChallenge()).toBeNull();
  });
});

describe('persisted session handle', () => {
  test('round-trips through storage', () => {
    persistSessionHandle('sess-123');
    expect(readPersistedSessionHandle()).toBe('sess-123');
    clearPersistedSessionHandle();
    expect(readPersistedSessionHandle()).toBeNull();
  });
});

describe('in-memory token cache', () => {
  test('is empty until a successful exchange sets it', () => {
    expect(getCachedIdToken()).toBeNull();
  });

  test('returns the cached ID token while comfortably unexpired', () => {
    setCachedTokens({ accessToken: 'a', idToken: 'i', expiresIn: 3600 });
    expect(getCachedIdToken()).toBe('i');
  });

  test('reports null once inside the 5-minute refresh window, not just after literal expiry', () => {
    setCachedTokens({ accessToken: 'a', idToken: 'i', expiresIn: 200 }); // < 300s left
    expect(getCachedIdToken()).toBeNull();
  });

  test('clearCachedTokens removes it', () => {
    setCachedTokens({ accessToken: 'a', idToken: 'i', expiresIn: 3600 });
    clearCachedTokens();
    expect(getCachedIdToken()).toBeNull();
  });
});

describe('authErrorKey: branch on code, never on message', () => {
  test.each([
    ['invalid_request', 'auth.error.invalidRequest'],
    ['invalid_destination', 'auth.error.invalidDestination'],
    ['unsupported_destination', 'auth.error.unsupportedDestination'],
    ['bot_check_failed', 'auth.error.botCheckFailed'],
    ['rate_limited', 'auth.error.rateLimited'],
    ['unavailable', 'auth.error.unavailable'],
    ['bad_code', 'auth.error.badCode'],
    ['too_many_codes', 'auth.error.tooManyCodes'],
    ['session_invalid', 'auth.error.sessionInvalid'],
  ])('%s -> %s', (code, key) => {
    expect(authErrorKey(code)).toBe(key);
  });

  test.each([
    ['unsupported_destination', 'auth.error.sendFailed.unsupportedDestination'],
    ['budget_exhausted', 'auth.error.sendFailed.budgetExhausted'],
    ['rate_limited', 'auth.error.sendFailed.rateLimited'],
    ['delivery_failed', 'auth.error.sendFailed.deliveryFailed'],
  ])('send_failed reason %s -> %s', (reason, key) => {
    expect(authErrorKey('send_failed', reason)).toBe(key);
  });

  test('an unrecognised code falls back to the app-wide generic key rather than nothing', () => {
    expect(authErrorKey('some_future_code_this_client_has_never_seen')).toBe('auth.errorGeneric');
  });

  test('send_failed with no reason, or a reason this client does not know, also falls back safely', () => {
    expect(authErrorKey('send_failed')).toBe('auth.errorGeneric');
    expect(authErrorKey('send_failed', 'something_new')).toBe('auth.errorGeneric');
  });

  // The contract is explicit that `message` must never drive client logic —
  // it is English-only and a fallback for a code the client has not seen.
  // authErrorKey's signature enforces this structurally: it takes a code (and
  // a reason), never a message, so there is no argument position from which a
  // caller could even start branching on message text.
  test('the mapper has no parameter through which a message string could be consulted', () => {
    expect(authErrorKey.length).toBeLessThanOrEqual(2);
  });
});

/**
 * Renewing the in-memory tokens from the durable session handle.
 *
 * The defect this closes, reported by a tester on staging: the name step left
 * open, come back later, and the first thing they touched showed "Service
 * unavailable" with a Try Again that could never work. The tokens last an
 * hour and live in memory; the handle beside them lasts far longer, so that
 * parent was still signed in. A page RELOAD already recovered (see
 * auth-provider's resumePasswordlessSession) -- a tab that stayed open did
 * not, because nothing re-exchanged without a mount, and Utils.authenticate
 * fell through to an Amplify session this flow deliberately never creates.
 *
 * The rule that keeps it safe is the contract's (§4): a 401 session_invalid
 * is the only answer that proves the handle is dead. Anything else leaves it
 * alone, because throwing away a good handle signs a parent out for a blip.
 */
describe('renewIdToken', () => {
  const HANDLE = 'sess-handle-1';
  const FRESH = { ok: true, accessToken: 'access-2', idToken: 'id-2', expiresIn: 3600 };

  const ready = () => {
    persistHandle(HANDLE);
    configureSessionRefresh(HTTP_ENDPOINT);
  };

  test('exchanges the persisted handle and returns the new ID token', async () => {
    ready();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, FRESH));
    vi.stubGlobal('fetch', fetchMock);

    expect(await renewIdToken()).toBe('id-2');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.example.test/auth/token');
    expect(JSON.parse(init.body)).toEqual({ session: HANDLE });
  });

  test('caches what it got, so the next call costs no request', async () => {
    ready();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, FRESH));
    vi.stubGlobal('fetch', fetchMock);

    await renewIdToken();

    expect(getCachedIdToken()).toBe('id-2');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('one exchange for several concurrent callers, not one each', async () => {
    // The summary page fires several requests at once and every one of them
    // calls authenticate(). Without the single-flight they would race to
    // overwrite each other's tokens.
    ready();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, FRESH));
    vi.stubGlobal('fetch', fetchMock);

    const results = await Promise.all([renewIdToken(), renewIdToken(), renewIdToken()]);

    expect(results).toEqual(['id-2', 'id-2', 'id-2']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a dead handle is cleared and announced', async () => {
    ready();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse(401, { ok: false, code: 'session_invalid', message: 'gone' }),
    ));
    const heard = vi.fn();
    window.addEventListener(SESSION_INVALID_EVENT, heard);

    expect(await renewIdToken()).toBeNull();

    // Cleared, so a reload cannot resume it either, and announced, so
    // AuthProvider drops `authenticated` and ProtectedRoute redirects.
    expect(readPersistedSessionHandle()).toBeNull();
    expect(getCachedIdToken()).toBeNull();
    expect(heard).toHaveBeenCalledTimes(1);

    window.removeEventListener(SESSION_INVALID_EVENT, heard);
  });

  test.each([
    ['a 503', 503, { ok: false, code: 'unavailable', message: 'later' }],
    ['a code this client has never seen', 400, { ok: false, code: 'something_new', message: '?' }],
  ])('keeps the handle through %s, which proves nothing', async (_label, status, body) => {
    ready();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(status, body)));
    const heard = vi.fn();
    window.addEventListener(SESSION_INVALID_EVENT, heard);

    expect(await renewIdToken()).toBeNull();

    // The parent stays signed in and the next attempt can still work.
    expect(readPersistedSessionHandle()).toBe(HANDLE);
    expect(heard).not.toHaveBeenCalled();

    window.removeEventListener(SESSION_INVALID_EVENT, heard);
  });

  test('keeps the handle through a network failure', async () => {
    ready();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    expect(await renewIdToken()).toBeNull();
    expect(readPersistedSessionHandle()).toBe(HANDLE);
  });

  test('is a no-op with nothing to renew from', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    configureSessionRefresh(HTTP_ENDPOINT);
    expect(await renewIdToken()).toBeNull();

    persistHandle(HANDLE);
    configureSessionRefresh(null);
    expect(await renewIdToken()).toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('never throws, whatever the endpoint does', async () => {
    // Every caller treats null as "no token" and falls through. A throw here
    // would surface as an unhandled rejection inside an api client instead.
    ready();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => { throw new Error('not json'); },
    }));

    await expect(renewIdToken()).resolves.toBeNull();
  });
});

describe('needsRenewal', () => {
  test('is false with no handle, whatever the cache says', () => {
    expect(needsRenewal()).toBe(false);
  });

  test('is true once the cache is cold and a handle is there', () => {
    persistSessionHandle('sess-1');

    expect(needsRenewal()).toBe(true);
  });

  test('is false while the cached token still has life in it', () => {
    // What keeps the tab-focus check free: an ordinary tab switch makes no
    // network call at all.
    persistSessionHandle('sess-1');
    setCachedTokens({ accessToken: 'a', idToken: 'i', expiresIn: 3600 });

    expect(needsRenewal()).toBe(false);
  });

  test('is true again once the cached token is inside the refresh threshold', () => {
    persistSessionHandle('sess-1');
    setCachedTokens({ accessToken: 'a', idToken: 'i', expiresIn: 60 });

    expect(needsRenewal()).toBe(true);
  });
});
