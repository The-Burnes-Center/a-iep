import React, { useState, useContext } from 'react';
import { Container, Button, Row, Col } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { useLanguage } from '../../common/language-context';
import './ProfileForms.css';

const WelcomeIntro: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const { t } = useLanguage();

  const handleContinue = async () => {
    setLoading(true);
    
    // Mark onboarding as completed since user is continuing to main app
    try {
      await apiClient.profile.updateProfile({ showOnboarding: false });
      // console.log('Onboarding completed from WelcomeIntro - showOnboarding set to false');
    } catch (onboardingError) {
      // console.error('Error updating onboarding status:', onboardingError);
      // Don't fail the flow if this update fails
    }
    
    // Navigate to IEP documents page
    navigate('/iep-documents');
  };

  return (
    <Container 
      fluid 
      className="profile-form-container"
    >
      <Row style={{ width: '100%', justifyContent: 'center' }}>
        <Col xs={12} md={8} lg={6}>
          <div className="profile-form">
            <h2 className="text-center profile-title">{t('welcomeIntro.title')}</h2>

            <div className="consent-box">
              <p className="consent-text">
                {t('welcomeIntro.body1')}
              </p>
              <p className="consent-text">
                {t('welcomeIntro.body2')}
              </p>
            </div>

            <div className="d-grid">
              <Button
                variant="primary"
                onClick={handleContinue}
                disabled={loading}
                className="button-text"
                // Stable E2E hook: the label is localized
                data-testid="welcome-intro-continue"
              >
                {loading ? t('common.loading') : t('welcomeIntro.button.continue')}
              </Button>
            </div>
          </div>
        </Col>
      </Row>
    </Container>
  );
};

export default WelcomeIntro;