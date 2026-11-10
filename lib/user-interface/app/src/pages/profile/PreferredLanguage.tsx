import React, { useState, useEffect, useContext } from 'react';
import { Container, Alert } from 'react-bootstrap';
import PageLoading from '../../components/PageLoading';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { PROFILE_QUERY_KEY } from '../../common/hooks/use-language-preference';
import { IconCheck } from '@tabler/icons-react';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { Language } from '../../common/types';
import { useLanguage, SupportedLanguage } from '../../common/language-context';
import { LANGUAGES, filterEnabledOptions } from '../../common/languages';
import { useFeatures } from '../../common/hooks/use-features';
import { isStudentNameMissing } from '../../common/features';
import PageShell from '../../components/page/PageShell';
import PageHero from '../../components/page/PageHero';
import { NavLanguageSlot } from '../../components/NavLanguageSlot';
import { STEP } from '../../common/breadcrumb-steps';
import './ProfileForms.css';
import './PreferredLanguage.css';

export default function PreferredLanguage() {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
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
      // Every redirect below is decided on this fresh read, and the screens it
      // sends a parent to read the shared cache. Without this, a cache still
      // holding the profile from mid-onboarding (showOnboarding: true) sent
      // the summary straight back here, and the two bounced the parent between
      // them several times a second (staging, 2026-11-10).
      queryClient.setQueryData(PROFILE_QUERY_KEY, data);

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

  // Every state of this screen empties the bar's language spot, so the
  // default picker does not show while it loads and then vanish.
  if (loading) {
    return (
      <>
        <NavLanguageSlot />
        <PageLoading message={t('common.loading')} />
      </>
    );
  }

  if (error) {
    return (
      <Container>
        <NavLanguageSlot />
        <Alert variant="danger">{error}</Alert>
      </Container>
    );
  }

  // Show language preference UI
  return (
    <>
      {/* Empties the top bar's language spot (NavLanguageSlot.tsx): this
          screen IS the language picker, and the bar would put a second copy
          of the same choice in the corner of it. */}
      <NavLanguageSlot />
      {/* A way back only when a parent got here from their profile. In
          onboarding this is the FIRST step: the entry behind it is the
          sign-in card, so the trail is the one crumb saying where they are. */}
      <PageShell trail={isUpdatingFromProfile ? [STEP.account, STEP.language] : [STEP.language]}>
        <PageHero
          titleId="language-title"
          title={isUpdatingFromProfile ? t('preferredLanguage.update.title') : t('preferredLanguage.title')}
          description={isUpdatingFromProfile ? t('preferredLanguage.update.description') : t('preferredLanguage.hint')}
        />

        {/* Each choice is written in the language it offers, so a parent who
            reads none of the others can still find theirs. */}
        <div className="language-options" role="group" aria-labelledby="language-title">
          {languageOptions.map(option => {
            const isSelected = profile?.secondaryLanguage === option.value;
            return (
              // A choice in a list, not an action pill: a row the parent
              // picks, marked with aria-pressed (a purpose-built control in
              // common/ui-standards.test.ts).
              <button
                type="button"
                key={option.value}
                className={`language-option${isSelected ? ' is-selected' : ''}`}
                // The tint is not the only difference between chosen and not:
                // the state is announced and carries a tick.
                aria-pressed={isSelected}
                onClick={() => handleLanguageSelect(option.value)}
                disabled={saving}
              >
                <span
                  className="language-option-text"
                  lang={option.value}
                  dir={option.value === 'ar' ? 'rtl' : 'ltr'}
                >
                  {option.translatedPreference}
                </span>
                {isSelected && (
                  <IconCheck
                    size={22}
                    stroke={2.5}
                    className="language-option-check"
                    aria-hidden="true"
                    data-testid={`language-selected-${option.value}`}
                  />
                )}
              </button>
            );
          })}
        </div>
      </PageShell>
    </>
  );
}
