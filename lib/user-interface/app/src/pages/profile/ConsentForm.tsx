import React, { useState, useEffect, useContext } from 'react';
import PageLoading from '../../components/PageLoading';
import { useNavigate } from 'react-router-dom';
import { DEFAULT_CHILD_NAME } from '../../common/features';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { UserProfile } from '../../common/types';
import { useLanguage } from '../../common/language-context';
import { useFeatures } from '../../common/hooks/use-features';
import { isStudentNameMissing } from '../../common/features';
import { STEP } from '../../common/breadcrumb-steps';
import PageShell from '../../components/page/PageShell';
import PageHero from '../../components/page/PageHero';
import Button from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/fields';
import { Notice } from '../../components/ui/feedback';
import './ProfileForms.css';

export default function ConsentForm() {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { isFeatureEnabled } = useFeatures();

  const [isChecked, setIsChecked] = useState(false);
  // Pressing Continue before ticking the box shows the reason, linked to the
  // checkbox. The button itself stays enabled: a disabled one with nothing on
  // screen was a dead end, and the reason was unreachable behind it.
  const [showConsentError, setShowConsentError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);

  // Load profile on component mount
  useEffect(() => {
    loadProfile();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only profile load by design
  }, []);

  const loadProfile = async () => {
    try {
      setLoading(true);
      const data = await apiClient.profile.getProfile();
      setProfile(data);

      // Set initial checkbox state based on consentGiven value
      if (data.consentGiven) {
        setIsChecked(true);
      }

      setError(null);
    } catch (err) {
      setError(t('profile.error.serviceUnavailable'));
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setIsChecked(e.target.checked);
    if (showConsentError) setShowConsentError(false);
  };

  /**
   * The next onboarding step after consent: the student's name where that gate
   * is on and the name is still missing, otherwise straight on to how the tool
   * works. Neither branch ends onboarding -- /how-to-use-the-tool leads to the
   * PDF question and then to the upload.
   */
  const continueOnboarding = () => {
    if (isFeatureEnabled('studentNameGate') && isStudentNameMissing(profile)) {
      navigate('/view-update-add-child', { state: { onboardingContinue: true } });
    } else {
      navigate('/how-to-use-the-tool');
    }
  };

  const handleContinue = async () => {
    if (!isChecked) {
      setShowConsentError(true);
      return;
    }

    // If consent was already given, continue on; ask for the student's name
    // first, then the parent's, if the profile still has either missing
    // (product call: student before parent, never the reverse). Each is
    // skipped where its own gate is off, which is production today for both:
    // the pipeline that makes the student's name load-bearing, and the
    // referral features that are the only consumers of the parent's name,
    // are both dark there, so asking would collect a value nothing uses yet.
    if (profile?.consentGiven) {
      continueOnboarding();
      return;
    }

    // Otherwise update the profile with consent
    try {
      setSaving(true);
      await apiClient.profile.updateProfile({ consentGiven: true });

      // Check if user has any children - if not, create a default child
      // The user can update this later if needed
      if (!profile?.children || profile.children.length === 0) {
        try {
          await apiClient.profile.addChild(DEFAULT_CHILD_NAME, profile?.city || 'Not specified');
        } catch (childError) {
          // Don't fail the flow if child creation fails - user can add manually later
        }
      }

      // Mark onboarding as completed since user has finished all required steps
      try {
        await apiClient.profile.updateProfile({ showOnboarding: false });
      } catch (onboardingError) {
        // Don't fail the flow if this update fails
      }

      continueOnboarding();
    } catch (err) {
      setError(t('consent.error.saveFailedRetry'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <PageLoading message={t('common.loading')} />
    );
  }

  if (error) {
    return (
      <PageShell>
        <PageHero titleId="consent-title" title={t('consent.title')} />
        <section className="page-card">
          <Notice tone="error">{error}</Notice>
          <Button variant="primary" fullWidth onClick={loadProfile}>{t('common.tryAgain')}</Button>
        </section>
      </PageShell>
    );
  }

  // The trail points at the previous onboarding step, NOT at '/'. The landing
  // page is the logged-out marketing site: its only way into the app is the
  // login form, so sending a signed-in parent there was indistinguishable from
  // being logged out and left them re-authenticating to get back.
  return (
    <PageShell trail={[STEP.language, STEP.consent]}>
      <PageHero titleId="consent-title" title={t('consent.title')} />

      <div className="page-card">
        <p className="page-card-text">{t('consent.text')}</p>

        <Checkbox
          id="consentCheckbox"
          checked={isChecked}
          onChange={handleChange}
          label={t('consent.checkbox')}
          error={showConsentError ? t('consent.tooltip') : null}
        />

        <Button
          variant="primary"
          fullWidth
          onClick={handleContinue}
          busy={saving}
          busyLabel={t('common.saving')}
          // Stable E2E hook: the label is localized
          data-testid="consent-continue-button"
        >
          {t('consent.button')}
        </Button>
      </div>
    </PageShell>
  );
}
