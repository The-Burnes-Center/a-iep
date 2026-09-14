import React, { useEffect, useState } from 'react';
import { Form, Alert, Button } from 'react-bootstrap';
import { AuthChannel } from '../common/auth/passwordless-auth';
import { usePasswordlessAuth } from '../common/hooks/use-passwordless-auth';
import { TurnstileStatus } from '../common/hooks/use-turnstile';
import FormLabel from './FormLabel';
import EmailInput from './EmailInput';
import VerificationCodeInput from './VerificationCodeInput';
import AlertMessages from './AlertMessages';
import SubmitButton from './SubmitButton';
import LinkButton from './LinkButton';
import LoginMethodToggle from './LoginMethodToggle';

/** Mirrors CustomLogin's own TURNSTILE_STATUS_KEYS: what the security check
 * says to a parent who cannot see it, keyed by where the check has got to. */
const TURNSTILE_STATUS_KEYS: Partial<Record<TurnstileStatus, string>> = {
  ready: 'auth.securityCheckReady',
  interactive: 'auth.securityCheckInteractive',
  solved: 'auth.securityCheckDone',
  expired: 'auth.securityCheckExpired',
  reset: 'auth.securityCheckReset',
};

/**
 * How long a parent waits between code requests.
 *
 * Sixty seconds, for two reasons that both cost the parent something. A code
 * they have not got yet is usually a slow carrier rather than a lost message,
 * and asking again mints a NEW code that kills the one still in flight — so a
 * resend at ten seconds can take away the text that was about to arrive. And
 * the send path allows five codes per destination per hour (contract §13):
 * at this interval a parent cannot spend that hour's worth in under five
 * minutes of tapping and lock themselves out of their own account.
 */
const RESEND_COOLDOWN_SECONDS = 60;

/** Whether the code on its way is the first one or a replacement. */
type SendNotice = 'sent' | 'resent';

/**
 * What a parent is told once a code is on its way, by channel and by which of
 * the two it was.
 *
 * Split by channel deliberately: "resent to your phone" in front of somebody
 * who typed an email address reads as the app having sent it to the wrong
 * place. All five dictionaries already carry both halves.
 */
const SEND_NOTICE_KEYS: Record<AuthChannel, Record<SendNotice, string>> = {
  sms: { sent: 'auth.smsCodeSent', resent: 'auth.smsCodeResent' },
  email: { sent: 'auth.verificationCodeSent', resent: 'auth.successCodeResent' },
};

/** The slice of useTurnstile's return value this form actually needs. */
interface TurnstileProp {
  containerRef: (node: HTMLDivElement | null) => void;
  token: string | null;
  isEnabled: boolean;
  status: TurnstileStatus;
  hasFailed: boolean;
  canRetry: boolean;
  retry: () => void;
  reset: () => void;
}

interface PasswordlessAuthFormProps {
  t: (key: string) => string;
  language: string;
  httpEndpoint: string;
  turnstile: TurnstileProp;
  onSignedIn: () => void;
}

/** +1 (xxx) xxx-xxxx as the parent types, same formatting CustomLogin's own phone field uses. */
const formatUsPhoneDisplay = (input: string): string => {
  if (input.length < 3) return '+1 ';
  const withoutPrefix = input.startsWith('+1 ') ? input.slice(3) : input;
  const digits = withoutPrefix.replace(/\D/g, '');
  if (digits.length === 0) return '+1 ';
  if (digits.length <= 3) return `+1 (${digits}`;
  if (digits.length <= 6) return `+1 (${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `+1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
};

interface TurnstileBlockProps {
  t: (key: string) => string;
  turnstile: TurnstileProp;
}

/**
 * The visible half of the security check: the named group Cloudflare's widget
 * renders into, plus its own timeout/failure alerts. Markup mirrors
 * CustomLogin's legacy block so the accessibility properties hand-verified
 * there (named group, reserved slot height) carry over unchanged. Kept as its
 * own component so it can be given a distinct `key` per tab at the call site
 * (see the comment above where it is rendered) — without that, switching tabs
 * would update this element in place instead of unmounting it.
 */
