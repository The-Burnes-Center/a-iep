import React from 'react';
import { IconAlertCircle, IconAlertTriangle, IconCircleCheck, IconCircleDashed, IconClock, IconInfoCircle } from '@tabler/icons-react';
import './ui.css';

export type StatusTone = 'ready' | 'working' | 'problem' | 'neutral';

const TAG_ICON: Record<StatusTone, React.ReactNode> = {
  ready: <IconCircleCheck size={18} stroke={2} aria-hidden="true" />,
  working: <IconClock size={18} stroke={2} aria-hidden="true" />,
  problem: <IconAlertTriangle size={18} stroke={2} aria-hidden="true" />,
  neutral: <IconCircleDashed size={18} stroke={2} aria-hidden="true" />,
};

/** A status in words and an icon, never colour alone. */
export const StatusTag: React.FC<{ tone: StatusTone; children: React.ReactNode; 'data-testid'?: string }> = ({
  tone,
  children,
  ...rest
}) => (
  <span className={`ui-tag ui-tag--${tone}`} {...rest}>
    {TAG_ICON[tone]}
    <span>{children}</span>
  </span>
);

export type NoticeTone = 'info' | 'success' | 'warning' | 'error';

const NOTICE_ICON: Record<NoticeTone, React.ReactNode> = {
  info: <IconInfoCircle size={22} stroke={2} aria-hidden="true" />,
  success: <IconCircleCheck size={22} stroke={2} aria-hidden="true" />,
  warning: <IconAlertTriangle size={22} stroke={2} aria-hidden="true" />,
  error: <IconAlertCircle size={22} stroke={2} aria-hidden="true" />,
};

interface NoticeProps {
  tone: NoticeTone;
  title?: string;
  children?: React.ReactNode;
  /**
   * Announce it. Errors always are (role="alert"); others only when they
   * appear after something the parent did, never on first render.
   */
  announce?: boolean;
  'data-testid'?: string;
}

/** Information, success, a warning or an error: an icon, a heading, and what to do. */
export const Notice: React.FC<NoticeProps> = ({ tone, title, children, announce = false, ...rest }) => {
  const role = tone === 'error' ? 'alert' : announce ? 'status' : undefined;
  return (
    <div className={`ui-notice ui-notice--${tone}`} role={role} {...rest}>
      <span className="ui-notice-icon">{NOTICE_ICON[tone]}</span>
      <div className="ui-notice-body">
        {title && <p className="ui-notice-title">{title}</p>}
        {children && <div className="ui-notice-text">{children}</div>}
      </div>
    </div>
  );
};
