import React, { useId } from 'react';
import { Form } from 'react-bootstrap';
import './EmailInput.css';
import FormLabel from './FormLabel';

interface EmailInputProps {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}

const EmailInput = ({ 
  label, 
  placeholder, 
  value, 
  onChange, 
  required = true 
}: EmailInputProps) => {
  // controlId wires the label's `for` to the input. Without it the label named
  // nothing and the field's only name was its placeholder.
  const controlId = useId();
  return (
    <Form.Group className="mb-3" controlId={controlId}>
      <FormLabel label={label} />
      <Form.Control
        type="email"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        className="email-input-control" 
      />
    </Form.Group>
  );
};

export default EmailInput;
