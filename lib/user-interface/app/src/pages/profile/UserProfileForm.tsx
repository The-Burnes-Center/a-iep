import React, { useState, useEffect, useContext } from 'react';
import PageLoading from '../../components/PageLoading';
import PageShell from '../../components/page/PageShell';
import PageHero from '../../components/page/PageHero';
import Button from '../../components/ui/Button';
import { TextField } from '../../components/ui/fields';
import { Notice } from '../../components/ui/feedback';
import { AppContext } from '../../common/app-context';
import { useAuth } from '../../common/auth-provider';
import { ApiClient } from '../../common/api-client/api-client';
import { UserProfile } from '../../common/types';
import { useLanguage, SupportedLanguage } from '../../common/language-context';
import { LANGUAGES, filterEnabledOptions } from '../../common/languages';
import { useNavigate } from 'react-router-dom';
import { STEP } from '../../common/breadcrumb-steps';
import DeleteProfileModal from './DeleteProfileModal';
import './ProfileForms.css';

/** Ties the reason under the disabled Update button to that button. */
const SAVE_REASON_ID = 'profile-save-reason';

export default function UserProfileForm() {
  const appContext = useContext(AppContext);
  const { logout, setAuthenticated } = useAuth();
  const apiClient = new ApiClient(appContext);
  const { t, setLanguage, enabledLanguages } = useLanguage();

  // Language options enabled for this environment
  const languageOptions = filterEnabledOptions(LANGUAGES, enabledLanguages);

  const [loading, setLoading] = useState(true);
  // A failed load replaces the form. A failed save does not: the parent keeps
  // what they typed and the error sits above the button.
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [originalProfile, setOriginalProfile] = useState<UserProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    loadProfile();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only profile load by design
  }, []);

  const loadProfile = async () => {
    try {
      setLoading(true);
      const data = await apiClient.profile.getProfile();
      setProfile(data);
      setOriginalProfile(data);
      setError(null);
    } catch (err) {
      setError(t('profile.error.serviceUnavailable'));
    } finally {
      setLoading(false);
    }
  };

  // Check if profile has changes
  const hasChanges = () => {
    if (!profile || !originalProfile) return false;
    return (
      profile.parentName !== originalProfile.parentName ||
      profile.secondaryLanguage !== originalProfile.secondaryLanguage
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;

    try {
      setSaving(true);
      setSaveError(null);
      await apiClient.profile.updateProfile(profile);

      // Update language context if secondary language changed
      if (profile.secondaryLanguage && profile.secondaryLanguage !== originalProfile?.secondaryLanguage) {
        setLanguage(profile.secondaryLanguage as SupportedLanguage);
      }

      setOriginalProfile(profile); // Update original profile after successful save
    } catch (err) {
      // Inline, above the button: the form stays and keeps what was typed.
      setSaveError(t('profile.error.update'));
    } finally {
      setSaving(false);
    }
  };

  const handlePreferredLanguageChange = (languageCode: string) => {
    setProfile(prev => prev ? {...prev, secondaryLanguage: languageCode} : null);
  };



  const handleDeleteProfile = () => {
    setShowDeleteModal(true);
  };

  // This page's own Log out button. Same reasoning as AccountCenter's: the
  // context's logout() is the only thing that ends a passwordless session,
  // and it runs before the navigation rather than behind it.
  const handleSignOut = async () => {
    try {
      await logout();
    } catch {
      setAuthenticated(false);
    }
    navigate('/', { replace: true });
  };

  if (loading) {
    return (
      <PageLoading message={t('profile.loading')} />
    );
  }

  if (error) {
    return (
      <PageShell>
        <Notice tone="error">{error}</Notice>
      </PageShell>
    );
  }

  const changed = hasChanges();

  return (
    <>
    <PageShell trail={[STEP.summary, STEP.profile]}>
      <PageHero titleId="profile-title" title={t('profile.title')} showFaces={false} />

      <form className="page-card" onSubmit={handleSubmit}>
        <TextField
          id="formParentName"
          label={t('profile.parentName')}
          value={profile?.parentName || ''}
          onChange={e => {
            setProfile(prev => prev ? {...prev, parentName: e.target.value} : null);
          }}
        />

        <div className="ui-field">
          <label className="ui-field-label" htmlFor="formPreferredLanguage">
            {t('profile.preferredLanguage')}
          </label>
          <select
            id="formPreferredLanguage"
            className="ui-input"
            value={profile?.secondaryLanguage || 'en'}
            onChange={e => handlePreferredLanguageChange(e.target.value)}
          >
            {languageOptions.map(option => (
              <option key={option.value} value={option.value}>
                {option.englishLabel}
              </option>
            ))}
          </select>
        </div>

        {saveError && <Notice tone="error">{saveError}</Notice>}

        {!changed && (
          <p id={SAVE_REASON_ID} className="page-card-text">
            {t('profile.reason.noChanges')}
          </p>
        )}

        <Button
          type="submit"
          fullWidth
          disabled={saving || !changed}
          busy={saving}
          busyLabel={t('profile.button.updating')}
          aria-describedby={!changed ? SAVE_REASON_ID : undefined}
        >
          {t('profile.button.update')}
        </Button>
      </form>

      <div className="page-card">
        <Button variant="secondary" fullWidth onClick={handleSignOut}>
          {t('profile.button.logOut')}
        </Button>
        {/* Opens a confirmation that says what is lost. The irreversible
            action is the danger button inside that modal, not this one. */}
        <Button variant="text" fullWidth onClick={handleDeleteProfile}>
          {t('profile.button.deleteProfile')}
        </Button>
      </div>
    </PageShell>
    <DeleteProfileModal
      show={showDeleteModal}
      onHide={() => setShowDeleteModal(false)}
    />
    </>
  );
}
