import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppContext } from '../app-context';

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SCRIPT_ID = 'cf-turnstile';

/**
 * How many times a parent may ask for a fresh challenge from the timeout
 * message. Turnstile already retries on its own (`retry` and `refresh-timeout`
 * both default to `auto`), so this caps the button, not the widget.
 */
const MAX_RETRIES = 3;

interface TurnstileApi {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/**
 * Where the check has got to, as one value rather than five booleans that can
 * contradict each other.
 *
 * Every one of these except `idle` is something a parent needs told. Before
 * 2026-09-10 the app reacted to exactly one of them (`failed`), so a challenge
 * that went interactive and was never solved produced no widget state, no
 * message and no error: the parent submitted, the endpoint returned 403, and
 * they read a generic failure with no cause.
 */
export type TurnstileStatus =
  /** No widget on the page yet. */
  | 'idle'
  /** Rendered and running. Nothing is required of the parent. */
  | 'ready'
  /** The challenge wants the parent to do something. */
  | 'interactive'
  /** A token is in hand. */
  | 'solved'
  /** The token aged out. Turnstile will usually re-challenge on its own. */
  | 'expired'
  /** It went interactive and was never solved. */
  | 'timedOut'
  /** The widget was torn down, so the token went with it. */
  | 'reset'
  /** It could not load or run at all. */
  | 'failed';

interface TurnstileState {
  /** Attach to the element the widget should render into. */
  containerRef: (node: HTMLDivElement | null) => void;
  /** The current token, or null when there is nothing to send. */
  token: string | null;
  /** True when a key is configured, i.e. when a widget will appear at all. */
  isEnabled: boolean;
  /** Where the check has got to. Drives everything a parent is told. */
  status: TurnstileStatus;
  /** True when the widget could not load or run at all. */
  hasFailed: boolean;
  /** Discard the current token and ask for a fresh one. */
  reset: () => void;
  /** Parent-initiated retry from the timeout message. Capped. */
  retry: () => void;
  /** False once the retry cap is spent, so the caller can stop offering it. */
  canRetry: boolean;
}

/**
 * Cloudflare Turnstile for the signup path.
 *
 * This is the visible half of an anti-abuse control whose enforcing half lives
 * in the signup endpoint. The order matters: the endpoint refuses a signup
 * without a valid token, and this only supplies one. Nothing here is a
 * security boundary, because the 2026-09-09 abuse run never loaded the site
 * at all: it called the public SignUp API directly, where no browser code of
 * ours runs.
 *
 * No key configured means no widget and no token. That is the local-dev and
 * not-yet-rolled-out state, and it is safe precisely because the decision to
 * accept an unverified signup is made on the server, not here.
 *
 * **The widget is mounted inside ONE tab of the login form, so it attaches and
 * detaches as a parent switches between Phone and Email.** That is why this
 * hook keys off the DOM node through a callback ref instead of a
 * useEffect over the site key. The first version used a plain ref and cached
 * the widget id forever: switching to Email unmounted the container, switching
 * back re-created a bare div, and the render was skipped because the cached id
 * said a widget already existed. The widget was gone for the rest of the page's
 * life, so `token` stayed null and every signup was refused server-side with a
 * 403 the parent could do nothing about. A callback ref runs on attach AND on
 * detach, which is exactly the lifecycle this needs.
 *
 * Tokens are single-use and expire, so `reset` exists for the retry paths: a
 * second signup attempt with a spent token is refused, which would look to a
 * parent like the form silently breaking.
 *
 * `language` is the APP's language, not the browser's. Turnstile defaults to
 * `auto`, which follows the browser, so a parent who picked Vietnamese in
 * A-IEP on an English-locale phone was handed an English challenge — the one
 * population least able to get past it. Passed as an argument rather than read
 * from useLanguage() so the hook stays usable without a LanguageProvider.
 */
export const useTurnstile = (language?: string): TurnstileState => {
  const appConfig = useContext(AppContext);
  const siteKey = appConfig?.turnstileSiteKey;
  const widgetIdRef = useRef<string | null>(null);
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<TurnstileStatus>('idle');
  const [retriesLeft, setRetriesLeft] = useState(MAX_RETRIES);

  const renderWidget = useCallback(() => {
    if (!siteKey || !window.turnstile || !nodeRef.current || widgetIdRef.current) {
      return;
    }
    widgetIdRef.current = window.turnstile.render(nodeRef.current, {
      sitekey: siteKey,
      // Without this Turnstile uses `auto`, i.e. the browser's language.
      ...(language ? { language } : {}),
      callback: (value: string) => {
        setToken(value);
        setStatus('solved');
      },
      // A token that has expired or errored is worse than none: it would be
      // sent and refused. Clearing it lets the caller notice and reset.
      'expired-callback': () => {
        setToken(null);
        setStatus('expired');
      },
      'error-callback': () => {
        setToken(null);
        setStatus('failed');
      },
      // The four below were unsubscribed until 2026-09-10, which is why an
      // interactive challenge a parent could not operate showed them nothing.
      'before-interactive-callback': () => setStatus('interactive'),
      // May arrive either side of `callback`, so it must not clobber `solved`.
      'after-interactive-callback': () =>
        setStatus((current) => (current === 'interactive' ? 'ready' : current)),
      'timeout-callback': () => {
        setToken(null);
        setStatus('timedOut');
      },
      'unsupported-callback': () => {
        setToken(null);
        setStatus('failed');
      },
    });
    // A widget exists now. This also clears a stale `failed` from a previous
    // attach: without it, one transient error left the warning on screen and
    // re-announced it on every switch back to the phone tab.
    setStatus('ready');
  }, [siteKey, language]);

  const containerRef = useCallback((node: HTMLDivElement | null) => {
    if (node === null) {
      // Detached: the parent switched tabs, or the form unmounted. Tell
      // Turnstile to drop the widget and forget its id, so the next attach
      // renders a fresh one rather than being skipped by the guard above.
      if (window.turnstile && widgetIdRef.current) {
        window.turnstile.remove(widgetIdRef.current);
      }
      widgetIdRef.current = null;
      nodeRef.current = null;
      // The token belonged to a widget that no longer exists.
      setToken(null);
      // Discarding it is right; doing it silently is not. A parent who had
      // passed the check, tapped WITH EMAIL and came back was unverified with
      // no notice. Only `solved` is worth saying out loud — announcing a reset
      // to someone who had not passed yet is noise.
      setStatus((current) => (current === 'solved' ? 'reset' : 'idle'));
      return;
    }
    nodeRef.current = node;
    renderWidget();
  }, [renderWidget]);

  useEffect(() => {
    if (!siteKey) {
      return;
    }
    let cancelled = false;
    const onLoad = () => {
      if (!cancelled) {
        renderWidget();
      }
    };
    // A parent on a network or extension that blocks challenges.cloudflare.com
    // gets no widget and no token, and the server refuses the signup. Without
    // this they would read a generic error and retry forever; the caller uses
    // hasFailed to say something they can act on.
    const onError = () => {
      if (!cancelled) {
        setStatus('failed');
      }
    };

    const existing = document.getElementById(SCRIPT_ID);
    if (window.turnstile) {
      renderWidget();
    } else if (existing) {
      existing.addEventListener('load', onLoad);
      existing.addEventListener('error', onError);
    } else {
      const script = document.createElement('script');
      script.id = SCRIPT_ID;
      script.src = SCRIPT_URL;
      script.async = true;
      script.defer = true;
      script.addEventListener('load', onLoad);
      script.addEventListener('error', onError);
      document.head.appendChild(script);
    }

    return () => {
      cancelled = true;
    };
  }, [siteKey, renderWidget]);

  const reset = useCallback(() => {
    setToken(null);
    if (window.turnstile && widgetIdRef.current) {
      window.turnstile.reset(widgetIdRef.current);
      setStatus('ready');
    }
  }, []);

  /**
   * The parent asked for a fresh challenge after one timed out.
   *
   * Capped deliberately. The abuse we have seen bypassed the browser entirely,
   * so a retry button is not the control that stops it — but an uncapped one
   * is still a free in-page challenge loop, and this costs one ref to avoid.
   * Spending the cap falls through to `failed`, which already tells the parent
   * something they can act on rather than leaving a dead button.
   */
  const retry = useCallback(() => {
    if (retriesLeft <= 0) {
      setStatus('failed');
      return;
    }
    setRetriesLeft(retriesLeft - 1);
    reset();
  }, [retriesLeft, reset]);

  return {
    containerRef,
    token,
    isEnabled: Boolean(siteKey),
    status,
    hasFailed: status === 'failed',
    reset,
    retry,
    canRetry: retriesLeft > 0,
  };
};
