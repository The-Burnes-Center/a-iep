import React from 'react';
import Button from './ui/Button';
import './CreateAccountButton.css';

interface CreateAccountButtonProps {
  onClick: () => void;
  buttonText: string;
  disabled?: boolean;
}

/**
 * The landing banner's one call to action. The shared primary Button, in the
 * banner's own deeper green (CreateAccountButton.css), because the primary
 * green is the banner's own colour and the button would vanish into it.
 */
const CreateAccountButton = ({ onClick, buttonText, disabled = false }: CreateAccountButtonProps) => {
  return (
    <Button
      variant="primary"
      onClick={onClick}
      disabled={disabled}
      className="create-account-button"
    >
      {buttonText}
    </Button>
  );
};

export default CreateAccountButton;
