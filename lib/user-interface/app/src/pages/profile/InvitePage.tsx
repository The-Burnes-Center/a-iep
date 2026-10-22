import React, { useContext, useState } from 'react';
import {
  Alert,
  Button,
  Form,
  InputGroup,
} from 'react-bootstrap';
import { useQuery } from '@tanstack/react-query';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { useLanguage } from '../../common/language-context';
import PageLoading from '../../components/PageLoading';
import Breadcrumbs from '../../components/Breadcrumbs';
import {
  ClipboardIcon,
  EnvelopeIcon,
  PersonCheckIcon,
  QrCodeIcon,
  ShareIcon,
  SmsIcon,
  WhatsAppIcon,
} from './InviteIcons';
import InviteQrCode from './InviteQrCode';
import InviteQrOverlay from './InviteQrOverlay';
import './InvitePage.css';

export default function InvitePage() {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const { t, language } = useLanguage();
  const [copied, setCopied] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['referral', 'me'],
    queryFn: () => apiClient.referral.getMyReferral(),
  });

  const inviteUrl = data ? `${window.location.origin}/r/${data.code}` : '';
  const shareText = `${t('invite.shareMessage')} ${inviteUrl}`;
  const canNativeShare = typeof navigator !== 'undefined' && 'share' in navigator;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (older browser); the field is selectable
    }
  };

  const handleNativeShare = () => {
    navigator.share({ text: shareText }).catch(() => {
      // User dismissed the share sheet; nothing to do
    });
  };

  const formatJoinDate = (iso: string) =>
    new Date(iso).toLocaleDateString(language, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

  if (isLoading) {
    return (
      <PageLoading message={t('invite.loading')} />
    );
  }

  return (
    <>
      <div className="invite-page">
        <Breadcrumbs
          trail={[
            { labelKey: 'changeLanguage.breadcrumb.account', to: '/account-center' },
            { labelKey: 'invite.breadcrumb.invite' },
          ]}
        />

        <div className="invite-shell">
              <section className="invite-hero" aria-labelledby="invite-title">
                <div className="invite-hero-text">
                  <h1 id="invite-title" className="invite-hero-title">{t('invite.title')}</h1>
                  <p className="invite-hero-description">{t('invite.description')}</p>
                </div>
                {inviteUrl && (
                  <div className="invite-hero-qr">
                    {/* The same overlay the QR chip opens: tapping the small
                        code is the obvious way to ask for a bigger one. */}
                    <button
                      type="button"
                      className="invite-hero-qr-button"
                      onClick={() => setQrOpen(true)}
                      aria-label={t('invite.qr.enlarge')}
                    >
                      <InviteQrCode value={inviteUrl} label={t('invite.qr.imageAlt')} />
                    </button>
                    <p className="invite-hero-hint">{t('invite.qr.inlineHint')}</p>
                  </div>
                )}
              </section>

              {error ? (
                <Alert variant="danger">{t('invite.error')}</Alert>
              ) : (
                <>
                  <section className="invite-card invite-card--share" aria-labelledby="invite-share-title">
                    <h2 id="invite-share-title" className="invite-card-title">
                      {t('invite.shareSection.title')}
                    </h2>

                    <Form.Label className="invite-field-label" htmlFor="invite-link">
                      {t('invite.yourLink')}
                    </Form.Label>
                    <InputGroup className="mb-3 invite-link-group">
                      <Form.Control
                        id="invite-link"
                        readOnly
                        value={inviteUrl}
                        onFocus={(e) => e.target.select()}
                        aria-label={t('invite.yourLink')}
                      />
                      <Button
                        variant="primary"
                        className={copied ? 'invite-copy is-copied' : 'invite-copy'}
                        onClick={handleCopy}
                      >
                        <ClipboardIcon className="me-2" />
                        {copied ? t('invite.copied') : t('invite.copy')}
                      </Button>
                    </InputGroup>

                    <div className="invite-share-row">
                      {canNativeShare && (
                        <Button variant="primary" className="invite-share-primary" onClick={handleNativeShare}>
                          <ShareIcon className="me-2" />
                          {t('invite.share')}
                        </Button>
                      )}
                      <div className="invite-share-grid">
                        <Button
                          as="a"
                          href={`https://wa.me/?text=${encodeURIComponent(shareText)}`}
                          target="_blank"
                          rel="noreferrer"
                          variant="light"
                          className="invite-share-tile"
                          aria-label={t('invite.shareVia.whatsapp')}
                        >
                          <span className="invite-share-tile-icon">
                            <WhatsAppIcon />
                          </span>
                          WhatsApp
                        </Button>
                        <Button
                          as="a"
                          href={`sms:?&body=${encodeURIComponent(shareText)}`}
                          target="_blank"
                          rel="noreferrer"
                          variant="light"
                          className="invite-share-tile"
                          aria-label={t('invite.shareVia.sms')}
                        >
                          <span className="invite-share-tile-icon">
                            <SmsIcon />
                          </span>
                          SMS
                        </Button>
                        <Button
                          as="a"
                          href={`mailto:?subject=${encodeURIComponent(t('invite.emailSubject'))}&body=${encodeURIComponent(shareText)}`}
                          target="_blank"
                          rel="noreferrer"
                          variant="light"
                          className="invite-share-tile"
                          aria-label={t('invite.shareVia.email')}
                        >
                          <span className="invite-share-tile-icon">
                            <EnvelopeIcon />
                          </span>
                          Email
                        </Button>
                        <Button
                          variant="light"
                          className="invite-share-tile"
                          onClick={() => setQrOpen(true)}
                        >
                          <span className="invite-share-tile-icon">
                            <QrCodeIcon />
                          </span>
                          {t('invite.qr.show')}
                        </Button>
                      </div>
                    </div>
                  </section>

                  <section className="invite-card invite-card--stats" aria-labelledby="invite-stats-title">
                    <h2 id="invite-stats-title" className="invite-card-title">
                      {t('invite.stats.title')}
                    </h2>
                    <div className="invite-stats-panel">
                      <div className="invite-stat invite-stat--visits">
                        <div className="invite-stat-value">{data?.clicks ?? 0}</div>
                        <div className="invite-stat-label">{t('invite.stats.clicks')}</div>
                      </div>
                      <div className="invite-stat invite-stat--joined">
                        <div className="invite-stat-value">{data?.signups ?? 0}</div>
                        <div className="invite-stat-label">{t('invite.stats.joined')}</div>
                      </div>
                    </div>
                  </section>

                  <section className="invite-card invite-card--joins" aria-labelledby="invite-joins-title">
                    <h2 id="invite-joins-title" className="invite-card-title">
                      {t('invite.joins.title')}
                    </h2>
                    {data && data.joins.length > 0 ? (
                      <ul className="invite-joins-panel">
                        {data.joins.map((join, index) => (
                          <li key={index} className="invite-join-row">
                            <span className="invite-join-badge">
                              <PersonCheckIcon />
                            </span>
                            <span className="invite-join-text">{t('invite.joins.item')}</span>
                            <time className="invite-join-date" dateTime={join.joinedAt}>
                              {formatJoinDate(join.joinedAt)}
                            </time>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="invite-joins-empty">{t('invite.joins.empty')}</p>
                    )}
                  </section>
                </>
              )}
        </div>
      </div>
      {/* `inviteUrl` is the same value every other share control sends, so the
          code can never encode a different link. Empty until the referral
          loads, and a QR of an empty string is meaningless, hence the guard. */}
      {qrOpen && inviteUrl && (
        <InviteQrOverlay url={inviteUrl} onClose={() => setQrOpen(false)} />
      )}
    </>
  );
}
