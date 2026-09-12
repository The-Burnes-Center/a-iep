import React, { useState, useEffect, useContext } from 'react';
import { Form, Button, Alert, Spinner, Container } from 'react-bootstrap';
import { useNavigate, useLocation } from 'react-router-dom';
import { IconArrowLeft } from '@tabler/icons-react';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { IEPDocumentClient } from '../../common/api-client/iep-document-client';
import { UserProfile } from '../../common/types';
import { useLanguage } from '../../common/language-context';
import { LANGUAGES, filterEnabledOptions } from '../../common/languages';
import { isPlaceholderChildName } from '../../common/features';
import MobileTopNavigation from '../../components/MobileTopNavigation';
import LanguageDropdown from '../../components/LanguageDropdown';
import './ViewAndAddChild.css';

// The school district is no longer asked for: nothing reads schoolCity - not
// the pipeline, not a summary, no logic - and the design has one field. The
// backend still rejects addChild without one (user-profile-handler, "Missing
// required fields"), so an existing value is kept and a new child gets the
// same default the other three addChild call sites send.
const SCHOOL_CITY_DEFAULT = 'Not specified';

export default function ViewAndAddChild() {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const iepDocumentClient = new IEPDocumentClient(appContext);
  const navigate = useNavigate();
  const location = useLocation();
  const { t, language, setLanguage, enabledLanguages } = useLanguage();

  const [loading, setLoading] = useState(true);
  // Two separate failures: a profile that will not load leaves nothing to
  // show, but a save that fails must leave the form (and what the parent
  // typed) on screen to retry, with the reason above it.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [childName, setChildName] = useState<string>('');
  const [schoolCity, setSchoolCity] = useState<string>('');
  const [hasExistingChild, setHasExistingChild] = useState<boolean>(false);
  const [firstChildId, setFirstChildId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [hasExistingDocument, setHasExistingDocument] = useState<boolean>(false);

  const languageOptions = filterEnabledOptions(LANGUAGES, enabledLanguages);

  // Only the first entry in a history stack keeps the key 'default', so this
  // asks "is one of our screens behind this one?" rather than
  // window.history.length, which counts other sites and never goes down. A
  // parent who opened this URL directly, or who landed here on the first
  // navigation after signing in, gets no Back button instead of one that
  // leaves the app.
  const canGoBack = location.key !== 'default';

  useEffect(() => {
    loadProfileAndCheckDocument();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only load by design
  }, []);

  const loadProfileAndCheckDocument = async () => {
    try {
      setLoading(true);

      // Load user profile
      const data = await apiClient.profile.getProfile();
      setProfile(data);

      // Check if the user has any children
      if (data.children && data.children.length > 0) {
        const firstChild = data.children[0];
        // A stored '' or the auto-created 'My Child' placeholder must not
        // look like an answer: prefilling it would let a parent click Save
        // without ever typing a real name, which the gate would then send
        // them right back here to do.
        setChildName(isPlaceholderChildName(firstChild.name) ? '' : firstChild.name);
        setSchoolCity(firstChild.schoolCity || '');
        setFirstChildId(firstChild.childId || null);
        setHasExistingChild(true);
      } else {
        setHasExistingChild(false);
      }

      // Always check for existing documents regardless of children
      await checkForExistingDocument();

      setLoadError(null);
    } catch (err) {
      // console.error('Error loading profile or checking document:', err);
      setLoadError(t('profile.error.serviceUnavailable'));
    } finally {
      setLoading(false);
    }
  };

  const checkForExistingDocument = async () => {
    try {
      const document = await iepDocumentClient.getMostRecentDocumentWithSummary();

      // Check if document exists and has been processed or is processing
      if (document && (document.status === "PROCESSED" || document.status === "PROCESSING")) {
        setHasExistingDocument(true);
      } else {
        setHasExistingDocument(false);
      }
    } catch (err) {
      // console.error('Error checking for existing document:', err);
      // If there's an error checking for documents, assume no document exists
      setHasExistingDocument(false);
    }
  };

  const handleSaveAndContinue = async () => {
    if (!isFormValid()) {
      return; // Button should be disabled in this case
    }

    try {
      setSaving(true);
      setSaveError(null);
      // Whatever the child already has on file, or the shared default: the
      // screen no longer asks, but the API still requires it.
      const childSchoolCity = schoolCity.trim() || profile?.city || SCHOOL_CITY_DEFAULT;

      if (hasExistingChild && firstChildId) {
        // Update the existing child, as a new object: the profile in state is
        // read again on the way out of this handler.
        const existingChild = profile?.children?.[0];
        if (existingChild) {
          await apiClient.profile.updateProfile({
            children: [{
              ...existingChild,
              name: childName,
              schoolCity: childSchoolCity,
              // Keep the existing childId
              childId: firstChildId
            }]
          });
        }
      } else {
        // Add new child
        await apiClient.profile.addChild(childName, childSchoolCity);

        // After adding a new child, check for documents again
        await checkForExistingDocument();
      }

      // Mark onboarding as completed since user has finished child setup
      try {
        await apiClient.profile.updateProfile({ showOnboarding: false });
        // console.log('Onboarding completed from ViewAndAddChild - showOnboarding set to false');
      } catch (onboardingError) {
        // console.error('Error updating onboarding status:', onboardingError);
        // Don't fail the flow if this update fails
      }


      // Navigate based on whether user has existing documents
      if (hasExistingDocument) {
        // The legacy /welcome-page card hub is retired; Summary is the app home
        navigate('/summary-and-translations');
      } else {
        navigate('/welcome-intro');
      }
    } catch (err) {
      // Inline, above the form the parent just filled in: this failure used
      // to be reported only by a toast.
      setSaveError(hasExistingChild ? t('child.error.updateFailed') : t('child.error.addFailed'));
    } finally {
      setSaving(false);
    }
  };

  // The one field also submits on the keyboard's Go/Enter key.
  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void handleSaveAndContinue();
  };

  const isFormValid = () => {
    return childName.trim() !== '';
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

  if (loadError) {
    return (
      <Container>
        <Alert variant="danger">{loadError}</Alert>
      </Container>
    );
  }

  return (
    <>
      <MobileTopNavigation />
      <div className="child-name-page">
        <div className="child-name-topbar">
          {canGoBack && (
            <Button
              variant="outline-secondary"
              className="aiep-button child-name-back"
              onClick={() => navigate(-1)}
            >
              <IconArrowLeft size={18} stroke={2} className="arrow-icon" aria-hidden="true" />
              {t('common.back')}
            </Button>
          )}
          <div className="child-name-language">
            <LanguageDropdown
              language={language}
              languageOptions={languageOptions}
              onLanguageChange={setLanguage}
              variant="secondary"
            />
          </div>
        </div>

        {/* One question and one field, per the design. What the name is used
            for is explained on the privacy screen further into onboarding, not
            here: `child.description` is still in the dictionaries for it. */}
        <h1 className="child-name-heading">{t('child.heading')}</h1>

        {saveError && <Alert variant="danger" className="child-name-error">{saveError}</Alert>}

        <Form onSubmit={handleSubmit}>
          <Form.Group controlId="formChildName" className="child-name-field">
            {/* The design shows no label; screen readers still need one. */}
            <Form.Label className="visually-hidden">{t('child.name.label')}</Form.Label>
            <Form.Control
              type="text"
              placeholder={t('child.name.placeholder')}
              value={childName}
              onChange={(e) => setChildName(e.target.value)}
            />
          </Form.Group>

          <div className="d-grid">
            <Button
              type="submit"
              variant="primary"
              disabled={!isFormValid() || saving}
              className="child-name-submit"
              // Stable E2E hook: the label is localized
              data-testid="child-save-button"
            >
              {saving ? t('child.button.saving') : t('child.button.save')}
            </Button>
          </div>
        </Form>
      </div>
    </>
  );
}
