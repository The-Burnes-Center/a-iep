import React, { useEffect, useState } from 'react';
import { Alert } from 'react-bootstrap';
import { useLanguage } from '../common/language-context';
import './AlertMessages.css';

interface AlertMessagesProps {
  error: string | null;
  successMessage: string | null;
}

// Success alerts are transient confirmations, so they dismiss themselves;
// errors stay until the user acts (they may need the text to fix the form).
const SUCCESS_AUTO_DISMISS_MS = 8000;

// Messages are passed as translation keys and translated here, at render
// time, so an alert that is already on screen switches language with the
// rest of the UI. Raw strings (e.g. Cognito error messages) pass through
// t() unchanged because t() returns its input when no key matches.
const AlertMessages = ({ error, successMessage }: AlertMessagesProps) => {
  const { t } = useLanguage();
  const [showError, setShowError] = useState(true);
  const [showSuccess, setShowSuccess] = useState(true);

  useEffect(() => {
    setShowError(true);
  }, [error]);

  useEffect(() => {
    setShowSuccess(true);
    if (!successMessage) return;
    const timer = setTimeout(() => setShowSuccess(false), SUCCESS_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [successMessage]);

  return (
    <>
      {error && showError && (
        <Alert variant="danger" dismissible onClose={() => setShowError(false)}>
          {t(error)}
        </Alert>
      )}
      {successMessage && showSuccess && (
        <Alert variant="success" dismissible onClose={() => setShowSuccess(false)}>
          {t(successMessage)}
        </Alert>
      )}
    </>
  );
};

export default AlertMessages;
