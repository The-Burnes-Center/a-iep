import React, { useState, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { useAuth } from '../../common/auth-provider';
import { useLanguage } from '../../common/language-context';
import PageShell from '../../components/page/PageShell';
import PageHero from '../../components/page/PageHero';
import Button from '../../components/ui/Button';
import { Notice } from '../../components/ui/feedback';
import { STEP } from '../../common/breadcrumb-steps';
import './RevokeConsent.css';

const RevokeConsent: React.FC = () => {
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const { logout, setAuthenticated } = useAuth();
  const { t } = useLanguage();

  const handleRevokeConsent = async () => {
    setProcessing(true);
    setError(null);

    try {
      // Update profile to set consentGiven to false
      await apiClient.profile.updateProfile({ consentGiven: false });
    } catch (err) {
      setError(t('revoke.error.failed'));
      setProcessing(false);
      return;
    }

    // Sign out through the context: consent is withdrawn, so the session that
    // was granted under it has to end on this device too, handle included.
    try {
      await logout();
    } catch {
      // Consent is already withdrawn and this device is already cleared, so
      // this is not the "revoke failed" the parent needs to hear about.
      setAuthenticated(false);
    }

    // Redirect to sign-in page
    navigate('/', { replace: true });
  };

  const handleCancel = () => {
    navigate('/profile');
  };

  // This page is the confirmation: it says what is lost before the one
  // irreversible button, and "Take me back" is the way out.
  return (
    <PageShell trail={[STEP.account, { labelKey: 'revoke.breadcrumb.revoke' }]}>
      <PageHero titleId="revoke-consent-title" title={t('revoke.title')} showFaces={false} />

      <div className="page-card">
        <p className="page-card-text">{t('revoke.description1')}</p>
        <p className="page-card-text">{t('revoke.description2')}</p>

        {error && <Notice tone="error">{error}</Notice>}

        <div className="revoke-consent-actions">
          <Button
            variant="danger"
            onClick={handleRevokeConsent}
            busy={processing}
            busyLabel={t('revoke.button.processing')}
          >
            {t('revoke.button.revoke')}
          </Button>
          <Button variant="secondary" onClick={handleCancel} disabled={processing}>
            {t('revoke.button.back')}
          </Button>
        </div>
      </div>
    </PageShell>
  );
};

export default RevokeConsent;
