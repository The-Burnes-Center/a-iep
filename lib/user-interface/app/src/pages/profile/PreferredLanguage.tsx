import React, { useState, useEffect, useContext } from 'react';
import { Container, Row, Col, Alert, Spinner, Button } from 'react-bootstrap';
import { useNavigate, useLocation } from 'react-router-dom';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { Language } from '../../common/types';
import { useNotifications } from '../../components/notif-manager';
import { useLanguage, SupportedLanguage } from '../../common/language-context';
import { LANGUAGES, filterEnabledOptions } from '../../common/languages';
import './ProfileForms.css';

export default function PreferredLanguage() {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const navigate = useNavigate();
  const location = useLocation();
  const { addNotification } = useNotifications();
  const { setLanguage, enabledLanguages } = useLanguage();

  // Language options enabled for this environment
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

      // Same for the parent's name: nothing else in the flow collects it,
      // and referral links / the admin console display it
      if (!(data && data.parentName)) {
        navigate('/account-center/profile', { state: { onboardingContinue: true } });
        return;
      }

      // User doesn't need onboarding, go directly to welcome page
      // console.log('User has completed onboarding, going to welcome page');
      navigate('/summary-and-translations');
    } catch (err) {
      setError('Service unavailable');
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
        addNotification('success', 'Language preference updated successfully');
      }
      
      // Navigate back to appropriate page
      if (isUpdatingFromProfile) {
        navigate('/profile');
      } else {
        navigate('/consent-form');
      }
    } catch (err) {
      addNotification('error', 'Failed to update language preference');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Container className="text-center">
        <Spinner animation="border" role="status">
          <span className="visually-hidden">Loading...</span>
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
    <Container 
      fluid 
      className="profile-form-container"
    >
      <Row style={{ width: '100%', justifyContent: 'center' }}>
        <Col xs={12} md={8} lg={6}>
          <div className="profile-form">
            {isUpdatingFromProfile && (
              <div className="text-center mb-4">
                <h3>Update Language Preferences</h3>
                <p className="text-muted">Select your preferred language for IEP translations</p>
                <Button 
                  variant="outline-secondary" 
                  size="sm"
                  onClick={() => navigate('/profile')}
                  className="mb-3"
                >
                  ← Back to Profile
                </Button>
              </div>
            )}
            <Row className="g-3">
              {languageOptions.map(option => (
                <Col xs={12} key={option.value}>
                  <Button 
                    variant={profile?.secondaryLanguage === option.value ? "primary" : "outline-primary"}
                    className="w-100 py-3 language-button"
                    onClick={() => handleLanguageSelect(option.value)}
                    disabled={saving}
                  >
                    <div className="d-flex justify-content-between align-items-center w-100">
                      <span>{option.translatedPreference}</span>
                     </div>
                  </Button>
                </Col>
              ))}
            </Row>
          </div>
        </Col>
      </Row>
    </Container>
  );
}