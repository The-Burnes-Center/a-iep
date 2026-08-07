/**
 * Regression tests for the referral share controls.
 *
 * A tester on an iPhone reported that the share, SMS, email and WhatsApp
 * icons "never loaded" while the button text rendered fine. The icons were
 * bootstrap-icons glyphs, i.e. a WEB FONT: `<i className="bi bi-share">` plus
 * a `content: "\f52e"` rule. Web fonts are switched off wholesale by iOS
 * Lockdown Mode and by the "block web fonts" rule sets in iOS content
 * blockers, and on iOS every browser (Chrome included) is WebKit, so the
 * glyph resolves to an empty Private Use Area codepoint and disappears.
 *
 * The fix is inline SVG, which cannot be blocked because it is never fetched.
 * These tests therefore pin two things:
 *
 *  1. Every share control has an accessible name that does NOT come from the
 *     icon, so a parent on a screen reader (or with a dead icon) still gets a
 *     usable button.
 *  2. No icon is delivered over the network. Anything separately fetchable —
 *     an icon-font `<i class="bi-…">`, an `<img src>`, an `<svg><use href>`
 *     pointing at a sprite, or a CSS `url()` — is the exact failure mode we
 *     just removed, so each is asserted absent rather than merely unused.
 *
 * The mocked boundary is the network (Amplify `Auth` + `fetch`); the real
 * ReferralClient, react-query, router and page render on top of it, so the
 * assertions are what a parent actually sees in the DOM.
 */
import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import InvitePage from './InvitePage';
import { AppContext } from '../../common/app-context';
import { LanguageContext } from '../../common/language-context';
import type { SupportedLanguage } from '../../common/languages';
import type { AppConfig, ReferralStats } from '../../common/types';

const Auth = vi.hoisted(() => ({
  currentAuthenticatedUser: vi.fn(),
}));
vi.mock('aws-amplify', () => ({ Auth }));

const HTTP_ENDPOINT = 'https://api.example.test/';
const REFERRAL_CODE = 'ABC123';

const STATS: ReferralStats = {
  code: REFERRAL_CODE,
  clicks: 4,
  signups: 1,
  joins: [{ joinedAt: '2026-08-01T12:00:00Z' } as ReferralStats['joins'][number]],
};

/** Only the fields ApiClient/ReferralClient actually read. */
const appConfig = { httpEndpoint: HTTP_ENDPOINT } as AppConfig;

/**
 * t() is the identity so assertions read the translation KEY the component
 * chose. The English wording is not the contract.
 */
const languageValue = {
  language: 'en' as SupportedLanguage,
  setLanguage: vi.fn(),
  t: (key: string) => key,
  translationsLoaded: true,
  enabledLanguages: ['en', 'es', 'zh', 'vi', 'ar'] as SupportedLanguage[],
};

const renderInvitePage = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter initialEntries={['/invite']}>
      <QueryClientProvider client={queryClient}>
        <AppContext.Provider value={appConfig}>
          <LanguageContext.Provider value={languageValue}>
            <InvitePage />
          </LanguageContext.Provider>
        </AppContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
};

/** Waits past the loading spinner for the share controls to be on screen. */
const renderLoaded = async () => {
  const view = renderInvitePage();
  await screen.findByRole('button', { name: 'invite.copy' });
  return view;
};

/**
 * react-bootstrap renders `<Button as="a">` as an anchor carrying
 * role="button", so all five controls are buttons to assistive tech. Looking
 * them up by role+name is itself the accessible-name assertion.
 */
/**
 * The three channel chips take their accessible name from an aria-label, so a
 * screen reader hears what the control DOES ("Share by WhatsApp") instead of a
 * bare noun. Their visible text stays the channel word alone, which WCAG 2.5.3
 * (Label in Name) requires to appear inside the accessible name — asserted
 * directly in the icon test below.
 *
 * Under this suite's key-passthrough `t()` an aria-label renders as its raw
 * key, exactly as `invite.copy` and `invite.qr.show` already do here, so the
 * three channels are looked up by key while every call site keeps naming the
 * channel it means.
 */
const SHARE_ARIA_KEY: Record<string, string> = {
  WhatsApp: 'invite.shareVia.whatsapp',
  SMS: 'invite.shareVia.sms',
  Email: 'invite.shareVia.email',
};

const shareControl = (name: string) =>
  screen.getByRole('button', { name: SHARE_ARIA_KEY[name] ?? name });

