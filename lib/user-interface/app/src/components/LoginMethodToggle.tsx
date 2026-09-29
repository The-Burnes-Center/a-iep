import React from 'react';
import { Button } from 'react-bootstrap';
import './LoginMethodToggle.css';

interface LoginMethodToggleProps {
  showMobileLogin: boolean;
  onMobileLoginClick: () => void;
  onEmailLoginClick: () => void;
  mobileLoginText: string;
  emailLoginText: string;
}

const LoginMethodToggle: React.FC<LoginMethodToggleProps> = ({
  showMobileLogin,
  onMobileLoginClick,
  onEmailLoginClick,
  mobileLoginText,
  emailLoginText
}) => {
  return (
    <div className="login-method-toggle-container mb-4">
      <div className="login-method-tabs" role="group">
        {/*
          variant="link" for the flat base: it is the one variant that brings
          no fill and no border of its own to override. These stay <button>s
          rather than becoming role="tab", because there are no tabpanels to
          point at — the form below is one region that rewrites itself.

          aria-pressed carries the selection, which is otherwise only a colour
          and an underline. A screen reader says "with phone, pressed".
        */}
        <Button
          variant='link'
          onClick={onMobileLoginClick}
          className={`login-method-tab${showMobileLogin ? ' is-selected' : ''}`}
          aria-pressed={showMobileLogin}
        >
          {mobileLoginText}
        </Button>
        <Button
          variant='link'
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
