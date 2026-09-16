/**
 * The Turnstile widget's lifecycle, which is a login-availability concern
 * rather than a cosmetic one.
 *
 * The widget is mounted inside ONE tab of the login form. Once the signup
 * endpoint enforces the token (it does, from 2026-09-10), a parent who cannot
 * produce one is refused with a 403 they can do nothing about. So "the widget
 * comes back after switching tabs" is the difference between being able to
 * create an account and not.
 */
import { render, screen, act } from '@testing-library/react';
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { useTurnstile } from './use-turnstile';
import { AppContext } from '../app-context';

// Any non-empty value: this exercises the widget lifecycle, not
// Cloudflare. Real keys live in Parameter Store, never in the repo.
const SITE_KEY = 'test-site-key';

/**
 * Everything the hook hands Cloudflare. Only `callback` is required, because
 * the rest are exactly what the suite below exists to prove is wired: they
 * were all absent until 2026-09-10 and a test that declared them mandatory
 * would be asserting its own mock rather than the hook.
 */
type Options = {
  callback: (token: string) => void;
  language?: string;
  'expired-callback'?: () => void;
  'error-callback'?: () => void;
  'before-interactive-callback'?: () => void;
  'after-interactive-callback'?: () => void;
  'timeout-callback'?: () => void;
  'unsupported-callback'?: () => void;
};
let rendered: { node: HTMLElement; id: string; options: Options }[] = [];
let removed: string[] = [];
let nextId = 0;

const installTurnstile = () => {
  window.turnstile = {
    render: (node, options) => {
      const id = `widget-${nextId++}`;
      rendered.push({ node: node as HTMLElement, id, options: options as Options });
      return id;
    },
    reset: vi.fn(),
    remove: (id: string) => { removed.push(id); },
  };
};

/** The phone tab shows the widget; the email tab does not. */
const Harness = ({ tab }: { tab: 'phone' | 'email' }) => {
  const turnstile = useTurnstile();
  return (
    <AppContext.Provider value={{ turnstileSiteKey: SITE_KEY } as never}>
      <div>
        {tab === 'phone' && turnstile.isEnabled && (
          <div data-testid="container" ref={turnstile.containerRef} />
        )}
        <span data-testid="token">{turnstile.token ?? 'none'}</span>
      </div>
    </AppContext.Provider>
  );
};

const Wrapper = ({ tab }: { tab: 'phone' | 'email' }) => (
  <AppContext.Provider value={{ turnstileSiteKey: SITE_KEY } as never}>
    <Harness tab={tab} />
  </AppContext.Provider>
);

describe('useTurnstile widget lifecycle', () => {
  beforeEach(() => {
    rendered = [];
    removed = [];
    nextId = 0;
    document.getElementById('cf-turnstile')?.remove();
    installTurnstile();
  });

  test('the widget comes back after switching away and back', () => {
    // The exact sequence reported from staging: verify on Phone, switch to
    // Email, switch back, and the widget is gone. The previous
    // implementation cached the widget id in a ref and never cleared it, so
    // the re-render was skipped by its own "already rendered" guard and the
    // parent was left with no way to produce a token at all.
    const view = render(<Wrapper tab="phone" />);
    expect(rendered).toHaveLength(1);

    view.rerender(<Wrapper tab="email" />);
    expect(screen.queryByTestId('container')).toBeNull();

    view.rerender(<Wrapper tab="phone" />);

    expect(rendered).toHaveLength(2);
    // ...and into the node that is actually on the page now.
    expect(rendered[1].node).toBe(screen.getByTestId('container'));
  });

  test('the old widget is removed rather than leaked', () => {
    const view = render(<Wrapper tab="phone" />);
    view.rerender(<Wrapper tab="email" />);

    expect(removed).toEqual([rendered[0].id]);
  });

  test('a token from a widget that no longer exists is discarded', () => {
    // Sending a token that belonged to a removed widget gets a 403 from the
    // endpoint, which looks to a parent like the form silently breaking.
    const view = render(<Wrapper tab="phone" />);

    act(() => {
      rendered[0].options.callback('token-from-first-widget');
    });
    expect(screen.getByTestId('token')).toHaveTextContent('token-from-first-widget');

    view.rerender(<Wrapper tab="email" />);

    expect(screen.getByTestId('token')).toHaveTextContent('none');
  });
});