beforeEach(() => {
  // Shape matches what Utils.authenticate actually reads off the Amplify user
  // (`signInUserSession.idToken.jwtToken`). Inventing a field the SDK never
  // returns is how a suite green-stamps a path that cannot work.
  Auth.currentAuthenticatedUser.mockResolvedValue({
    signInUserSession: { idToken: { jwtToken: 'test-token' } },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => STATS,
    }),
  );
  // navigator.share is absent in jsdom; the Share button is gated on it.
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    writable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
});

describe('InvitePage share controls', () => {
  test('every share control renders with an accessible name', async () => {
    await renderLoaded();

    // getByRole resolves by accessible name, so each of these passing IS the
    // assertion that the control is nameable without the icon.
    expect(shareControl('invite.share')).toBeInTheDocument();
    expect(shareControl('WhatsApp')).toBeInTheDocument();
    expect(shareControl('SMS')).toBeInTheDocument();
    expect(shareControl('Email')).toBeInTheDocument();
    expect(shareControl('invite.copy')).toBeInTheDocument();
    expect(shareControl('invite.qr.show')).toBeInTheDocument();
  });

  test('each share control points at its own channel', async () => {
    await renderLoaded();

    const inviteUrl = `${window.location.origin}/r/${REFERRAL_CODE}`;
    const encoded = encodeURIComponent(`invite.shareMessage ${inviteUrl}`);

    expect(shareControl('WhatsApp')).toHaveAttribute('href', `https://wa.me/?text=${encoded}`);
    expect(shareControl('SMS')).toHaveAttribute('href', `sms:?&body=${encoded}`);
    expect(shareControl('Email')).toHaveAttribute(
      'href',
      `mailto:?subject=${encodeURIComponent('invite.emailSubject')}&body=${encoded}`,
    );
  });

  test('every share control draws its icon as inline SVG', async () => {
    const { container } = await renderLoaded();

    const controls = [
      'invite.copy',
      'invite.share',
      'WhatsApp',
      'SMS',
      'Email',
      'invite.qr.show',
    ].map(shareControl);

    for (const control of controls) {
      const svg = control.querySelector('svg.invite-icon');
      expect(svg).not.toBeNull();
      // Real vector geometry, not an empty placeholder frame.
      expect(svg!.querySelector('path')).not.toBeNull();
    }

    // The joins list icon travels the same path and must not regress either.
    const joinRow = container.querySelector('.invite-join-row');
    expect(joinRow).not.toBeNull();
    expect(joinRow!.querySelector('svg.invite-icon path')).not.toBeNull();
  });

  test('no icon is fetched over the network, so nothing can block it', async () => {
    const { container } = await renderLoaded();

    // The icon font that caused the bug: `<i class="bi bi-share">` needs
    // /vendor/fonts/bootstrap-icons.woff2 to resolve before it draws anything.
    // Checked page-wide, since the invite page has no legitimate bi-* left.
    expect(container.querySelectorAll('[class*="bi-"]')).toHaveLength(0);

    // Any other separately-fetchable delivery mechanism, checked over the
    // share row only — the page footer carries real partner logo <img>s.
    const shareRow = container.querySelector('.invite-share-row');
    expect(shareRow).not.toBeNull();
    expect(shareRow!.querySelectorAll('img')).toHaveLength(0);
    expect(shareRow!.querySelectorAll('use')).toHaveLength(0);
    expect(shareRow!.innerHTML).not.toMatch(/url\(/);

    // And nothing requested an asset: the only fetch is the referral API call.
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).toBe(`${HTTP_ENDPOINT.slice(0, -1)}/referral/me`);
    }
  });

  test('icons are hidden from screen readers so buttons announce their label only', async () => {
    await renderLoaded();

    const whatsapp = shareControl('WhatsApp');
    const svg = whatsapp.querySelector('svg.invite-icon');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    // Without focusable="false" the SVG becomes a tab stop in older WebKit.
    expect(svg).toHaveAttribute('focusable', 'false');
    // The name comes from the text, so it survives the icon failing entirely.
    expect(within(whatsapp).getByText('WhatsApp')).toBeInTheDocument();
  });

  test('the error state still renders without any icon dependency', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
    );

    const { container } = renderInvitePage();

    await waitFor(() => {
      expect(screen.getByText('invite.error')).toBeInTheDocument();
    });
    expect(container.querySelectorAll('[class*="bi-"]')).toHaveLength(0);
  });
});

/**
 * The QR overlay. Same standard as the icons: it must be drawn locally, never
 * fetched, because a QR pulled from a third-party image service would both
 * reintroduce the blocked-resource failure and hand the referral code to
 * someone else. It must also encode the SAME url the other controls send —
 * a QR that drifts from the link is worse than no QR, because nobody would
 * notice until a parent scanned it.
 */
