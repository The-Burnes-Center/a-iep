import React, { useContext, useState } from 'react';
import {
  Container,
  Row,
  Col,
  Alert,
  Spinner,
  Breadcrumb,
  Button,
  Form,
  InputGroup,
} from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { useLanguage } from '../../common/language-context';
import MobileTopNavigation from '../../components/MobileTopNavigation';
import AIEPFooter from '../../components/AIEPFooter';
import './ProfileForms.css';
import './InvitePage.css';

export default function InvitePage() {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const navigate = useNavigate();
  const { t, language } = useLanguage();
  const [copied, setCopied] = useState(false);

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
      <Container className="text-center mt-5">
        <Spinner animation="border" role="status">
          <span className="visually-hidden">{t('invite.loading')}</span>
        </Spinner>
      </Container>
    );
  }

  return (
    <>
      <MobileTopNavigation />
      <div className="invite-page">
        <div className="mt-3 text-start px-4 breadcrumb-container">
          <Breadcrumb>
            <Breadcrumb.Item onClick={() => navigate('/account-center')}>
              {t('changeLanguage.breadcrumb.account')}
            </Breadcrumb.Item>
            <Breadcrumb.Item active>{t('invite.breadcrumb.invite')}</Breadcrumb.Item>
          </Breadcrumb>
        </div>

        <Container fluid className="update-profile-container">
          <Row style={{ width: '100%', justifyContent: 'center' }}>
            <Col xs={12} md={8} lg={6}>
              <div className="profile-form">
                <h4 className="update-profile-header">{t('invite.title')}</h4>
                <p className="update-profile-description">{t('invite.description')}</p>

                {error ? (
                  <Alert variant="danger">{t('invite.error')}</Alert>
                ) : (
                  <>
                    <Form.Label className="form-label mt-2">{t('invite.yourLink')}</Form.Label>
                    <InputGroup className="mb-3 invite-link-group">
                      <Form.Control
                        readOnly
                        value={inviteUrl}
                        onFocus={(e) => e.target.select()}
                        aria-label={t('invite.yourLink')}
                      />
                      <Button variant="outline-secondary" onClick={handleCopy}>
                        <i className="bi bi-clipboard me-1"></i>
                        {copied ? t('invite.copied') : t('invite.copy')}
                      </Button>
                    </InputGroup>

                    <div className="d-flex flex-wrap gap-2 mb-4">
                      {canNativeShare && (
                        <Button variant="primary" className="button-text" onClick={handleNativeShare}>
                          <i className="bi bi-share me-2"></i>
                          {t('invite.share')}
                        </Button>
                      )}
                      <Button
                        as="a"
                        href={`https://wa.me/?text=${encodeURIComponent(shareText)}`}
                        target="_blank"
                        rel="noreferrer"
                        variant="outline-secondary"
                        className="button-text invite-share-chip"
                      >
                        <i className="bi bi-whatsapp me-2"></i>
                        WhatsApp
                      </Button>
                      <Button
                        as="a"
                        href={`sms:?&body=${encodeURIComponent(shareText)}`}
                        target="_blank"
                        rel="noreferrer"
                        variant="outline-secondary"
                        className="button-text invite-share-chip"
                      >
                        <i className="bi bi-chat-dots me-2"></i>
                        SMS
                      </Button>
                      <Button
                        as="a"
                        href={`mailto:?subject=${encodeURIComponent(t('invite.emailSubject'))}&body=${encodeURIComponent(shareText)}`}
                        target="_blank"
                        rel="noreferrer"
                        variant="outline-secondary"
                        className="button-text invite-share-chip"
                      >
                        <i className="bi bi-envelope me-2"></i>
                        Email
                      </Button>
                    </div>

                    <Row className="mb-4 g-0 invite-stats-panel">
                      <Col xs={6} className="invite-stat">
                        <div className="invite-stat-value">{data?.clicks ?? 0}</div>
                        <div className="invite-stat-label">{t('invite.stats.clicks')}</div>
                      </Col>
                      <Col xs={6} className="invite-stat">
                        <div className="invite-stat-value">{data?.signups ?? 0}</div>
                        <div className="invite-stat-label">{t('invite.stats.joined')}</div>
                      </Col>
                    </Row>

                    <h5 className="text-start mb-2 invite-section-title">{t('invite.joins.title')}</h5>
                    {data && data.joins.length > 0 ? (
                      <div className="invite-joins-panel text-start">
                        {data.joins.map((join, index) => (
                          <div key={index} className="invite-join-row d-flex align-items-center">
                            <i className="bi bi-person-check me-3"></i>
                            {t('invite.joins.item')} · {formatJoinDate(join.joinedAt)}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-muted text-start invite-joins-empty">{t('invite.joins.empty')}</p>
                    )}
                  </>
                )}
              </div>
            </Col>
          </Row>
        </Container>
      </div>
      <AIEPFooter />
    </>
  );
}