/**
 * The interactive challenge, which had no test at all before 2026-09-10.
 *
 * Everything below is about a parent who cannot see the widget. Cloudflare
 * publishes seven callbacks and the hook subscribed to three, so the one
 * outcome an assistive-technology user is most likely to hit — the challenge
 * demands something, they cannot find it, it gives up — produced no state
 * change anywhere in the app. Nothing was rendered, nothing was announced,
 * and the first they heard of it was a 403 after they pressed submit.
 *
 * A separate harness so the three lifecycle tests above stay exactly as they
 * were: they are the reason phone signup works at all.
 */
const StatusHarness = ({ tab, language }: { tab: 'phone' | 'email'; language?: string }) => {
  const turnstile = useTurnstile(language);
  return (
    <div>
      {tab === 'phone' && turnstile.isEnabled && (
        <div data-testid="container" ref={turnstile.containerRef} />
      )}
      <span data-testid="token">{turnstile.token ?? 'none'}</span>
      <span data-testid="status">{turnstile.status}</span>
      <span data-testid="has-failed">{String(turnstile.hasFailed)}</span>
      <span data-testid="can-retry">{String(turnstile.canRetry)}</span>
      <button type="button" onClick={turnstile.retry}>retry</button>
    </div>
  );
};

const StatusWrapper = ({ tab, language }: { tab: 'phone' | 'email'; language?: string }) => (
  <AppContext.Provider value={{ turnstileSiteKey: SITE_KEY } as never}>
    <StatusHarness tab={tab} language={language} />
  </AppContext.Provider>
);

/**
 * Fire one of the widget's callbacks. Throws by name when the hook never
 * wired it, so "we forgot to subscribe" reads as that rather than as an
 * undefined-is-not-a-function stack.
 */
const fire = (index: number, name: keyof Options) => {
  const handler = rendered[index].options[name];
  if (typeof handler !== 'function') {
    throw new Error(`useTurnstile never wired ${String(name)}`);
  }
  act(() => { (handler as () => void)(); });
};

