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

type Options = { callback: (token: string) => void };
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
