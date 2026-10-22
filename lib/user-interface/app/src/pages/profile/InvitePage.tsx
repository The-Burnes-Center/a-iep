import React, { useContext, useState } from 'react';
import { Alert, Button } from 'react-bootstrap';
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

/**
 * Renders `btn-invite`, a class Bootstrap and the app's global stylesheets
 * leave alone, so InvitePage.css alone decides how these buttons look.
 */
const BUTTON_VARIANT = 'invite';

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

                    {/* The whole link as wrapping text, not a read-only input:
                        an input cuts the link off on a phone, so a parent cannot
                        see what they are sending. Still selectable by hand. */}
                    <div className="invite-link-group">
                      <span className="invite-field-label" id="invite-link-label">
                        {t('invite.yourLink')}
                      </span>
                      <p className="invite-link-url" aria-labelledby="invite-link-label">
                        {inviteUrl}
                      </p>
                    </div>

                    <div className="invite-share-row">
                      {/* Variant "invite", not "primary": CustomLogin.css styles
                          every .btn-primary app-wide (margins, !important
                          colours), and the production bundle ships it to this
                          page. That margin pushed Copy into the link field and
                          Share past the card edge on iOS. */}
                      <div className="invite-actions">
                        <Button
                          variant={BUTTON_VARIANT}
                          className={copied ? 'invite-action is-copied' : 'invite-action'}
                          onClick={handleCopy}
                        >
                          <ClipboardIcon className="me-2" />
                          {copied ? t('invite.copied') : t('invite.copy')}
                        </Button>
                        {canNativeShare && (
                          <Button
                            variant={BUTTON_VARIANT}
                            className="invite-action"
                            onClick={handleNativeShare}
                          >
                            <ShareIcon className="me-2" />
                            {t('invite.share')}
                          </Button>
                        )}
                      </div>
                      <div className="invite-share-grid">
                        <Button
                          as="a"
                          href={`https://wa.me/?text=${encodeURIComponent(shareText)}`}
                          target="_blank"
                          rel="noreferrer"
                          variant={BUTTON_VARIANT}
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
                          variant={BUTTON_VARIANT}
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
                          variant={BUTTON_VARIANT}
                          className="invite-share-tile"
                          aria-label={t('invite.shareVia.email')}
                        >
                          <span className="invite-share-tile-icon">
                            <EnvelopeIcon />
                          </span>
                          Email
                        </Button>
                        <Button
                          variant={BUTTON_VARIANT}
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
