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
        // Deliberately not type="password": the digits are single-use and
        // expire in minutes, so hiding them buys nothing and costs a parent
        // the ability to check what they typed. A masked field also suppresses
        // the OS autofill below.
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={handleChange}
        maxLength={6}
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
        // E2E hook (inert in production): the field has no associated label
        // and its placeholder is localized, so tests need a stable handle
        data-testid="sms-code-input"
      />
    </Form.Group>
  );
};

export default VerificationCodeInput;