describe('useTurnstile interactive challenge', () => {
  beforeEach(() => {
    rendered = [];
    removed = [];
    nextId = 0;
    document.getElementById('cf-turnstile')?.remove();
    installTurnstile();
  });

  test('a rendered widget reports itself ready, so its arrival can be announced', () => {
    render(<StatusWrapper tab="phone" />);

    expect(screen.getByTestId('status')).toHaveTextContent('ready');
  });

  test('going interactive is visible to the caller, and leaving it again is too', () => {
    render(<StatusWrapper tab="phone" />);

    fire(0, 'before-interactive-callback');
    expect(screen.getByTestId('status')).toHaveTextContent('interactive');

    fire(0, 'after-interactive-callback');
    expect(screen.getByTestId('status')).toHaveTextContent('ready');
  });

  test('leaving interactive mode does not undo a token that already arrived', () => {
    // Cloudflare does not promise an order between these two, and a parent who
    // has passed must not be told they still have to do something.
    render(<StatusWrapper tab="phone" />);

    fire(0, 'before-interactive-callback');
    act(() => { rendered[0].options.callback('solved-token'); });
    fire(0, 'after-interactive-callback');

    expect(screen.getByTestId('status')).toHaveTextContent('solved');
    expect(screen.getByTestId('token')).toHaveTextContent('solved-token');
  });

  test('a challenge that times out clears the token and says so', () => {
    render(<StatusWrapper tab="phone" />);
    act(() => { rendered[0].options.callback('token-before-timeout'); });

    fire(0, 'timeout-callback');

    expect(screen.getByTestId('status')).toHaveTextContent('timedOut');
    expect(screen.getByTestId('token')).toHaveTextContent('none');
  });

  test('a timeout is NOT an error, which is exactly why it used to be invisible', () => {
    // hasFailed was the app's only failure affordance, and Turnstile does not
    // fire error-callback on a timeout. Observed on the force-interactive key:
    // 26 seconds, before-interactive fired, no token, no error, nothing shown.
    render(<StatusWrapper tab="phone" />);

    fire(0, 'before-interactive-callback');
    fire(0, 'timeout-callback');

    expect(screen.getByTestId('has-failed')).toHaveTextContent('false');
    expect(screen.getByTestId('status')).toHaveTextContent('timedOut');
  });

  test('an expired token is cleared and reported as expired, not as a failure', () => {
    render(<StatusWrapper tab="phone" />);
    act(() => { rendered[0].options.callback('token-that-expires'); });

    fire(0, 'expired-callback');

    expect(screen.getByTestId('token')).toHaveTextContent('none');
    expect(screen.getByTestId('status')).toHaveTextContent('expired');
    expect(screen.getByTestId('has-failed')).toHaveTextContent('false');
  });

  test('a browser Turnstile cannot support is a failure the parent is told about', () => {
    render(<StatusWrapper tab="phone" />);

    fire(0, 'unsupported-callback');

    expect(screen.getByTestId('has-failed')).toHaveTextContent('true');
  });

  test('retrying after a timeout resets the widget and is capped at three', () => {
    render(<StatusWrapper tab="phone" />);
    const resetWidget = window.turnstile?.reset as ReturnType<typeof vi.fn>;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      fire(0, 'timeout-callback');
      expect(screen.getByTestId('can-retry')).toHaveTextContent('true');
      act(() => { screen.getByText('retry').click(); });
      expect(resetWidget).toHaveBeenNthCalledWith(attempt, rendered[0].id);
      expect(screen.getByTestId('status')).toHaveTextContent('ready');
    }

    // Spent. The button goes away and the parent gets the copy that tells
    // them to check their connection or change browser, rather than a
    // control that does nothing.
    expect(screen.getByTestId('can-retry')).toHaveTextContent('false');
    fire(0, 'timeout-callback');
    act(() => { screen.getByText('retry').click(); });
    expect(resetWidget).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('has-failed')).toHaveTextContent('true');
  });

  test('a stale failure does not survive into the next attach', () => {
    // error-callback is transient. Before this, one blip left the warning on
    // screen for the rest of the page's life and re-fired its role="alert" on
    // every switch back to the phone tab.
    const view = render(<StatusWrapper tab="phone" />);
    fire(0, 'error-callback');
    expect(screen.getByTestId('has-failed')).toHaveTextContent('true');

    view.rerender(<StatusWrapper tab="email" />);
    view.rerender(<StatusWrapper tab="phone" />);

    expect(screen.getByTestId('has-failed')).toHaveTextContent('false');
    expect(screen.getByTestId('status')).toHaveTextContent('ready');
  });

  test('discarding a solved token on tab switch is reported, not silent', () => {
    // The discard itself is correct and is pinned above. What was missing is
    // that a parent who passed the check, tapped WITH EMAIL and came back was
    // unverified with nothing anywhere saying so.
    const view = render(<StatusWrapper tab="phone" />);
    act(() => { rendered[0].options.callback('token-from-first-widget'); });

    view.rerender(<StatusWrapper tab="email" />);

    expect(screen.getByTestId('token')).toHaveTextContent('none');
    expect(screen.getByTestId('status')).toHaveTextContent('reset');
  });

  test('a tab switch before the check was passed announces nothing', () => {
    // There is nothing to mourn, and a live region that speaks on every idle
    // tab switch trains a parent to ignore it.
    const view = render(<StatusWrapper tab="phone" />);

    view.rerender(<StatusWrapper tab="email" />);

    expect(screen.getByTestId('status')).toHaveTextContent('idle');
  });
});

describe('useTurnstile language', () => {
  beforeEach(() => {
    rendered = [];
    removed = [];
    nextId = 0;
    document.getElementById('cf-turnstile')?.remove();
    installTurnstile();
  });

  // Every A-IEP code is a valid Turnstile code, so there is no mapping layer
  // to get wrong — but there is also nothing to catch a code that stops being
  // passed through. Turnstile's default is `auto`, i.e. the BROWSER's
  // language, which is the wrong one for precisely the parents who changed
  // A-IEP's: they picked a non-English UI because English is hard for them.
  test.each(['en', 'es', 'zh', 'vi', 'ar'])('the app\'s %s reaches Cloudflare', (code) => {
    render(<StatusWrapper tab="phone" language={code} />);

    expect(rendered[0].options.language).toBe(code);
  });

  test('no language given means the option is omitted, not sent as undefined', () => {
    // Turnstile reads `language` if the key is present at all; an explicit
    // undefined is not the same as leaving it to `auto`.
    render(<StatusWrapper tab="phone" />);

    expect('language' in rendered[0].options).toBe(false);
  });

  test('changing language rebuilds the widget in the new language, exactly once', () => {
    const view = render(<StatusWrapper tab="phone" language="en" />);

    view.rerender(<StatusWrapper tab="phone" language="ar" />);

    expect(rendered).toHaveLength(2);
    expect(rendered[1].options.language).toBe('ar');
    expect(removed).toEqual([rendered[0].id]);
    expect(rendered[1].node).toBe(screen.getByTestId('container'));
  });
});
