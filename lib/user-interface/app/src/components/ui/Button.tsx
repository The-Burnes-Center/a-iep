import React from 'react';
import { Link, LinkProps } from 'react-router-dom';
import AIEPSpinner from '../AIEPSpinner';
import './ui.css';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'text';

interface CommonProps {
  /** primary: the one main action. danger: irreversible, after a confirmation. See docs/UI_STANDARDS.md. */
  variant?: ButtonVariant;
  /** Full width of its card or column, as every main action on a phone is. */
  fullWidth?: boolean;
  /** Shown before the label; decorative, so hidden from screen readers. */
  icon?: React.ReactNode;
  /** Working: shows a spinner and the busy label, and does nothing when pressed. */
  busy?: boolean;
  busyLabel?: string;
  className?: string;
  children: React.ReactNode;
}

type AsButton = CommonProps & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'> & { to?: undefined; href?: undefined };
type AsLink = CommonProps & Omit<LinkProps, 'className' | 'children'> & { to: LinkProps['to']; href?: undefined };
/** An address outside the app; opens in a new tab with rel=noopener. */
type AsExternal = CommonProps & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'className' | 'children'> & { href: string; to?: undefined };
export type ButtonProps = AsButton | AsLink | AsExternal;

/**
 * The app's one button. Everything a parent can press to do something looks
 * and behaves like this: at least 48px tall, a 24px pill, the condensed brand
 * face in uppercase, and a colour-only hover with no movement.
 *
 * Pass `to` and it renders a router Link that looks the same, so a button
 * that navigates is never a blue underlined link.
 *
 * Its own element and classes rather than Bootstrap's .btn, whose global
 * overrides in styles/buttons.css (several !important) are what produced
 * nine different button looks.
 */
const Button = React.forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>((props, ref) => {
  const { variant = 'primary', fullWidth = false, icon, busy = false, busyLabel, className, children, ...rest } = props;
  const classes = ['ui-button', `ui-button--${variant}`, fullWidth ? 'ui-button--full' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  const content = busy ? (
    <>
      <AIEPSpinner size="sm" className="ui-button-spinner" />
      <span>{busyLabel ?? children}</span>
    </>
  ) : (
    <>
      {icon && <span className="ui-button-icon" aria-hidden="true">{icon}</span>}
      <span>{children}</span>
    </>
  );

  if ('href' in rest && rest.href !== undefined) {
    const anchorProps = rest as Omit<AsExternal, keyof CommonProps>;
    return (
      <a ref={ref as React.Ref<HTMLAnchorElement>} className={classes} target="_blank" rel="noopener noreferrer" {...anchorProps}>
        {content}
      </a>
    );
  }

  if ('to' in rest && rest.to !== undefined) {
    const linkProps = rest as Omit<AsLink, keyof CommonProps>;
    return (
      <Link ref={ref as React.Ref<HTMLAnchorElement>} className={classes} {...linkProps}>
        {content}
      </Link>
    );
  }

  const { type = 'button', disabled, ...buttonProps } = rest as Omit<AsButton, keyof CommonProps>;
  return (
    <button
      ref={ref as React.Ref<HTMLButtonElement>}
      type={type}
      className={classes}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...buttonProps}
    >
      {content}
    </button>
  );
});

Button.displayName = 'Button';

export default Button;
