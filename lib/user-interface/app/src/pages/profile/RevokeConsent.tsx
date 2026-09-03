import React, { useState, useContext } from 'react';
import { Container, Button, Row, Col, Alert } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { signOut } from 'aws-amplify/auth';
import { useAuth } from '../../common/auth-provider';
import { useLanguage } from '../../common/language-context';
import '../profile/ProfileForms.css';

const RevokeConsent: React.FC = () => {
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const { setAuthenticated } = useAuth();
  const { t } = useLanguage();

  const handleRevokeConsent = async () => {
    try {
      setProcessing(true);
      setError(null);
      
      // Update profile to set consentGiven to false
      await apiClient.profile.updateProfile({ consentGiven: false });
      
      // Sign out the user
      await signOut();
      setAuthenticated(false);
      
      // Redirect to sign-in page
      navigate('/', { replace: true });
    } catch (err) {
      setError(t('revoke.error.failed'));
      setProcessing(false);
    }
  };

  const handleCancel = () => {
    navigate('/profile');
  };

  return (
    <Container fluid className="profile-form-container">
      <Row style={{ width: '100%', justifyContent: 'center' }}>
        <Col xs={12} md={8} lg={6}>
          <div className="profile-form">
            <h2 className="text-center profile-title mb-4">{t('revoke.title')}</h2>
            
            <div className="consent-box mb-4">
              <p className="consent-text">
                {t('revoke.description1')}
              </p>
              <p className="consent-text">
                {t('revoke.description2')}
              </p>
            </div>
            
            {error && <Alert variant="danger" className="mb-4">{error}</Alert>}
            
            <div className="d-flex justify-content-between">
              <Button 
                variant="outline-secondary" 
                onClick={handleCancel}
                disabled={processing}
                className="button-text"
              >
                {t('revoke.button.back')}
              </Button>
              <Button 
                variant="danger" 
                onClick={handleRevokeConsent}
                disabled={processing}
                className="button-text"
              >
                {processing ? t('revoke.button.processing') : t('revoke.button.revoke')}
              </Button>
            </div>
          </div>
        </Col>
      </Row>
    </Container>
  );
};

export default RevokeConsent;