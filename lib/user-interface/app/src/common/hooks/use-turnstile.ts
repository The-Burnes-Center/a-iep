import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppContext } from '../app-context';

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SCRIPT_ID = 'cf-turnstile';

interface TurnstileApi {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  reset: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

interface TurnstileState {
  /** Attach to the element the widget should render into. */
  containerRef: React.RefObject<HTMLDivElement>;
  /** The current token, or null when there is nothing to send. */
  token: string | null;
  /** True when a key is configured, i.e. when a widget will appear at all. */
  isEnabled: boolean;
  /** Discard the current token and ask for a fresh one. */
  reset: () => void;
}

/**
 * Cloudflare Turnstile for the signup path.
 *
 * This is the visible half of an anti-abuse control whose enforcing half lives
 * in the PreSignUp trigger. The order matters: the trigger refuses a signup
 * without a valid token, and this only supplies one. Nothing here is a
 * security boundary, because the 2026-09-09 abuse run never loaded the site
 * at all: it called the public SignUp API directly, where no browser code of
 * ours runs.
 *
 * No key configured means no widget and no token. That is the local-dev and
 * not-yet-rolled-out state, and it is safe precisely because the decision to
 * accept an unverified signup is made on the server, not here.
 *
 * Tokens are single-use and expire, so `reset` exists for the retry paths: a
 * second signup attempt with a spent token is refused, which would look to a
 * parent like the form silently breaking.
 */
export const useTurnstile = (): TurnstileState => {
  const appConfig = useContext(AppContext);
  const siteKey = appConfig?.turnstileSiteKey;
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    if (!siteKey || !containerRef.current) {
      return;
    }
    let cancelled = false;

    const renderWidget = () => {
      // Guard every re-entry: React may run this twice in StrictMode, and a
      // second render into the same node produces two widgets.
      if (cancelled || !window.turnstile || !containerRef.current || widgetIdRef.current) {
        return;
      }
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        callback: (value: string) => setToken(value),
        // A token that has expired or errored is worse than none: it would be
        // sent and refused. Clearing it lets the caller notice and reset.
        'expired-callback': () => setToken(null),
        'error-callback': () => setToken(null),
      });
    };

    const existing = document.getElementById(SCRIPT_ID);
    if (window.turnstile) {
      renderWidget();
    } else if (existing) {
      existing.addEventListener('load', renderWidget);
    } else {
      const script = document.createElement('script');
      script.id = SCRIPT_ID;
      script.src = SCRIPT_URL;
      script.async = true;
      script.defer = true;
      script.addEventListener('load', renderWidget);
      document.head.appendChild(script);
    }

    return () => {
      cancelled = true;
    };
  }, [siteKey]);

  const reset = useCallback(() => {
    setToken(null);
    if (window.turnstile && widgetIdRef.current) {
      window.turnstile.reset(widgetIdRef.current);
    }
  }, []);

  return { containerRef, token, isEnabled: Boolean(siteKey), reset };
};
