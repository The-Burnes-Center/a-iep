import React from 'react';
import { Form, InputGroup, Button } from 'react-bootstrap';
import FormLabel from './FormLabel';
import './PasswordInput.css';

interface PasswordInputProps {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  showPassword: boolean;
  onToggleVisibility: () => void;
  required?: boolean;
  /** Left to the browser's own heuristics (undefined) unless a caller has a
   * reason to be explicit -- e.g. a one-off file password, which is not an
   * account credential and should not be offered for the browser's saved-
   * password prompts the way a login or new-account password is. */
  autoComplete?: string;
}

const PasswordInput: React.FC<PasswordInputProps> = ({
  label,
  placeholder,
  value,
  onChange,
  showPassword,
  onToggleVisibility,
  required = false,
  autoComplete
}) => {
  return (
    <Form.Group className="password-input-container mb-3">
      <FormLabel label={label} />
      <InputGroup>
        <Form.Control
          type={showPassword ? "text" : "password"}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required={required}
          autoComplete={autoComplete}
          className="password-input-control"
        />
        <Button 
          variant="outline-secondary"
          onClick={onToggleVisibility}
        >
          <i className={`bi ${showPassword ? "bi-eye-slash" : "bi-eye"}`}></i>
        </Button>
      </InputGroup>
    </Form.Group>
  );
};

export default PasswordInput;