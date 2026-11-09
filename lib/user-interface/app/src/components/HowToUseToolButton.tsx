import React from 'react';
import Button from './ui/Button';
import './HowToUseToolButton.css';

interface HowToUseToolButtonProps {
  onClick: () => void;
  buttonText: string;
  disabled?: boolean;
}

const HowToUseToolButton = ({ onClick, buttonText, disabled = false }: HowToUseToolButtonProps) => {
  return (
    <Button 
      variant="primary" 
      onClick={onClick}
      disabled={disabled}
      className="how-to-use-tool-button"
    >
      {buttonText}
    </Button>
  );
};

export default HowToUseToolButton;
