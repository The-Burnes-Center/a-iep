import React, { useId } from 'react';
import { Form, InputGroup } from 'react-bootstrap';
import Button from './ui/Button';
import FormLabel from './FormLabel';
import { useLanguage } from '../common/language-context';
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
  const { t } = useLanguage();
  const controlId = useId();
  return (
    <Form.Group className="password-input-container mb-3" controlId={controlId}>
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
        {/* Icon only, so it needs a name. The name is fixed ("Show password")
            and aria-pressed carries the state, the usual toggle-button pattern:
            a name that changes with the state would be announced twice. */}
        <Button
          variant="text"
          className="password-toggle"
          onClick={onToggleVisibility}
          aria-label={t('auth.showPassword')}
          aria-pressed={showPassword}
        >
          <i className={`bi ${showPassword ? "bi-eye-slash" : "bi-eye"}`} aria-hidden="true"></i>
        </Button>
      </InputGroup>
    </Form.Group>
  );
};

export default PasswordInput;
