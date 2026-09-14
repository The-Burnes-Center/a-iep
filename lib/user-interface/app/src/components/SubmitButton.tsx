import React from 'react';
import { Button } from 'react-bootstrap';
import AIEPSpinner from './AIEPSpinner';
import './SubmitButton.css';

interface SubmitButtonProps {
  loading: boolean;
  buttonText: string;
  disabled?: boolean;
  type?: 'submit' | 'button' | 'reset';
}

const SubmitButton = ({ 
  loading, 
  buttonText, 
  disabled = loading,
  type = 'submit'
}: SubmitButtonProps) => {
  return (
    <Button 
      variant="primary" 
      type={type} 
      disabled={disabled} 
      className="submit-button-login"
    >
      {loading ? <AIEPSpinner size="sm" /> : buttonText}
    </Button>
  );
};

export default SubmitButton;