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
import './DeleteAccount.css';

export default function DeleteAccount() {
  const [processing, setProcessing] = useState(false);
  // Rendered below. This used to be a write-only `const [, setError]`, so a
  // failed deletion told the parent nothing at all: the toast that was meant to
  // carry it never reached anyone, and the state it also set had no reader.
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const { logout, setAuthenticated } = useAuth();
  const { t } = useLanguage();

  const handleDeleteProfile = async () => {
    setProcessing(true);
    setError(null);

    try {
      // Delete the entire user profile and all data
      await apiClient.profile.deleteProfile();
    } catch (err) {
      setError(t('delete.error.failed'));
      setProcessing(false);
      return;
    }

    // The account is gone. End the session BEFORE routing away, and through
    // the context's logout() so the passwordless handle goes with it: this
    // used to navigate first and sign out behind the navigation, which is the
    // window a page load lands in and rehydrates a session for a user who no
    // longer exists (see clearStaleSession in components/CustomLogin.tsx).
    // A handle here would 401 session_invalid and self-clear on next use, but
    // relying on that is relying on the server to undo something we should
    // never have left behind.
    try {
      await logout();
    } catch {
      // Deletion already succeeded and logout() has already cleared this
      // device. A failed Amplify call is not a failed deletion, so it does
      // not get reported to the parent as one.
      setAuthenticated(false);
    }
    navigate('/', { replace: true });
  };

  return (
    <PageShell
      trail={[
        { labelKey: 'deleteAccount.breadcrumb.account', to: '/account-center' },
        { labelKey: 'deleteAccount.breadcrumb.deleteAccount' },
      ]}
    >
      <PageHero
        titleId="delete-account-title"
        title={t('deleteAccount.title')}
        description={t('deleteAccount.description')}
        showFaces={false}
      />

      <div className="page-card">
        {error && <Notice tone="error">{error}</Notice>}

        {/* This page IS the confirmation: Account's "Delete your account" row
            brings the parent here, and what will be lost is listed before the
            one danger button. A second "are you sure" step on top of it added
            a press without adding safety (GOV.UK's confirmation-page pattern). */}
        <div className="delete-account-confirm" role="group" aria-labelledby="delete-account-warning">
          <p id="delete-account-warning" className="delete-account-warning">{t('delete.description1')}</p>
          <p className="delete-account-text">{t('delete.description2')}</p>
          <ul className="delete-account-list">
            <li>{t('delete.item1')}</li>
            <li>{t('delete.item2')}</li>
            <li>{t('delete.item3')}</li>
            <li>{t('delete.item4')}</li>
          </ul>
          <div className="delete-account-actions">
            <Button
              variant="danger"
              onClick={handleDeleteProfile}
              busy={processing}
              busyLabel={t('delete.button.processing')}
            >
              {t('deleteAccount.button.deleteMyAccount')}
            </Button>
            <Button variant="secondary" onClick={() => navigate('/account-center')} disabled={processing}>
              {t('delete.button.back')}
            </Button>
          </div>
        </div>
      </div>
    </PageShell>
  );
}
