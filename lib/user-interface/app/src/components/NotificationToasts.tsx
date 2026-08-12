import React, { useCallback, useEffect } from 'react';
import { CloseButton, ToastContainer } from 'react-bootstrap';
import { useLanguage } from '../common/language-context';
import { NotificationItem, NotificationType, useNotifications } from './notif-manager';

/**
 * Renders the notification queue as Bootstrap toasts.
 *
 * Mounted once, by app-configured, as a sibling of AppRoutes: the queue lives
 * above <Routes>, so a message raised immediately before a navigation (the
 * profile forms all save and then navigate) is still on screen afterwards.
 *
 * The chrome is Bootstrap's own .toast markup rather than react-bootstrap's
 * <Toast>, because <Toast> applies role="alert" aria-live="assertive" AFTER
 * spreading props, so the politeness level cannot be set per notification.
 * Assertive is right for an error and wrong for a success confirmation, which
 * would cut a screen reader off mid-sentence. ToastContainer and CloseButton
 * are react-bootstrap's, since neither hardcodes anything we need to change.
 */

// Matches AlertMessages.tsx, the app's other transient confirmation, so the
// app has one answer to "how long does a success message stay up". Long enough
// to read a sentence in a second language; short enough not to sit over the
// content. Errors never auto-dismiss: they can carry text the parent needs
// (a failure reason, a value to retry with) and dismissing is their only cue
// that something went wrong.
const SUCCESS_AUTO_DISMISS_MS = 8000;

interface ToastPresentation {
  /** Bootstrap contextual colour utility. */
  background: string;
  /** 'white' renders the light close glyph, for the dark-backed variants. */
  closeVariant?: 'white';
  role: 'status' | 'alert';
  ariaLive: 'polite' | 'assertive';
  autoDismiss: boolean;
}

const PRESENTATION: Record<NotificationType, ToastPresentation> = {
  success: { background: 'text-bg-success', closeVariant: 'white', role: 'status', ariaLive: 'polite', autoDismiss: true },
  info: { background: 'text-bg-info', role: 'status', ariaLive: 'polite', autoDismiss: true },
  warning: { background: 'text-bg-warning', role: 'status', ariaLive: 'polite', autoDismiss: false },
  error: { background: 'text-bg-danger', closeVariant: 'white', role: 'alert', ariaLive: 'assertive', autoDismiss: false },
};

function NotificationToast({ notification }: { notification: NotificationItem }) {
  const { removeNotification } = useNotifications();
  const { t } = useLanguage();
  const { id, type, content } = notification;
  const { background, closeVariant, role, ariaLive, autoDismiss } = PRESENTATION[type];

  const dismiss = useCallback(() => removeNotification(id), [removeNotification, id]);

  useEffect(() => {
    if (!autoDismiss) return;
    const timer = setTimeout(dismiss, SUCCESS_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [autoDismiss, dismiss]);

  return (
    <div
      className={`toast show align-items-center border-0 ${background}`}
      role={role}
      aria-live={ariaLive}
      aria-atomic="true"
      data-testid={`notification-${type}`}
    >
      <div className="d-flex">
        <div className="toast-body">{content}</div>
        <CloseButton
          variant={closeVariant}
          className="me-2 m-auto"
          aria-label={t('notifications.dismiss')}
          onClick={dismiss}
        />
      </div>
    </div>
  );
}

export default function NotificationToasts() {
  const { notifications } = useNotifications();

  // 'bottom-center' resolves to Bootstrap's logical `start-50 translate-middle-x`
  // utilities, which the RTL stylesheet common/direction.ts swaps in already
  // mirrors, so placement follows the document direction with no side hardcoded
  // here. Bottom, because the app's navigation is a sticky header.
  // Rendered even when empty so the container is a stable node in the DOM.
  return (
    <ToastContainer position="bottom-center" containerPosition="fixed" className="p-3">
      {notifications.map(notification => (
        <NotificationToast key={notification.id} notification={notification} />
      ))}
    </ToastContainer>
  );
}
