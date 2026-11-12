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

export interface RadioOption {
  value: string;
  label: string;
}

export interface RadiosProps {
  /** The question, as the fieldset's legend. */
  legend: string;
  hint?: string;
  name: string;
  options: RadioOption[];
  value?: string;
  onChange: (value: string) => void;
  /** Options that sit apart from the scale, after a gap (a "Not sure"). */
  setApart?: string[];
  /**
   * 'inline' for two or three short answers (Yes / No). 'scale' for an
   * agreement scale: the ordered answers side by side in one row, the
   * `setApart` ones (a "Not sure") on their own row under it. Otherwise
   * stacked.
   */
  layout?: 'stacked' | 'inline' | 'scale';
  className?: string;
}

/**
 * One question with one answer: a fieldset whose legend is the question and
 * whose options are native radios, the whole label the target. Stacked by
 * default so a long translation never clips an option.
 *
 * 'scale' puts an agreement scale in one row, a third of the stacked height,
 * and is still one radio group: arrow keys, the legend and the checked state
 * work as in any other. Not a slider: a slider has to start on some value, so
 * an untouched one either records an answer nobody gave or cannot be told
 * apart from one somebody did, and "Not sure" is not a point on it. Under
 * 360px (where four labels would clip) the row stacks again, in CSS.
 */
export const Radios: React.FC<RadiosProps> = ({
  legend, hint, name, options, value, onChange, setApart = [], layout = 'stacked', className,
}) => {
  const generated = useId();
  const groupId = `radios-${generated}`;
  const hintId = hint ? `${groupId}-hint` : undefined;
  const renderOption = (option: RadioOption) => {
    const optionId = `${groupId}-${option.value}`;
    const apart = setApart.includes(option.value);
    return (
      <label
        key={option.value}
        htmlFor={optionId}
        className={`ui-check-row ui-radio-row${apart && layout !== 'scale' ? ' ui-radio-row--apart' : ''}`}
      >
        <input
          id={optionId}
          type="radio"
          className="ui-check-input"
          name={name}
          value={option.value}
          checked={value === option.value}
          onChange={() => onChange(option.value)}
        />
        <span className="ui-check-label">{option.label}</span>
      </label>
    );
  };
  return (
    <fieldset
      className={`ui-radios ui-radios--${layout}${className ? ` ${className}` : ''}`}
      aria-describedby={hintId}
    >
      <legend className="ui-radios-legend">{legend}</legend>
      {hint && <p id={hintId} className="ui-field-hint">{hint}</p>}
      {layout === 'scale' ? (
        <>
          <div className="ui-radios-options ui-radios-scale">
            {options.filter((option) => !setApart.includes(option.value)).map(renderOption)}
          </div>
          {options.some((option) => setApart.includes(option.value)) && (
            <div className="ui-radios-options ui-radios-apart">
              {options.filter((option) => setApart.includes(option.value)).map(renderOption)}
            </div>
          )}
        </>
      ) : (
        <div className="ui-radios-options">{options.map(renderOption)}</div>
      )}
    </fieldset>
  );
};

export type TextAreaProps = FieldWords &
  Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'aria-describedby' | 'aria-invalid'> & { id?: string };

/** TextField's rules for a longer answer: label, hint, error, then the box. */
export const TextArea: React.FC<TextAreaProps> = ({ label, hint, error, optionalLabel, id, className, ...area }) => {
  const generated = useId();
  const fieldId = id ?? `area-${generated}`;
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
      <textarea
        id={fieldId}
        className="ui-input ui-textarea"
        aria-describedby={describedBy(hintId, errorId)}
        aria-invalid={error ? true : undefined}
        {...area}
      />
    </div>
  );
};
