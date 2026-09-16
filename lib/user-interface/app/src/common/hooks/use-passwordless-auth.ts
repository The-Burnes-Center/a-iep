import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AuthChannel,
  authErrorKey,
  clearCachedTokens,
  clearPersistedChallenge,
  clearPersistedSessionHandle,
  exchangeSession,
  persistChallenge,
  persistSessionHandle,
  readPersistedChallenge,
  setCachedTokens,
  startAuth,
  verifyAuth,
} from '../auth/passwordless-auth';

export type PasswordlessStep = 'idle' | 'awaiting_code' | 'locked_out';

/**
 * Cognito allows three wrong answers per challenge, and the third one ends it
 * silently — every later request with that handle returns bad_code for a
 * different reason the client cannot tell apart (contract §3). Budgeting two
 * retries in the UI (three submissions total) and then forcing a fresh start
 * matches that budget instead of letting a parent hit a dead handle on a
 * fourth try.
 */
const MAX_CODE_ATTEMPTS = 3;

/** What a 429 without a `retryAfterSeconds` of its own is treated as. */
const DEFAULT_LOCKOUT_SECONDS = 60;

interface UsePasswordlessAuthArgs {
  httpEndpoint: string;
  language?: string;
  /** Called once /auth/token has produced a usable ID token. */
  onSignedIn: () => void;
}

interface UsePasswordlessAuthState {
  step: PasswordlessStep;
  destination: string;
  channel: AuthChannel;
  /** A translation key (never raw text — see auth-error.ts), or null. */
  error: string | null;
  loading: boolean;
  /** Minutes until a locked_out parent can try again. Only meaningful in that step. */
  lockedMinutes: number;
  /**
   * When the code the parent is waiting on was sent (ms since epoch), 0 when
   * none has been. Survives an unmount, because it is read back off the
   * persisted challenge, which is what makes a resend cooldown built on it
   * survive one too.
   */
  lastCodeSentAt: number;
  start: (destination: string, turnstileToken?: string) => Promise<boolean>;
  submitCode: (code: string) => Promise<void>;
  /** Abandon the current challenge (or lockout) and go back to the identifier screen. */
  backToStart: () => void;
}

/**
 * The client-visible state machine in docs/AUTH_API_CONTRACT.md §8:
 * idle -> awaiting_code -> (locked_out | signed_in), plus the token exchange.
 *
 * Resuming a challenge left mid-flow is computed in the initial useState, not
 * an effect, so the very first render already reflects it — the bottom nav is
 * a route change, so leaving this page unmounts it, and a parent holding a
 * code in their hand must never see the identifier screen again on return.
 */
