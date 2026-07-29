import React, { useState, useEffect, useContext } from 'react';
import { Container, Form, Button, Row, Col, OverlayTrigger, Tooltip, Spinner } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { UserProfile } from '../../common/types';
import { useNotifications } from '../../components/notif-manager';
import { useLanguage } from '../../common/language-context'; 
import './ProfileForms.css';

export default function ConsentForm() {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const navigate = useNavigate();
  const { addNotification } = useNotifications();
  const { t } = useLanguage();

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
      setError('Service unavailable');
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setIsChecked(e.target.checked);
    if (showTooltip) setShowTooltip(false);
  };

  const handleContinue = async () => {
    if (!isChecked) {
      setShowTooltip(true);
      return;
    }
    
    // If consent was already given, continue on; ask for the parent's name
    // first if the profile still has none (referral links and the admin
    // console show it, and nothing else in the flow collects it)
    if (profile?.consentGiven) {
      if (!profile?.parentName) {
        navigate('/account-center/profile', { state: { onboardingContinue: true } });
      } else {
        navigate('/iep-documents');
      }
      return;
    }
    
    // Otherwise update the profile with consent
    try {
      setSaving(true);
      await apiClient.profile.updateProfile({ consentGiven: true });
      addNotification('success', 'Consent saved successfully');
      
      // Check if user has any children - if not, create a default child
      if (!profile?.children || profile.children.length === 0) {
        try {
          // Create a default child with generic information
          // The user can update this later if needed
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
      
      // After saving consent: collect the parent's name if missing (nothing
      // else in the flow asks for it), otherwise go to IEP documents
      if (!profile?.parentName) {
        navigate('/account-center/profile', { state: { onboardingContinue: true } });
      } else {
        navigate('/iep-documents');
      }
    } catch (err) {
      addNotification('error', 'Failed to save consent');
      setError('Failed to save consent. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const renderTooltip = (props) => (
    <Tooltip id="consent-tooltip" className="consent-tooltip" {...props}>
      {t('consent.tooltip')}
    </Tooltip>
  );

  const handleBackClick = () => {
    navigate('/');
  };

  if (loading) {
    return (
      <Container className="text-center profile-form-container">
        <Spinner animation="border" role="status">
          <span className="visually-hidden">Loading...</span>
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
            <Button onClick={loadProfile} variant="primary" className="aiep-button">Try Again</Button>
          </Col>
        </Row>
      </Container>
    );
  }

  return (
    <div>
      <div className="mt-3 text-start px-3 py-2">
        <Button variant="outline-secondary" onClick={handleBackClick} className="aiep-button">
          {t('common.back')}
        </Button>
      </div>
      
      <Container 
        fluid 
        className="profile-form-container"
      >
        <Row style={{ width: '100%', justifyContent: 'center' }}>
          <Col xs={12} md={8} lg={6}>
            <div className="profile-form">
              <h2 className="text-center profile-title">{t('consent.title')}</h2>
              
              <div className="consent-box">
                <p className="consent-text">
                {t('consent.text')}
                </p>
                
                <Form.Group controlId="consentCheckbox">
                  <OverlayTrigger
                    placement="right"
                    overlay={renderTooltip}
                    show={showTooltip}
                  >
                    <Form.Check 
                      type="checkbox"
                      checked={isChecked}
                      onChange={handleChange}
                      label={<span className="checkbox-label">{t('consent.checkbox')}</span>}
                    />
                  </OverlayTrigger>
                </Form.Group>
              </div>

              <div className="d-grid">
                <Button 
                  variant="primary" 
                  onClick={handleContinue}
                  disabled={!isChecked || saving}
                  className="consent-button aiep-button"
                >
                  {saving ? (
                    <>
                      <Spinner as="span" animation="border" size="sm" role="status" aria-hidden="true" className="me-2" />
                      Saving...
                    </>
                  ) : (
                    t('consent.button')
                  )}
                </Button>
              </div>
            </div>
          </Col>
        </Row>
      </Container>
    </div>
  );
}