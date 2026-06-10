import React from 'react';
import { Alert } from 'react-bootstrap';
import { useLanguage } from '../common/language-context';
import './AlertMessages.css';

interface AlertMessagesProps {
  error: string | null;
  successMessage: string | null;
}

// Messages are passed as translation keys and translated here, at render
// time, so an alert that is already on screen switches language with the
// rest of the UI. Raw strings (e.g. Cognito error messages) pass through
// t() unchanged because t() returns its input when no key matches.
const AlertMessages = ({ error, successMessage }: AlertMessagesProps) => {
  const { t } = useLanguage();
  return (
    <>
      {error && <Alert variant="danger">{t(error)}</Alert>}
      {successMessage && <Alert variant="success">{t(successMessage)}</Alert>}
    </>
  );
};

export default AlertMessages;
