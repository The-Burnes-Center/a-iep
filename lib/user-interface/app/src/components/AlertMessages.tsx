import React, { useEffect, useState } from 'react';
import { Alert } from 'react-bootstrap';
import { useLanguage } from '../common/language-context';
import { formatDestination } from '../common/helpers/format-destination';
import './AlertMessages.css';

interface AlertMessagesProps {
  error: string | null;
  successMessage: string | null;
  /**
   * Keep a success alert up until its sender takes it down.
   *
   * For the code screens, where the alert is not a receipt for something
   * finished but the standing explanation of what the parent is doing there
   * ("SMS code sent. Please enter the verification code."). Waiting for a text
   * message can easily outlast the timer below, and having it vanish mid-wait
   * left a parent on a screen that no longer said why. Those callers clear the
   * notice themselves when it stops being true — on a submit, a resend or a
   * trip back to the destination step.
   */
  persistSuccess?: boolean;
  /**
   * Substituted into the success message wherever it carries the
   * {destination} placeholder, formatted for reading.
   *
   * Ignored by any message without the placeholder, so a caller can pass it
   * for a whole step and let each notice decide whether it names where the
   * code went.
   */
  successDestination?: string;
}

// Success alerts are transient confirmations, so they dismiss themselves;
// errors stay until the user acts (they may need the text to fix the form).
const SUCCESS_AUTO_DISMISS_MS = 8000;

const DESTINATION_PLACEHOLDER = '{destination}';

// Messages are passed as translation keys and translated here, at render
// time, so an alert that is already on screen switches language with the
// rest of the UI. Raw strings (e.g. Cognito error messages) pass through
// t() unchanged because t() returns its input when no key matches.
const AlertMessages = ({
  error,
  successMessage,
  persistSuccess = false,
  successDestination,
}: AlertMessagesProps) => {
  const { t } = useLanguage();
  const [showError, setShowError] = useState(true);
  const [showSuccess, setShowSuccess] = useState(true);

  useEffect(() => {
    setShowError(true);
  }, [error]);

  useEffect(() => {
    setShowSuccess(true);
    if (!successMessage || persistSuccess) return;
    const timer = setTimeout(() => setShowSuccess(false), SUCCESS_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [successMessage, persistSuccess]);

  /**
   * The success message with its destination substituted in.
   *
   * Split around the placeholder rather than String.replace'd through it, so
   * the destination stays an element and can carry dir="ltr": a phone number
   * or email address inside an Arabic sentence has to render
   * left-to-right, and there is nowhere to say that in a plain string. Split
   * rather than concatenated so each language keeps the placeholder where its
   * own grammar puts it, instead of assuming it comes last.
   */
  const successBody = (message: string) => {
    if (!successDestination || !message.includes(DESTINATION_PLACEHOLDER)) return message;
    const [before, ...after] = message.split(DESTINATION_PLACEHOLDER);
    return (
      <>
        {before}
        <span dir="ltr">{formatDestination(successDestination)}</span>
        {after.join(DESTINATION_PLACEHOLDER)}
      </>
    );
  };

  return (
    <>
      {error && showError && (
        <Alert variant="danger" dismissible onClose={() => setShowError(false)}>
          {t(error)}
        </Alert>
      )}
      {successMessage && showSuccess && (
        <Alert
          variant="success"
          dismissible
          onClose={() => setShowSuccess(false)}
          // Stable hook for asserting on the whole alert rather than on one
          // of the strings inside it: every word here is localized, and the
          // destination is a separate element within the sentence.
          data-testid="alert-success"
        >
          {successBody(t(successMessage))}
        </Alert>
      )}
    </>
  );
};

export default AlertMessages;