const TurnstileBlock: React.FC<TurnstileBlockProps> = ({ t, turnstile }) => {
  if (!turnstile.isEnabled) return null;
  return (
    <>
      <div
        className="mb-3"
        role="group"
        aria-labelledby="turnstile-heading"
        aria-describedby="turnstile-help"
      >
        <p id="turnstile-heading" className="form-label mb-1">
          {t('auth.securityCheck')}
        </p>
        <p id="turnstile-help" className="text-muted small mb-2">
          {t('auth.securityCheckHelp')}
        </p>
        <div className="d-flex justify-content-center" style={{ minHeight: '4.5rem' }}>
          <div ref={turnstile.containerRef} />
        </div>
        {turnstile.status === 'interactive' && (
          <p className="text-muted small mt-2 mb-0">
            {t('auth.securityCheckInteractive')}
          </p>
        )}
      </div>
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
      {turnstile.hasFailed && (
        <Alert variant="warning" className="mb-3">
          {t('auth.errorTurnstileUnavailable')}
        </Alert>
      )}
    </>
  );
};

/**
 * The identifier -> code flow described in docs/AUTH_API_CONTRACT.md, behind
 * the `passwordlessAuth` feature flag. Rendered by CustomLogin in place of
 * the Amplify signIn/signUp branch when the flag is on; extracted to its own
 * file because CustomLogin.tsx is already at the repo's 800-line hard limit
 * and this flow has no business growing it further.
 *
 * The Turnstile block is rendered for BOTH the phone and email tabs (unlike
 * the legacy form, where it lives in the phone tab only): the contract
 * requires a token on every /auth/start call regardless of destination type,
 * because email signup no longer has a password gating it either.
 */