describe('InvitePage QR code overlay', () => {
  /**
   * qrcode.react draws a white background path first, then one path holding
   * every dark module. That second path IS the encoded payload.
   */
  const qrModulePath = (svg: HTMLElement) =>
    svg.querySelectorAll('path')[1]?.getAttribute('d') ?? '';

  /** The same code the component asks for, rendered in isolation. */
  const referenceQrPath = (value: string) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const { unmount, container } = render(
      <QRCodeSVG value={value} size={512} level="M" marginSize={4} />,
      { container: host },
    );
    const path = qrModulePath(container.querySelector('svg') as unknown as HTMLElement);
    unmount();
    host.remove();
    return path;
  };

  const openQr = async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await user.click(shareControl('invite.qr.show'));
    const dialog = await screen.findByRole('dialog');
    return { user, dialog };
  };

  test('opens a labelled modal dialog from the QR button', async () => {
    const { dialog } = await openQr();

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // Named by its heading, so a screen reader announces what opened.
    expect(dialog).toHaveAccessibleName('invite.qr.title');
  });

  test('encodes exactly the invite url the other share controls use', async () => {
    const { dialog } = await openQr();

    const inviteUrl = `${window.location.origin}/r/${REFERRAL_CODE}`;

    // The href the SMS control sends is the independent source of truth for
    // "the link we hand out"; assert the QR agrees with it rather than with a
    // second copy of the same string-building logic.
    const smsHref = shareControl('SMS').getAttribute('href') ?? '';
    expect(decodeURIComponent(smsHref)).toContain(inviteUrl);

    // qrcode.react exposes no DOM hook for its input, so compare the drawn
    // modules against a reference encoding of that same url. The module path
    // is a pure function of the value, so this fails the moment the QR encodes
    // anything else.
    const drawn = qrModulePath(within(dialog).getByRole('img'));
    expect(drawn).toBe(referenceQrPath(inviteUrl));

    // Guard that the comparison above can actually discriminate: a different
    // url must produce a different path, otherwise the assertion is vacuous.
    expect(drawn).not.toBe(referenceQrPath(`${inviteUrl}X`));
  });

  test('draws the code inline with no network request', async () => {
    const { dialog } = await openQr();

    const svg = within(dialog).getByRole('img');
    expect(svg.tagName.toLowerCase()).toBe('svg');
    // Real modules, drawn as vector paths.
    expect(svg.querySelectorAll('path').length).toBeGreaterThan(0);
    // Not a canvas, not a remote image, not a sprite reference.
    expect(dialog.querySelector('canvas')).toBeNull();
    expect(dialog.querySelectorAll('img')).toHaveLength(0);
    expect(dialog.querySelectorAll('image')).toHaveLength(0);
    expect(dialog.querySelectorAll('use')).toHaveLength(0);

    // The referral API call is still the only thing that hit the network.
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).toBe(`${HTTP_ENDPOINT.slice(0, -1)}/referral/me`);
    }
  });

  test('shows the link as readable text for anyone who cannot scan it', async () => {
    const { dialog } = await openQr();

    const inviteUrl = `${window.location.origin}/r/${REFERRAL_CODE}`;
    expect(within(dialog).getByText(inviteUrl)).toBeInTheDocument();
    // The code itself carries a label, since a screen reader cannot scan.
    expect(within(dialog).getByRole('img')).toHaveAccessibleName('invite.qr.imageAlt');
  });

  test('closes on Escape', async () => {
    const { user } = await openQr();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  test('closes on the close control and returns focus to the trigger', async () => {
    const { user, dialog } = await openQr();

    await user.click(within(dialog).getByRole('button', { name: 'invite.qr.close' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    // A keyboard user must land back where they were, not at the document top.
    expect(shareControl('invite.qr.show')).toHaveFocus();
  });

  test('closes when the parent taps the backdrop but not the code itself', async () => {
    const { user, dialog } = await openQr();

    // Tapping the card (e.g. selecting the url) must NOT dismiss it.
    await user.click(within(dialog).getByText(`${window.location.origin}/r/${REFERRAL_CODE}`));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.click(dialog);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  test('moves focus into the dialog and traps it there', async () => {
    const { user, dialog } = await openQr();

    const close = within(dialog).getByRole('button', { name: 'invite.qr.close' });
    expect(close).toHaveFocus();

    // Tab must not walk out into the page behind the modal.
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
