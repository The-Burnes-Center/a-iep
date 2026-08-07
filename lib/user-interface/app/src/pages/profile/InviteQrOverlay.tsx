/**
 * Full-viewport QR code for the referral link.
 *
 * The point is a parent holding their phone up so somebody across a table can
 * scan it, which drives every decision here:
 *
 *  - The code is rendered by `qrcode.react`'s QRCodeSVG, already a dependency
 *    (AdminReferrals uses the Canvas variant). SVG, not Canvas and emphatically
 *    not a remote QR service: the icons on this page were just moved off a web
 *    font because blocked/filtered resources are a real failure for families on
 *    school and public networks, and fetching a QR from a third party would
 *    reintroduce exactly that — while also handing the referral code to someone
 *    else. Nothing here touches the network.
 *  - It is sized in CSS off the SMALLER viewport axis (`min(vw, vh)`), so it
 *    stays square and fully visible in either orientation without a resize
 *    listener. The `size` prop only sets the fallback width/height attributes.
 *  - Dark-on-white with an explicit 4-module quiet zone (the QR spec's
 *    minimum), on a white card rather than the page's cream, because scanners
 *    key off that contrast.
 *
 * The URL is passed in rather than rebuilt, so the code can never encode
 * something different from what the other share controls send.
 *
 * A screen-reader user cannot scan a QR code, so the readable link text below
 * it is not decoration — it is the accessible equivalent, and it stays
 * selectable so it can be copied by hand.
 */
import React, { useCallback, useEffect, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useLanguage } from '../../common/language-context';
import { CloseIcon } from './InviteIcons';
import './InviteQrOverlay.css';

/**
 * Screen Wake Lock, feature-detected. Holding a phone up for someone else to
 * scan is precisely when the display would otherwise dim and lock. This is a
 * plain standard API with no polyfill and no fallback trickery: where it is
 * unavailable or refused (older WebKit, low battery, backgrounded tab) the QR
 * still shows and the screen simply times out as usual. The lock is released
 * when the overlay closes. iOS also drops it when the tab is backgrounded and
 * we deliberately do not re-acquire on visibilitychange — coming back to a
 * still-open overlay with a normal screen timeout is a fine outcome and not
 * worth the extra state.
 */
interface WakeLockSentinelLike {
  release: () => Promise<void>;
}
interface WakeLockLike {
  request: (type: 'screen') => Promise<WakeLockSentinelLike>;
}

const useScreenWakeLock = () => {
  useEffect(() => {
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
    if (!wakeLock) return;

    let sentinel: WakeLockSentinelLike | null = null;
    let released = false;

    wakeLock
      .request('screen')
      .then((granted) => {
        if (released) {
          granted.release().catch(() => {});
          return;
        }
        sentinel = granted;
      })
      .catch(() => {
        // Refused (battery saver, not user-activated, backgrounded). Nothing
        // to recover: the QR is on screen either way.
      });

    return () => {
      released = true;
      sentinel?.release().catch(() => {});
    };
  }, []);
};

/** Tab-cycle candidates inside the dialog. */
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

interface InviteQrOverlayProps {
  /** The exact invite URL the other share controls use. */
  url: string;
  onClose: () => void;
}

export default function InviteQrOverlay({ url, onClose }: InviteQrOverlayProps) {
  const { t } = useLanguage();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = 'invite-qr-title';

  useScreenWakeLock();

  // Move focus in on open and put it back on close, so a keyboard user is not
  // dumped at the top of the document after dismissing.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);

  // The overlay covers the page; letting the page behind it scroll under the
  // parent's thumb while they hold the phone up is just noise.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      // Focus trap. With a single focusable control this collapses to "keep
      // focus on the close button", which is the correct behaviour for a
      // modal and stops Tab walking into the inert page behind.
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  return (
    <div
      className="invite-qr-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      ref={dialogRef}
      onKeyDown={handleKeyDown}
      // Tapping anywhere dismisses, which is what "tap again to put it away"
      // means on a phone. The card below stops propagation so that selecting
      // the link text does not close the thing you are trying to read.
      onClick={onClose}
    >
      <button
        type="button"
        className="invite-qr-close"
        onClick={onClose}
        ref={closeButtonRef}
        aria-label={t('invite.qr.close')}
      >
        <CloseIcon />
      </button>

      <div
        className="invite-qr-card"
        onClick={(event) => event.stopPropagation()}
        role="presentation"
      >
        <h2 id={titleId} className="invite-qr-title">
          {t('invite.qr.title')}
        </h2>

        <QRCodeSVG
          className="invite-qr-code"
          value={url}
          // Only the fallback intrinsic size; CSS drives the rendered size.
          size={512}
          // 'M' survives a bit of glare and camera blur without making the
          // modules noticeably denser at this URL length.
          level="M"
          marginSize={4}
          bgColor="#FFFFFF"
          fgColor="#000000"
          aria-label={t('invite.qr.imageAlt')}
        />

        <p className="invite-qr-hint">{t('invite.qr.description')}</p>
        {/* Selectable, and the accessible equivalent of the code itself. */}
        <p className="invite-qr-url">{url}</p>
      </div>
    </div>
  );
}