const PasswordlessAuthForm: React.FC<PasswordlessAuthFormProps> = ({
  t,
  language,
  httpEndpoint,
  turnstile,
  onSignedIn,
}) => {
  const [showMobileLogin, setShowMobileLogin] = useState(true);
  const [phoneNumber, setPhoneNumber] = useState('+1 ');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [sendNotice, setSendNotice] = useState<SendNotice | null>(null);
  const [secondsUntilResend, setSecondsUntilResend] = useState(0);

  const auth = usePasswordlessAuth({ httpEndpoint, language, onSignedIn });
  const turnstileStatusKey = TURNSTILE_STATUS_KEYS[turnstile.status];

  /**
   * Counts the cooldown down from the moment the last code was SENT, not from
   * the moment this effect ran: the deadline is wall-clock, so a backgrounded
   * tab (or a parent who left the page and came back, which unmounts this
   * component entirely) resumes with the right number rather than a fresh
   * minute.
   */
  useEffect(() => {
    if (!auth.lastCodeSentAt) {
      setSecondsUntilResend(0);
      return;
    }
    const deadline = auth.lastCodeSentAt + RESEND_COOLDOWN_SECONDS * 1000;
    const secondsLeft = () => Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    setSecondsUntilResend(secondsLeft());
    const ticker = setInterval(() => {
      const left = secondsLeft();
      setSecondsUntilResend(left);
      if (left === 0) clearInterval(ticker);
    }, 1000);
    return () => clearInterval(ticker);
  }, [auth.lastCodeSentAt]);

  const handleStart = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSendNotice(null);

    let destination: string;
    if (showMobileLogin) {
      const digits = phoneNumber.replace(/\D/g, '');
      if (digits.length < 10) {
        setFormError('auth.errorPhoneFormat');
        return;
      }
      destination = `+1${digits.slice(-10)}`;
    } else {
      // No client-side blank/format check here: EmailInput's field is
      // `required` and type="email", so the browser's own constraint
      // validation already refuses to fire onSubmit for an empty or
      // malformed address — the same thing the legacy email sign-in form
      // relies on, with no redundant JS check of its own.
      destination = email.trim().toLowerCase();
    }

    const started = await auth.start(destination, turnstile.token ?? undefined);
    if (!started) {
      // A spent token is refused if tried again; the parent cannot see or fix
      // that, so a failed attempt clears it same as the legacy flow does.
      turnstile.reset();
      return;
    }
    setSendNotice('sent');
  };

  /**
   * Ask for another code for the destination the parent already gave us.
   *
   * This is the only way off the code screen that does not lose their place:
   * before it existed a parent whose text never arrived had to go back, retype
   * their number and work out for themselves that doing so sends a new code.
   *
   * It goes through the same `start` the first send does, so every answer the
   * endpoint can give — a lockout, a refused bot check, a service that is down
   * — is handled once, in the hook, and looks the same wherever it was reached.
   */
  const handleResend = async () => {
    if (secondsUntilResend > 0 || auth.loading) return;
    setFormError(null);
    setSendNotice(null);

    // /auth/start requires a token on every call (contract §2) and a token is
    // single-use, so the one the first send spent is no use here. The widget
    // above this button is a fresh one — it mounted with this step — and the
    // spent token went with the widget that raised it. With none in hand,
    // say so instead of posting a request that can only come back 403: that
    // would spend one of the parent's own hourly starts to tell them nothing.
    if (turnstile.isEnabled && !turnstile.token) {
      const checkIsBroken = turnstile.hasFailed || turnstile.status === 'timedOut';
      setFormError(checkIsBroken ? 'auth.resendFailed' : 'auth.securityCheckInteractive');
      return;
    }

    const sent = await auth.start(auth.destination, turnstile.token ?? undefined);
    // Spent either way now: accepted by the endpoint, or refused and dead.
    turnstile.reset();
    if (!sent) {
      // auth.error already carries the endpoint's own reason, which is more
      // use to a parent than "resend failed" would be, and a lockout has
      // replaced this screen outright. Nothing to add here; what matters is
      // that no success notice is shown for a send that did not happen.
      return;
    }

    // The new code invalidates the old one, so digits left in the box are
    // guaranteed dead and submitting them would burn one of three attempts.
    // This is the opposite call from handleVerify below, and deliberately:
    // there, what the parent had retyped was still a code worth sending.
    setCode('');
    setSendNotice('resent');
  };

  const handleBackToStart = () => {
    setFormError(null);
    setSendNotice(null);
    setCode('');
    auth.backToStart();
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    // Clear synchronously, in the same event as the submit, NOT after the
    // await. The attempt is spent the moment it is sent, so this is when the
    // box should empty -- and clearing after the round trip wipes whatever is
    // in the field when the response lands, which is not necessarily what was
    // submitted. A parent who starts retyping while the request is in flight
    // had their input erased and the button greyed out under them; on a slow
    // connection that window is seconds wide. E2E found it by typing fast.
    const submitted = code;
    setCode('');
    // Both stop being true the moment they answer. The notice ("your code is
    // on its way") has done its job, and a message left over from a resend
    // must not sit in front of whatever this attempt is about to say, since
    // it is the same alert slot.
    setSendNotice(null);
    setFormError(null);
    await auth.submitCode(submitted);
  };

  if (auth.step === 'locked_out') {
    return (
      <Alert variant="warning" data-testid="passwordless-locked-out">
        {t('auth.error.tooManyCodes').replace('{minutes}', String(auth.lockedMinutes))}
      </Alert>
    );
  }

  if (auth.step === 'awaiting_code') {
    return (
      <Form onSubmit={handleVerify}>
        <div className="mobile-form-container">
          <div className="sms-verification-info">
            <p>
              {t('auth.smsCodeSentTo')}<br />
              {/* Destinations always render left-to-right, even in RTL UI. */}
              <span className="phone-display" dir="ltr">{auth.destination}</span>
            </p>
          </div>
          <VerificationCodeInput
            label={t('auth.verificationCodeSms')}
            placeholder={t('auth.enterSmsCode')}
            value={code}
            onChange={setCode}
            required
            autoFocus
          />

          {/*
            Where Resend's token comes from. Rendered with the step rather
            than mounted when the button is tapped, because a challenge takes
            time to solve and an interactive one needs the parent: arming it
            on the tap would leave them looking at a button that had done
            nothing. Keyed separately from the two on the identifier step so
            React cannot reconcile it with one of those and skip the remount
            that discards the token the first send already spent.
          */}
          <TurnstileBlock key="code" t={t} turnstile={turnstile} />

          {/* The notice is cleared wherever it stops being true (a submit, a
              new attempt, going back), rather than filtered here, so there is
              one rule about its lifetime instead of two. */}
          <AlertMessages
            error={formError ?? auth.error}
            successMessage={sendNotice ? SEND_NOTICE_KEYS[auth.channel][sendNotice] : null}
          />

          <div className="d-grid gap-2">
            <SubmitButton
              loading={auth.loading}
              buttonText={t('auth.verify')}
              disabled={auth.loading || code.length < 4}
            />
            <Button
              type="button"
              variant="outline-secondary"
              className="submit-button-login"
              onClick={handleResend}
              disabled={auth.loading || secondsUntilResend > 0}
              aria-describedby={secondsUntilResend > 0 ? 'resend-cooldown' : undefined}
              data-testid="resend-code"
            >
              {t('auth.resendSmsCode')}
            </Button>
            {secondsUntilResend > 0 && (
              // A disabled button with no explanation reads as a broken one.
              <p id="resend-cooldown" className="text-muted small mb-0 text-center">
                {t('auth.resendCooldown').replace('{seconds}', String(secondsUntilResend))}
              </p>
            )}
            <LinkButton
              onClick={handleBackToStart}
              disabled={auth.loading}
              buttonText={t('auth.backToLogin')}
            />
          </div>
        </div>
      </Form>
    );
  }

  return (
    <Form onSubmit={handleStart}>
      <div className="mobile-form-container">
        <LoginMethodToggle
          showMobileLogin={showMobileLogin}
          onMobileLoginClick={() => setShowMobileLogin(true)}
          onEmailLoginClick={() => setShowMobileLogin(false)}
          mobileLoginText={t('auth.mobileLogin')}
          emailLoginText={t('auth.emailLogin')}
        />

        {turnstile.isEnabled && (
          <div aria-live="polite" aria-atomic="true" className="visually-hidden">
            {turnstileStatusKey ? t(turnstileStatusKey) : ''}
          </div>
        )}

        {/*
          The Turnstile container is rendered once per tab below (keyed
          'phone' / 'email') rather than hoisted above this ternary or shared
          as one unkeyed instance. It needs to be present on BOTH tabs —
          unlike the legacy phone-only placement, /auth/start requires a
          token regardless of destination type (contract §2), since email
          sign-in has no password behind it any more either — but it also
          needs to keep UNMOUNTING on every tab switch, which is what makes a
          spent token get discarded and reported (use-turnstile.ts's
          containerRef callback fires on detach). Without the distinct keys,
          React sees the same component type in the same position on both
          sides of the ternary and updates it in place instead of
          remounting it, and the discard would silently stop firing.
        */}
        {showMobileLogin ? (
          <>
            <Form.Group className="mb-3">
              <FormLabel label={t('auth.phoneNumber')} />
              <Form.Control
                type="tel"
                placeholder="(xxx) xxx-xxxx"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(formatUsPhoneDisplay(e.target.value))}
                onKeyDown={(e) => {
                  const target = e.target as HTMLInputElement;
                  if ((e.key === 'ArrowLeft' || e.key === 'Home') && target.selectionStart !== null && target.selectionStart <= 3) {
                    e.preventDefault();
                    target.setSelectionRange(3, 3);
                  }
                }}
                required
                className="mobile-input"
              />
            </Form.Group>
            <TurnstileBlock key="phone" t={t} turnstile={turnstile} />
          </>
        ) : (
          <>
            <EmailInput
              label={t('auth.email')}
              placeholder={t('auth.enterEmail')}
              value={email}
              onChange={setEmail}
            />
            <TurnstileBlock key="email" t={t} turnstile={turnstile} />
          </>
        )}

        {/* No success channel on this step: a send that works moves the
            parent to the code step in the same commit, so the confirmation
            is rendered there, where they can actually read it. */}
        <AlertMessages error={formError ?? auth.error} successMessage={null} />

        <div className="d-grid gap-2">
          <SubmitButton loading={auth.loading} buttonText={t('auth.sendCode')} />
          <p className="text-muted mt-3 mobile-consent-text">
            {t('auth.smsConsentMobile')}
          </p>
        </div>
      </div>
    </Form>
  );
};

export default PasswordlessAuthForm;
