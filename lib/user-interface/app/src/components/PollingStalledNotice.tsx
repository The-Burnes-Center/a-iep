import React from 'react';
import { Button } from 'react-bootstrap';
import './PollingStalledNotice.css';

interface PollingStalledNoticeProps {
  /** Already-translated explanation that checking has stopped. */
  message: string;
  /** Already-translated label for the control that asks again. */
  buttonLabel: string;
  /** Restarts polling and asks for a fresh read of the document. */
  onCheckAgain: () => void;
}

/**
 * Shown in place of a wait that has stopped moving. The caller owns the live
 * region that announces `message`, and mounts it before the stop, so the
 * announcement is made when the stop happens.
 */
const PollingStalledNotice: React.FC<PollingStalledNoticeProps> = ({
  message,
  buttonLabel,
  onCheckAgain,
}) => (
  <div className="polling-stalled-notice">
    <p className="polling-stalled-message">{message}</p>
    <Button className="polling-stalled-button" variant="light" onClick={onCheckAgain}>
      {buttonLabel}
    </Button>
  </div>
);

export default PollingStalledNotice;
