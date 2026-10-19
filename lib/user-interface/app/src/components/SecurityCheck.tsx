import React from 'react';
import { Alert, Button } from 'react-bootstrap';
import { TurnstileStatus } from '../common/hooks/use-turnstile';

/** The slice of useTurnstile's return value the sign-in forms need. */
export interface TurnstileProp {
  containerRef: (node: HTMLDivElement | null) => void;
  token: string | null;
  isEnabled: boolean;
  status: TurnstileStatus;
  hasFailed: boolean;
  canRetry: boolean;
  retry: () => void;
  getToken: () => Promise<string | null>;
  reset: () => void;
}

interface SecurityCheckProps {
  t: (key: string) => string;
  turnstile: TurnstileProp;
}

/**
 * The slot Cloudflare's widget renders into, plus its own timeout/failure
 * alerts. Shared by both sign-in forms so they cannot drift.
 *
 * The widget is `interaction-only`: invisible unless Cloudflare decides a
 * parent has to do something. Only then does the slot become a named group
 * with instructions. Turnstile replaces its container with a closed shadow
 * root holding a cross-origin iframe the page can neither name nor inspect,
 * so without the wrapper's name an interactive challenge is a focusable,
 * unnamed, mandatory gate. Shown the rest of the time, the heading would ask
 * parents to confirm they are not a robot next to a box that is not there.
 *
 * The container div keeps the same position among its siblings whatever the
 * status, so React never remounts it: a remount detaches the callback ref,
 * which removes the widget mid-challenge.
 */
const SecurityCheck: React.FC<SecurityCheckProps> = ({ t, turnstile }) => {
  if (!turnstile.isEnabled) return null;
  const needsParent = turnstile.status === 'interactive';
  return (
    <>
      <div
        className={needsParent ? 'mb-3' : undefined}
        role={needsParent ? 'group' : undefined}
        aria-labelledby={needsParent ? 'turnstile-heading' : undefined}
        aria-describedby={needsParent ? 'turnstile-help' : undefined}
      >
        {needsParent && (
          <p id="turnstile-heading" className="form-label mb-1">
            {t('auth.securityCheck')}
          </p>
        )}
        {needsParent && (
          <p id="turnstile-help" className="text-muted small mb-2">
            {t('auth.securityCheckHelp')}
          </p>
        )}
        {/* Reserved only while the challenge is showing, so the 300x71 box
            does not shove the send button about while a parent uses it. */}
        <div className="d-flex justify-content-center" style={needsParent ? { minHeight: '4.5rem' } : undefined}>
          <div ref={turnstile.containerRef} />
        </div>
        {needsParent && (
          <p className="text-muted small mt-2 mb-0">
            {t('auth.securityCheckInteractive')}
          </p>
        )}
      </div>
      {/* It went interactive and was never solved. Turnstile fires
          timeout-callback rather than error-callback for this. */}
      {turnstile.status === 'timedOut' && (
        <Alert variant="warning" className="mb-3">
          {t('auth.securityCheckTimedOut')}{' '}
          {turnstile.canRetry && (
            <Button variant="link" size="sm" className="p-0 align-baseline" onClick={turnstile.retry}>
              {t('auth.securityCheckRetry')}
            </Button>
          )}
        </Alert>
      )}
      {/* The check could not run at all (blocked script, unsupported
          browser), so every send would be refused. Say so while a parent can
          still act on it. */}
      {turnstile.hasFailed && (
        <Alert variant="warning" className="mb-3">
          {t('auth.errorTurnstileUnavailable')}
        </Alert>
      )}
    </>
  );
};

export default SecurityCheck;
