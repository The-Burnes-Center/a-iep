import React from 'react';
import Button from './ui/Button';
import './LoginMethodToggle.css';

interface LoginMethodToggleProps {
  showMobileLogin: boolean;
  onMobileLoginClick: () => void;
  onEmailLoginClick: () => void;
  mobileLoginText: string;
  emailLoginText: string;
  /** Names the pair of tabs for a screen reader ("How to sign in"). */
  groupLabel: string;
}

const LoginMethodToggle: React.FC<LoginMethodToggleProps> = ({
  showMobileLogin,
  onMobileLoginClick,
  onEmailLoginClick,
  mobileLoginText,
  emailLoginText,
  groupLabel
}) => {
  return (
    <div className="login-method-toggle-container mb-4">
      <div className="login-method-tabs" role="group" aria-label={groupLabel}>
        {/*
          The shared text Button, restyled as flat tabs. These stay buttons
          rather than becoming role="tab", because there are no tabpanels to
          point at — the form below is one region that rewrites itself.

          aria-pressed carries the selection, which is otherwise only a colour
          and an underline. A screen reader says "with phone, pressed".
        */}
        <Button
          variant="text"
          onClick={onMobileLoginClick}
          className={`login-method-tab${showMobileLogin ? ' is-selected' : ''}`}
          aria-pressed={showMobileLogin}
        >
          {mobileLoginText}
        </Button>
        <Button
          variant="text"
          onClick={onEmailLoginClick}
          className={`login-method-tab${!showMobileLogin ? ' is-selected' : ''}`}
          aria-pressed={!showMobileLogin}
        >
          {emailLoginText}
        </Button>
      </div>
    </div>
  );
};

export default LoginMethodToggle;
