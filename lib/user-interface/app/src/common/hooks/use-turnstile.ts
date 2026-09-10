import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppContext } from '../app-context';

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SCRIPT_ID = 'cf-turnstile';

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

interface TurnstileState {
  /** Attach to the element the widget should render into. */
  containerRef: (node: HTMLDivElement | null) => void;
  /** The current token, or null when there is nothing to send. */
  token: string | null;
  /** True when a key is configured, i.e. when a widget will appear at all. */
  isEnabled: boolean;
  /** True when the widget could not load or run at all. */
  hasFailed: boolean;
  /** Discard the current token and ask for a fresh one. */
  reset: () => void;
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
 */
export const useTurnstile = (): TurnstileState => {
  const appConfig = useContext(AppContext);
  const siteKey = appConfig?.turnstileSiteKey;
  const widgetIdRef = useRef<string | null>(null);
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [hasFailed, setHasFailed] = useState(false);

  const renderWidget = useCallback(() => {
    if (!siteKey || !window.turnstile || !nodeRef.current || widgetIdRef.current) {
      return;
    }
    widgetIdRef.current = window.turnstile.render(nodeRef.current, {
      sitekey: siteKey,
      callback: (value: string) => {
        setHasFailed(false);
        setToken(value);
      },
      // A token that has expired or errored is worse than none: it would be
      // sent and refused. Clearing it lets the caller notice and reset.
      'expired-callback': () => setToken(null),
      'error-callback': () => {
        setToken(null);
        setHasFailed(true);
      },
    });
  }, [siteKey]);

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
        setHasFailed(true);
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
    }
  }, []);

  return { containerRef, token, isEnabled: Boolean(siteKey), hasFailed, reset };
};
