import React, { useId, useState } from 'react';
import { Dropdown } from 'react-bootstrap';
import { IconLanguage } from '@tabler/icons-react';
import './LanguageMenu.css';

/**
 * The one language menu every picker in the app renders: the in-app bar's
 * (LanguagePreferenceDropdown, and the summary's own picker) and the public
 * header's (LanguageDropdown). The pickers differ in what a choice does; how
 * the menu is announced and operated is the same, so it lives here once.
 *
 * What it gets right that the three separate menus did not (WCAG 2.2 AA):
 *  - The toggle's name says what it is AND contains the visible text
 *    ("Preferred Language: English"), so a screen reader hears the purpose
 *    and a voice-control user can say the word on the button (2.5.3, 2.4.6).
 *  - Every language name is marked up in its own language, so 中文 and
 *    العربية are not read with an English voice (3.1.2).
 *  - The chosen language is announced as current, not shown by a background
 *    colour alone (1.3.1, 4.1.2). react-bootstrap's `active` would put
 *    aria-selected on a button, which no role allows, so the class and the
 *    state are set here instead.
 *  - A menu that cannot be used right now stays focusable and says why
 *    (aria-disabled plus a description), where `disabled` dropped keyboard
 *    focus and explained nothing.
 *  - Items are real buttons, not href="#" links.
 */

export interface LanguageMenuOption {
  value: string;
  /** The language's own name (endonym), e.g. "Español". */
  label: string;
  /** Optional note under the name, e.g. "Not translated yet". */
  hint?: string;
}

interface LanguageMenuProps {
  options: LanguageMenuOption[];
  selected: string;
  onSelect: (value: string) => void;
  /** What the control is for, spoken before the language name. */
  name: string;
  /** When set, the menu will not open and this is read as the reason. */
  unavailableReason?: string;
  /** 'bar': icon on phones, pill on desktop. 'plain': the name only. */
  variant?: 'bar' | 'plain';
  /** Show names in capitals (styling only; the spoken name is unchanged). */
  uppercase?: boolean;
  id?: string;
  className?: string;
  toggleVariant?: string;
  /** E2E hooks: `${testIdPrefix}-toggle`, `${testIdPrefix}-option-${value}`. */
  testIdPrefix?: string;
  /** Extra per-option hook, kept so existing E2E selectors still resolve. */
  optionTestId?: (value: string) => string;
  hintTestId?: (value: string) => string;
  /** False while what the picker shows is a stand-in (e.g. profile loading). */
  ready?: boolean;
  /** Which edge of the toggle the menu lines up with. */
  align?: 'start' | 'end';
}

const RTL_LANGUAGES = new Set(['ar']);
const dirOf = (code: string) => (RTL_LANGUAGES.has(code) ? 'rtl' : 'ltr');

export default function LanguageMenu({
  options,
  selected,
  onSelect,
  name,
  unavailableReason,
  variant = 'plain',
  uppercase = false,
  id,
  className,
  toggleVariant = 'outline-primary',
  testIdPrefix,
  optionTestId,
  hintTestId,
  ready = true,
  align = 'end',
}: LanguageMenuProps) {
  const [open, setOpen] = useState(false);
  const reasonId = useId();
  const isUnavailable = Boolean(unavailableReason);
  const current = options.find((option) => option.value === selected);
  const currentLabel = current?.label ?? selected;

  return (
    <Dropdown
      className={['language-menu', uppercase && 'language-menu--uppercase', className].filter(Boolean).join(' ')}
      align={align}
      show={open && !isUnavailable}
      onToggle={(next) => setOpen(isUnavailable ? false : next)}
    >
      <Dropdown.Toggle
        id={id}
        variant={toggleVariant}
        size="sm"
        aria-disabled={isUnavailable || undefined}
        aria-describedby={isUnavailable ? reasonId : undefined}
        data-testid={testIdPrefix ? `${testIdPrefix}-toggle` : undefined}
        data-ready={ready ? 'true' : 'false'}
      >
        <span className="visually-hidden">{`${name}: `}</span>
        {variant === 'bar' && (
          <IconLanguage className="nav-language-icon" size={24} stroke={1.75} aria-hidden="true" />
        )}
        <span
          className={variant === 'bar' ? 'nav-language-label language-menu-name' : 'language-menu-name'}
          lang={current ? current.value : undefined}
          dir={current ? dirOf(current.value) : undefined}
        >
          {currentLabel}
        </span>
      </Dropdown.Toggle>
      {isUnavailable && (
        <span id={reasonId} className="visually-hidden">
          {unavailableReason}
        </span>
      )}
      <Dropdown.Menu>
        {options.map((option) => {
          const isCurrent = option.value === selected;
          return (
            <Dropdown.Item
              key={option.value}
              as="button"
              type="button"
              className={['language-menu-item', isCurrent && 'active'].filter(Boolean).join(' ')}
              aria-current={isCurrent ? 'true' : undefined}
              onClick={() => onSelect(option.value)}
              data-testid={
                optionTestId?.(option.value) ??
                (testIdPrefix ? `${testIdPrefix}-option-${option.value}` : undefined)
              }
            >
              <span className="language-menu-name" lang={option.value} dir={dirOf(option.value)}>
                {option.label}
              </span>
              {option.hint && (
                <small className="language-menu-hint" data-testid={hintTestId?.(option.value)}>
                  {option.hint}
                </small>
              )}
            </Dropdown.Item>
          );
        })}
      </Dropdown.Menu>
    </Dropdown>
  );
}
