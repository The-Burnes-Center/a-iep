/**
 * The QR code for one referral link, as the admin console shows it.
 *
 * The same branded InviteQrCode parents see on their invite page, so a
 * campaign poster and a parent's phone carry one look and one tested encoder.
 * Admins print these, so the code downloads as a PNG (for slides and email)
 * and an SVG (for anything printed larger); both are built from the drawn
 * code itself (qr-export.ts). Full screen reuses the parent overlay, for a
 * booth or a room where people scan off a laptop or phone.
 */
import React, { useRef, useState } from 'react';
import { Alert, Badge, Button, Modal } from 'react-bootstrap';
import { saveAs } from 'file-saver';
import { ReferralLink } from '../../common/types';
import InviteQrCode from '../profile/InviteQrCode';
import InviteQrOverlay from '../profile/InviteQrOverlay';
import { qrPngBlob, qrSvgBlob } from './qr-export';

type ExportFormat = 'png' | 'svg';

interface AdminQrModalProps {
  link: ReferralLink;
  /** The exact URL the console's Copy buttons send. */
  url: string;
  isCopied: boolean;
  onCopy: () => void;
  onClose: () => void;
}

const titleFor = (link: ReferralLink) =>
  link.type === 'user' ? link.ownerName || 'Parent invite' : link.name || link.code;

export default function AdminQrModal({ link, url, isCopied, onCopy, onClose }: AdminQrModalProps) {
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const frameRef = useRef<HTMLButtonElement>(null);

  const download = async (format: ExportFormat) => {
    const svg = frameRef.current?.querySelector<SVGSVGElement>('svg.invite-qr-code');
    if (!svg) return;
    setExportError(null);
    try {
      const blob = format === 'png' ? await qrPngBlob(svg) : qrSvgBlob(svg);
      saveAs(blob, `aiep-qr-${link.code}.${format}`);
    } catch (err) {
      console.error('QR download failed', err);
      setExportError(`Could not create the ${format.toUpperCase()}. Try the other format.`);
    }
  };

  if (isFullScreen) {
    return <InviteQrOverlay url={url} onClose={() => setIsFullScreen(false)} />;
  }

  return (
    <Modal show onHide={onClose} centered dialogClassName="admin-qr-modal">
      <Modal.Header closeButton>
        <Modal.Title className="admin-qr-title">{titleFor(link)}</Modal.Title>
      </Modal.Header>
      <Modal.Body className="admin-qr-body">
        <div className="admin-qr-meta">
          <code>{link.code}</code>
          {link.channel && <Badge bg="light" text="dark">{link.channel}</Badge>}
          {!link.active && <Badge bg="secondary">inactive</Badge>}
        </div>
        <button
          type="button"
          className="admin-qr-frame"
          ref={frameRef}
          onClick={() => setIsFullScreen(true)}
          aria-label="Show the QR code full screen"
        >
          <InviteQrCode value={url} label={`QR code for ${url}`} />
        </button>
        <div className="admin-qr-link">
          <p className="admin-qr-url">{url}</p>
          <Button variant="outline-secondary" size="sm" className="admin-qr-copy" onClick={onCopy}>
            <i className={`bi ${isCopied ? 'bi-check-lg' : 'bi-clipboard'} me-1`}></i>
            {isCopied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        {exportError && <Alert variant="danger" className="mb-0 py-2">{exportError}</Alert>}
      </Modal.Body>
      <Modal.Footer className="admin-qr-actions">
        <Button variant="outline-secondary" className="button-text" onClick={() => setIsFullScreen(true)}>
          <i className="bi bi-arrows-fullscreen me-1"></i>Full screen
        </Button>
        <Button variant="outline-secondary" className="button-text" onClick={() => download('svg')}>
          <i className="bi bi-filetype-svg me-1"></i>SVG for print
        </Button>
        <Button className="button-text" onClick={() => download('png')}>
          <i className="bi bi-download me-1"></i>Download PNG
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
