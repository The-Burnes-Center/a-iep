import React, { useId } from 'react';
import { IconAlertCircle } from '@tabler/icons-react';
import './ui.css';

interface FieldWords {
  /** Always visible, above the field. Never only a placeholder. */
  label: string;
  /** Why we ask, or the format, under the label. */
  hint?: string;
  /** What to do, not what went wrong ("Enter your child's name"). */
  error?: string | null;
  /** Shown as "(optional)" after the label. Required fields carry no mark. */
  optionalLabel?: string;
}

const describedBy = (...ids: Array<string | false | undefined>) => ids.filter(Boolean).join(' ') || undefined;

// role="alert": a field error only ever appears after the parent did
// something (pressed Save, left the field), and a screen reader user has to
// hear it then, not find it later.
const FieldError: React.FC<{ id: string; children: React.ReactNode }> = ({ id, children }) => (
  <p id={id} className="ui-field-error" role="alert">
    <IconAlertCircle size={18} stroke={2} aria-hidden="true" />
    <span>{children}</span>
  </p>
);

export type TextFieldProps = FieldWords &
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'aria-describedby' | 'aria-invalid'> & { id?: string };

/**
 * A labelled text field: label, then hint, then error, then the input, each
 * wired to it (aria-describedby, aria-invalid), at least 48px tall. What the
 * parent typed is never cleared by an error. GOV.UK's text input pattern.
 */
export const TextField: React.FC<TextFieldProps> = ({ label, hint, error, optionalLabel, id, className, ...input }) => {
  const generated = useId();
  const fieldId = id ?? `field-${generated}`;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  return (
    <div className={`ui-field${error ? ' ui-field--error' : ''}${className ? ` ${className}` : ''}`}>
      <label className="ui-field-label" htmlFor={fieldId}>
        {label}
        {optionalLabel && <span className="ui-field-optional"> {optionalLabel}</span>}
      </label>
      {hint && <p id={hintId} className="ui-field-hint">{hint}</p>}
      {error && errorId && <FieldError id={errorId}>{error}</FieldError>}
      <input
        id={fieldId}
        className="ui-input"
        aria-describedby={describedBy(hintId, errorId)}
        aria-invalid={error ? true : undefined}
        {...input}
      />
    </div>
  );
};

export type CheckboxProps = Omit<FieldWords, 'optionalLabel'> &
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'aria-describedby' | 'aria-invalid'> & { id?: string };

/**
 * A 24px checkbox whose whole label is the target. The audit measured the
 * old one at 16px with a 1.2:1 edge against the page.
 */
export const Checkbox: React.FC<CheckboxProps> = ({ label, hint, error, id, className, ...input }) => {
  const generated = useId();
  const fieldId = id ?? `check-${generated}`;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  return (
    <div className={`ui-check${error ? ' ui-field--error' : ''}${className ? ` ${className}` : ''}`}>
      {error && errorId && <FieldError id={errorId}>{error}</FieldError>}
      <label className="ui-check-row" htmlFor={fieldId}>
        <input
          id={fieldId}
          type="checkbox"
          className="ui-check-input"
          aria-describedby={describedBy(hintId, errorId)}
          aria-invalid={error ? true : undefined}
          {...input}
        />
        <span className="ui-check-label">{label}</span>
      </label>
      {hint && <p id={hintId} className="ui-field-hint ui-check-hint">{hint}</p>}
    </div>
  );
};
