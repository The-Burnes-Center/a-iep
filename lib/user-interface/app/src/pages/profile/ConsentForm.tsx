import React, { useState, useEffect, useContext } from 'react';
import { Container, Form, Button, Row, Col, OverlayTrigger, Tooltip, Spinner } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { IconCheck } from '@tabler/icons-react';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { UserProfile } from '../../common/types';
import { useLanguage } from '../../common/language-context';
import { useFeatures } from '../../common/hooks/use-features';
import { isStudentNameMissing } from '../../common/features';
import MobileTopNavigation from '../../components/MobileTopNavigation';
import OnboardingTopBar from '../../components/OnboardingChrome';
import './ProfileForms.css';

export default function ConsentForm() {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { isFeatureEnabled } = useFeatures();

  const [isChecked, setIsChecked] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
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
    if (showTooltip) setShowTooltip(false);
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
      setShowTooltip(true);
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
          await apiClient.profile.addChild('My Child', profile?.city || 'Not specified');
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

  const renderTooltip = (props) => (
    <Tooltip id="consent-tooltip" className="consent-tooltip" {...props}>
      {t('consent.tooltip')}
    </Tooltip>
  );

  if (loading) {
    return (
      <Container className="text-center profile-form-container">
        <Spinner animation="border" role="status">
          <span className="visually-hidden">{t('common.loading')}</span>
        </Spinner>
      </Container>
    );
  }

  if (error) {
    return (
      <Container className="profile-form-container">
        <Row style={{ width: '100%', justifyContent: 'center' }}>
          <Col xs={12} md={8} lg={6}>
            <div className="alert alert-danger">{error}</div>
            <Button onClick={loadProfile} variant="primary" className="aiep-button">{t('common.tryAgain')}</Button>
          </Col>
        </Row>
      </Container>
    );
  }

  return (
    <>
      <MobileTopNavigation />
      <div className="onboarding-page">
        {/* Back goes to the previous onboarding step, NOT to '/'. The landing
            page is the logged-out marketing site: its only way into the app is
            the login form, so sending a signed-in parent there was
            indistinguishable from being logged out and left them
            re-authenticating to get back. Named rather than left to history,
            because consent can be the first navigation of a session. */}
        <OnboardingTopBar backTo="/preferred-language" />

        <h1 className="onboarding-heading">{t('consent.title')}</h1>

        <p className="onboarding-body">{t('consent.text')}</p>

        <Form.Group controlId="consentCheckbox" className="consent-agree-group">
          <OverlayTrigger placement="top" overlay={renderTooltip} show={showTooltip}>
            <div className={`consent-agree-row${isChecked ? ' is-agreed' : ''}`}>
              <Form.Check
                type="checkbox"
                checked={isChecked}
                onChange={handleChange}
                label={<span className="checkbox-label">{t('consent.checkbox')}</span>}
              />
              {/* Second signal for the agreed state, so it does not rest on
                  the border colour alone. */}
              {isChecked && (
                <IconCheck
                  size={22}
                  stroke={2.5}
                  className="consent-agree-tick"
                  aria-hidden="true"
                  data-testid="consent-agreed-tick"
                />
              )}
            </div>
          </OverlayTrigger>
        </Form.Group>

        <div className="onboarding-actions">
          <Button
            variant="primary"
            onClick={handleContinue}
            disabled={!isChecked || saving}
            className="aiep-button onboarding-action"
            // Stable E2E hook: the label is localized
            data-testid="consent-continue-button"
          >
            {saving ? (
              <>
                <Spinner as="span" animation="border" size="sm" role="status" aria-hidden="true" className="me-2" />
                {t('common.saving')}
              </>
            ) : (
              t('consent.button')
            )}
          </Button>
        </div>
      </div>
    </>
  );
}
