import React from 'react';
import Button from './ui/Button';

interface LinkButtonProps {
  onClick: () => void;
  disabled: boolean;
  buttonText: string;
}

/** A low-emphasis action ("Back to Login"): the shared Button's text variant. */
const LinkButton = ({ onClick, disabled, buttonText }: LinkButtonProps) => {
  return (
    <Button variant="text" onClick={onClick} disabled={disabled} fullWidth>
      {buttonText}
    </Button>
  );
};

export default LinkButton;
