import React, { useState } from 'react';
import { Form, Alert, Button } from 'react-bootstrap';
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

  const auth = usePasswordlessAuth({ httpEndpoint, language, onSignedIn });
  const turnstileStatusKey = TURNSTILE_STATUS_KEYS[turnstile.status];

  const handleStart = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

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
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    await auth.submitCode(code);
    setCode('');
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

          <AlertMessages error={auth.error} successMessage={null} />

          <div className="d-grid gap-2">
            <SubmitButton
              loading={auth.loading}
              buttonText={t('auth.verify')}
              disabled={auth.loading || code.length < 4}
            />
            <LinkButton
              onClick={auth.backToStart}
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