export const usePasswordlessAuth = ({
  httpEndpoint,
  language,
  onSignedIn,
}: UsePasswordlessAuthArgs): UsePasswordlessAuthState => {
  const [resumed] = useState(() => readPersistedChallenge());
  const [step, setStep] = useState<PasswordlessStep>(resumed ? 'awaiting_code' : 'idle');
  const [destination, setDestination] = useState(resumed?.destination ?? '');
  const [channel, setChannel] = useState<AuthChannel>(resumed?.channel ?? 'sms');
  const [challenge, setChallenge] = useState<string | null>(resumed?.challenge ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lockedMinutes, setLockedMinutes] = useState(0);
  const [lastCodeSentAt, setLastCodeSentAt] = useState(resumed?.sentAt ?? 0);
  const attemptsRef = useRef(0);
  const lockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (lockTimerRef.current) clearTimeout(lockTimerRef.current);
  }, []);

  /**
   * The destination may not be sent another code for a while: park the parent
   * on the lockout screen with the wait, and drop them back at the start once
   * it is over. Shared by both endpoints that can say so, so a lockout looks
   * the same however it was reached.
   *
   * The handle goes with it. Its own life is 300 s (contract §13) and every
   * lockout window is longer than that, so there is never a code still worth
   * holding on to by the time the screen comes back.
   */
  const enterLockout = useCallback((retryAfterSeconds?: number) => {
    clearPersistedChallenge();
    const seconds = retryAfterSeconds ?? DEFAULT_LOCKOUT_SECONDS;
    setLockedMinutes(Math.ceil(seconds / 60));
    setStep('locked_out');
    if (lockTimerRef.current) clearTimeout(lockTimerRef.current);
    lockTimerRef.current = setTimeout(() => {
      setChallenge(null);
      setError(null);
      setStep('idle');
    }, seconds * 1000);
  }, []);

  const start = useCallback(async (dest: string, turnstileToken?: string): Promise<boolean> => {
    setLoading(true);
    setError(null);
    const result = await startAuth({ httpEndpoint, destination: dest, turnstileToken, language });
    setLoading(false);

    // Narrowed on property presence, not on `result.ok` — see the comment in
    // passwordless-auth.ts on why a boolean-literal discriminant does not
    // narrow under this app's tsconfig (strict: false).
    if ('code' in result) {
      // Route into the same lockout the code screen uses rather than the
      // plain error channel. `auth.error.tooManyCodes` carries a {minutes}
      // placeholder, and only the lockout screen has a number to put in it:
      // shown as an ordinary error it reaches a parent with the braces still
      // in the sentence.
      if (result.code === 'too_many_codes') {
        enterLockout(result.retryAfterSeconds);
        return false;
      }
      setError(authErrorKey(result.code));
      return false;
    }

    const sentAt = Date.now();
    attemptsRef.current = 0;
    setDestination(dest);
    setChannel(result.channel);
    setChallenge(result.challenge);
    setLastCodeSentAt(sentAt);
    persistChallenge({
      challenge: result.challenge,
      destination: dest,
      channel: result.channel,
      expiresAt: sentAt + result.expiresIn * 1000,
      sentAt,
    });
    setStep('awaiting_code');
    return true;
  }, [httpEndpoint, language, enterLockout]);

  const backToStart = useCallback(() => {
    if (lockTimerRef.current) {
      clearTimeout(lockTimerRef.current);
      lockTimerRef.current = null;
    }
    clearPersistedChallenge();
    attemptsRef.current = 0;
    setChallenge(null);
    setError(null);
    setStep('idle');
  }, []);

  const submitCode = useCallback(async (code: string): Promise<void> => {
    if (!challenge) {
      // The challenge handle only lives in memory plus localStorage; getting
      // here with none means it expired or was cleared out from under this
      // call. Send the parent back rather than post a request with no handle.
      setError('auth.errorSessionExpired');
      setStep('idle');
      return;
    }

    setLoading(true);
    setError(null);
    const result = await verifyAuth({ httpEndpoint, challenge, code });

    if ('session' in result) {
      persistSessionHandle(result.session);
      clearPersistedChallenge();

      const tokens = await exchangeSession({ httpEndpoint, session: result.session });
      setLoading(false);

      if ('accessToken' in tokens) {
        setCachedTokens(tokens);
        setStep('idle');
        onSignedIn();
        return;
      }

      // session_invalid this soon after verify is not expected, but the
      // contract's own rule holds regardless: 401 means sign in again (§4).
      clearPersistedSessionHandle();
      clearCachedTokens();
      setChallenge(null);
      setError(authErrorKey(tokens.code));
      setStep('idle');
      return;
    }

    setLoading(false);

    if (result.code === 'bad_code') {
      attemptsRef.current += 1;
      if (attemptsRef.current >= MAX_CODE_ATTEMPTS) {
        clearPersistedChallenge();
        setChallenge(null);
        setError('auth.errorSessionExpired');
        setStep('idle');
        return;
      }
      setError(authErrorKey(result.code));
      return; // Stay on awaiting_code with the same challenge; let them retype.
    }

    if (result.code === 'too_many_codes') {
      enterLockout(result.retryAfterSeconds);
      return;
    }

    if (result.code === 'send_failed') {
      // Terminal for this handle (contract §3): back to the start screen.
      clearPersistedChallenge();
      setChallenge(null);
      setError(authErrorKey(result.code, result.reason));
      setStep('idle');
      return;
    }

    // unavailable, including a not_ready retry budget that ran out: the
    // handle is still good, so keep the parent on the code screen.
    setError(authErrorKey(result.code));
  }, [challenge, httpEndpoint, onSignedIn, enterLockout]);

  return {
    step, destination, channel, error, loading, lockedMinutes, lastCodeSentAt,
    start, submitCode, backToStart,
  };
};
