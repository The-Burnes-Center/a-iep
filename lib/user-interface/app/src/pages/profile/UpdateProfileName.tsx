import React, { useState, useEffect, useContext } from 'react';
import { Container, Form, Button, Row, Col, Alert, Spinner, Breadcrumb } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import MobileTopNavigation from '../../components/MobileTopNavigation';
import AIEPFooter from '../../components/AIEPFooter';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { useLanguage } from '../../common/language-context'; 
import './UpdateProfileName.css';
import './ProfileForms.css';

export default function UpdateProfileName() {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const navigate = useNavigate();
  const { t } = useLanguage();

  const [parentName, setParentName] = useState<string>('');
  const [saving, setSaving] = useState(false);

  const { data: profile, isLoading, error } = useQuery({
    queryKey: ['profile'],
    queryFn: () => apiClient.profile.getProfile(),
  });

  useEffect(() => {
    if (profile?.parentName) {
      setParentName(profile.parentName);
    }
  }, [profile]);

  const handleSaveAndContinue = async () => {
    if (!parentName.trim()) {
      return; // Button should be disabled in this case
    }

    try {
      setSaving(true);
      
      // Prepare updated profile data
      const updatedProfileData = {
        parentName: parentName.trim()
      };
      
      // Update the profile with parent name
      await apiClient.profile.updateProfile(updatedProfileData);
      
      // Check if user has any children - if not, create a default child
      if (!profile?.children || profile.children.length === 0) {
        try {
          // Create a default child with generic information
          // The user can update this later if needed
          await apiClient.profile.addChild('My Child', profile?.city || 'Not specified');
          // console.log('Created default child for IEP document functionality');
        } catch (childError) {
          // console.error('Error creating default child:', childError);
          // Don't fail the flow if child creation fails - user can add manually later
        }
      }
      
      // Mark onboarding as completed since user has finished all required steps
      try {
        await apiClient.profile.updateProfile({ showOnboarding: false });
        // console.log('Onboarding completed - showOnboarding set to false');
      } catch (onboardingError) {
        // console.error('Error updating onboarding status:', onboardingError);
        // Don't fail the flow if this update fails
      }
      
      navigate('/account-center');

    } catch (err) {
      console.error('Error saving parent name:', err);
    } finally {
      setSaving(false);
    }
  };

  const isFormValid = () => {
    return parentName.trim() !== '';
  };

  const handleBackClick = () => {
    navigate('/account-center');
  };

  if (isLoading) {
    return (
      <Container className="text-center">
        <Spinner animation="border" role="status">
          <span className="visually-hidden">{t('updateProfile.loading')}</span>
        </Spinner>
      </Container>
    );
  }

  if (error) {
    return (
      <Container>
        <Alert variant="danger">{t('updateProfile.error.serviceUnavailable')}</Alert>
      </Container>
    );
  }

  return (
    <>
    <MobileTopNavigation />
    <div>
      {/* Breadcrumbs */}
      <div className="mt-3 text-center px-4 breadcrumb-container">
        <Breadcrumb>
          <Breadcrumb.Item onClick={handleBackClick}>{t('updateProfile.breadcrumb.account')}</Breadcrumb.Item>
          <Breadcrumb.Item active>{t('updateProfile.breadcrumb.updateProfile')}</Breadcrumb.Item>
        </Breadcrumb>
      </div>
      
      <Container 
        fluid 
        className="update-profile-container"
      >
        <Row style={{ width: '100%', justifyContent: 'center' }}>
          <Col xs={12} md={8} lg={6}>
            <div className="profile-form">
            {/*Add translations*/}
            <h4 className="update-profile-header">{t('updateProfile.title')}</h4>
            <p className='update-profile-description'>{t('updateProfile.description')}</p>
              <Form>
                <Row className="mb-4">
                  <Col md={12}>
                    <Form.Group controlId="formParentName">
                      <Form.Label className="form-label">{t('parent.name.label')}</Form.Label>
                      <Form.Control 
                        type="text" 
                        placeholder={t('parent.name.placeholder')}
                        value={parentName} 
                        onChange={(e) => setParentName(e.target.value)}
                      />
                    </Form.Group>
                  </Col>
                </Row>

                <div className="d-grid">
                  <Button 
                    variant="primary" 
                    onClick={handleSaveAndContinue}
                    disabled={!isFormValid() || saving}
                    className="consent-button aiep-button"
                  >
                    {saving ? t('updateProfile.button.saving') : t('updateProfile.button.update')}
                  </Button>
                </div>
              </Form>
            </div>
          </Col>
        </Row>
      </Container>
    </div>
    <AIEPFooter />
    </>
  );
}