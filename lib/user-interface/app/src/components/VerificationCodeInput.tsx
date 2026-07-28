import React from 'react';
import { Form } from 'react-bootstrap';
import FormLabel from './FormLabel';
import './VerificationCodeInput.css';

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
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Remove non-digits and limit to 6 characters
    const sanitizedValue = e.target.value.replace(/\D/g, '').slice(0, 6);
    onChange(sanitizedValue);
  };

  return (
    <Form.Group className="mb-3">
      <FormLabel label={label} />
      <Form.Control
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={handleChange}
        maxLength={6}
        required={required}
        className="sms-code-input"
        autoFocus={autoFocus}
        // E2E hook (inert in production): the field has no associated label
        // and its placeholder is localized, so tests need a stable handle
        data-testid="sms-code-input"
      />
    </Form.Group>
  );
};

export default VerificationCodeInput;