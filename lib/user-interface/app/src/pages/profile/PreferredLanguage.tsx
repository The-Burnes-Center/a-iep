import React, { useState, useEffect, useContext } from 'react';
import { Container, Alert, Spinner, Button } from 'react-bootstrap';
import { useNavigate, useLocation } from 'react-router-dom';
import { IconCheck } from '@tabler/icons-react';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { Language } from '../../common/types';
import { useLanguage, SupportedLanguage } from '../../common/language-context';
import { LANGUAGES, filterEnabledOptions } from '../../common/languages';
import { useFeatures } from '../../common/hooks/use-features';
import { isStudentNameMissing } from '../../common/features';
import MobileTopNavigation from '../../components/MobileTopNavigation';
import OnboardingTopBar from '../../components/OnboardingChrome';
import './ProfileForms.css';

export default function PreferredLanguage() {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const navigate = useNavigate();
  const location = useLocation();
  const { setLanguage, enabledLanguages, t } = useLanguage();
  const { isFeatureEnabled } = useFeatures();

  // Language options enabled for this environment. Arabic ships everywhere and
  // is enabled outside production, so the list is read from config rather than
  // written out: a hard-coded four would drop it where it is on.
  const languageOptions = filterEnabledOptions(LANGUAGES, enabledLanguages);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<Language | null>(null);
  const [saving, setSaving] = useState(false);

  // Check if user came from profile page to update language
  const isUpdatingFromProfile = location.state?.fromProfile === true;

  useEffect(() => {
    loadProfile();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only onboarding gate: loadProfile decides the redirect once, on load
  }, []);

  const loadProfile = async () => {
    try {
      setLoading(true);
      const data = await apiClient.profile.getProfile();
      setProfile(data);

      // Skip automatic redirects if user is updating from profile page
      if (isUpdatingFromProfile) {
        setError(null);
        return;
      }

      // Check if user needs onboarding based on profile showOnboarding field
      const needsOnboarding = data && data.showOnboarding === true;

      if (needsOnboarding) {
        // console.log('User needs onboarding, starting onboarding flow');
        // Check if the user has already completed some required fields to determine where to start
        const hasLanguage = data && data.secondaryLanguage;
        const hasConsent = data && data.consentGiven === true;

        // If user has language and consent, go directly to IEP documents
        if (hasLanguage && hasConsent) {
          // console.log("hasLanguage && hasConsent - going to IEP documents");
          navigate('/iep-documents');
          return;
        }

        // Otherwise, stay on language selection (current screen) to start onboarding
        setError(null);
        return;
      }

      // Consent is mandatory even when onboarding is done or was skipped:
      // profiles created by fallback paths never saw the consent form, so
      // send them there instead of into the app
      if (!(data && data.consentGiven === true)) {
        navigate('/consent-form');
        return;
      }

      // The child's name is the only thing onboarding asks for beyond
      // language and consent. It is load-bearing: without it a summary can
      // only refer to the child in the general phrase.
      if (isFeatureEnabled('studentNameGate') && isStudentNameMissing(data)) {
        navigate('/view-update-add-child', { state: { onboardingContinue: true } });
        return;
      }

      // User doesn't need onboarding, go directly to welcome page
      // console.log('User has completed onboarding, going to welcome page');
      navigate('/summary-and-translations');
    } catch (err) {
      setError(t('profile.error.serviceUnavailable'));
    } finally {
      setLoading(false);
    }
  };

  const handleLanguageSelect = async (languageValue: string) => {
    if (!profile) return;

    try {
      setSaving(true);

      // Set the language in the context
      setLanguage(languageValue as SupportedLanguage);

      // Create updated profile with the selected language
      const preferredLanguage = {
        secondaryLanguage: languageValue,
        primaryLanguage: 'en'
      };

      setProfile(preferredLanguage);

      // Only update if there are changes to save
      if (profile.secondaryLanguage !== languageValue) {
        await apiClient.profile.updateProfile(preferredLanguage);
      }

      // Navigate back to appropriate page
      if (isUpdatingFromProfile) {
        navigate('/profile');
      } else {
        navigate('/consent-form');
      }
    } catch (err) {
      // Inline, on the banner this page already renders. This used to be a
      // toast and nothing else, so removing the toasts would have made a failed
      // language save silent.
      setError(t('preferredLanguage.error.updateFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Container className="text-center">
        <Spinner animation="border" role="status">
          <span className="visually-hidden">{t('common.loading')}</span>
        </Spinner>
      </Container>
    );
  }

  if (error) {
    return (
      <Container>
        <Alert variant="danger">{error}</Alert>
      </Container>
    );
  }

  // Show language preference UI
  return (
    <>
      <MobileTopNavigation />
      <div className="onboarding-page">
        {/* Carries its own Back control, so the edit-from-profile block below
            no longer adds a second one of its own. */}
        <OnboardingTopBar />

        {isUpdatingFromProfile && (
          <>
            <h1 className="onboarding-heading">{t('preferredLanguage.update.title')}</h1>
            <p className="onboarding-body">{t('preferredLanguage.update.description')}</p>
          </>
        )}

        {/* No heading in the design: one line, then the choices, each written
            in the language it offers. */}
        <p className="onboarding-lede">{t('preferredLanguage.lede')}</p>

        <div className="onboarding-actions">
          {languageOptions.map(option => {
            const isSelected = profile?.secondaryLanguage === option.value;
            return (
              <Button
                key={option.value}
                variant={isSelected ? 'primary' : 'outline-secondary'}
                className="onboarding-choice"
                // The fill is the only colour difference between chosen and
                // not, so the state is also announced and also carries a tick.
                aria-pressed={isSelected}
                onClick={() => handleLanguageSelect(option.value)}
                disabled={saving}
              >
                {isSelected && (
                  <IconCheck
                    size={20}
                    stroke={2.5}
                    className="onboarding-choice-icon"
                    aria-hidden="true"
                    data-testid={`language-selected-${option.value}`}
                  />
                )}
                <span className="onboarding-choice-text">{option.translatedPreference}</span>
              </Button>
            );
          })}
        </div>
      </div>
    </>
  );
}
