import React from 'react';
import Button from './ui/Button';

interface SubmitButtonProps {
  loading: boolean;
  buttonText: string;
  disabled?: boolean;
  type?: 'submit' | 'button' | 'reset';
  /** The id of a visible line that says why the button is off, when it is. */
  describedBy?: string;
}

/**
 * The sign-in step's primary button. A thin wrapper over the shared Button, so
 * the legacy call sites keep their props. While loading it shows the spinner
 * and keeps its label, so the name a screen reader hears does not disappear.
 */
const SubmitButton = ({
  loading,
  buttonText,
  disabled = loading,
  type = 'submit',
  describedBy
}: SubmitButtonProps) => {
  return (
    <Button
      variant="primary"
      type={type}
      disabled={disabled}
      busy={loading}
      fullWidth
      aria-describedby={describedBy}
    >
      {buttonText}
    </Button>
  );
};

export default SubmitButton;
