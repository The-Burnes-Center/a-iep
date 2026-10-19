import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Form } from 'react-bootstrap';
import FormLabel from './FormLabel';
import { isWebOtpSupported, requestWebOtpCode } from '../common/auth/web-otp';
import './VerificationCodeInput.css';

/** Digits in an SMS/email one-time code. Cognito issues six. */
const CODE_LENGTH = 6;

/** The one rule for what reaches the field, whether typed, pasted or read by WebOTP. */
const sanitizeCode = (raw: string): string => raw.replace(/\D/g, '').slice(0, CODE_LENGTH);

interface VerificationCodeInputProps {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  autoFocus?: boolean;
}

const VerificationCodeInput: React.FC<VerificationCodeInputProps> = ({
  label,
  placeholder,
  value,
  onChange,
  required = true,
  autoFocus = true
}) => {
  // Drives the caret ring on the next empty box. Tracked here rather than
  // with :focus-within, because the ring belongs to one box out of six and
  // CSS cannot tell which one is next.
  const [focused, setFocused] = useState(false);

  // The WebOTP request is armed once, on mount, so it must not re-run when the
  // parent passes a new onChange identity. The ref carries the latest one in.
  const onChangeRef = useRef(onChange);
  const webOtpRef = useRef<AbortController | null>(null);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Typed, pasted and WebOTP-read values all reach the parent through here.
  // Stable across renders, so the mount-only WebOTP effect can depend on it.
  const commitValue = useCallback((raw: string) => onChangeRef.current(sanitizeCode(raw)), []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // The parent is entering the code by hand, so a code the browser reads
    // later must not overwrite what they are typing.
    webOtpRef.current?.abort();
    commitValue(e.target.value);
  };

  // Offer the SMS code the browser reads from the arriving message. The value
  // is filled but never submitted: the parent still presses Verify, so a
  // screen-reader user is not moved on without choosing to (WCAG 3.2.2).
  // Failures are silent on purpose. The field works without this, and a code
  // is a secret that lives for minutes, so nothing is logged either.
  useEffect(() => {
    if (!isWebOtpSupported()) return;
    const controller = new AbortController();
    webOtpRef.current = controller;
    requestWebOtpCode(controller.signal)
      .then((code) => {
        if (controller.signal.aborted || !code) return;
        commitValue(code);
      })
      .catch(() => {
        // Aborted, refused or failed: the field stays as it was and the parent
        // types the code. Nothing to show and nothing to log.
      });
    return () => {
      controller.abort();
      webOtpRef.current = null;
    };
  }, [commitValue]);

  // Where the next digit lands, and so where the caret shows. Clamped to the
  // last box on a full code, which keeps a ring on screen while the parent
  // reads back what they typed instead of dropping it at six digits.
  const caretIndex = Math.min(value.length, CODE_LENGTH - 1);

  return (
    <Form.Group className="mb-3">
      <FormLabel label={label} />
      {/* One real input behind six drawn boxes, rather than six inputs.
          Six would each need their own focus/backspace/paste plumbing, and
          would break the OS autofill below: iOS and Android offer the
          arriving code to a single field, and paste it in one shot. This
          way the field keeps one value, one caret and one testid, and the
          boxes are presentation over it. */}
      <div className="sms-code-field">
        <div className="sms-code-boxes" aria-hidden="true" dir="ltr">
          {Array.from({ length: CODE_LENGTH }, (_, i) => (
            <div
              key={i}
              className={[
                'sms-code-box',
                value[i] ? 'is-filled' : '',
                focused && i === caretIndex ? 'is-caret' : ''
              ].filter(Boolean).join(' ')}
            >
              {value[i] ?? ''}
            </div>
          ))}
        </div>
        <Form.Control
          // Deliberately not type="password": the digits are single-use and
          // expire in minutes, so hiding them buys nothing and costs a parent
          // the ability to check what they typed. A masked field also suppresses
          // the OS autofill below.
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={handleChange}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          maxLength={CODE_LENGTH}
          required={required}
          className="sms-code-input"
          autoFocus={autoFocus}
          // The attribute iOS Safari and Android Chrome key off to read the code
          // out of the arriving message and offer it above the keyboard. Without
          // it a parent reads six digits in one app and types them in another,
          // which is where they mistype or give up. It costs nothing where it is
          // unsupported: an unknown autocomplete token is ignored.
          autoComplete="one-time-code"
          // A numeric keypad for a numeric code. inputMode rather than
          // type="number", which brings spinners, allows a leading "e", and
          // changes the value on a stray scroll. pattern is the older iOS
          // spelling of the same request and is still read by some versions.
          inputMode="numeric"
          pattern="[0-9]*"
          // Digits fill left-to-right even in Arabic, matching the boxes
          // underneath and the phone number on the screen before this one.
          dir="ltr"
          // E2E hook (inert in production): the field has no associated label
          // and its placeholder is localized, so tests need a stable handle
          data-testid="sms-code-input"
        />
      </div>
    </Form.Group>
  );
};

export default VerificationCodeInput;
