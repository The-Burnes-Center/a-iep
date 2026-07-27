import React, { useState, useEffect, useContext } from 'react';
import { Container, Form, Button, Row, Col, Alert, Spinner } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { IEPDocumentClient } from '../../common/api-client/iep-document-client';
import { UserProfile } from '../../common/types';
import { useNotifications } from '../../components/notif-manager';
import { useLanguage } from '../../common/language-context'; 
import './ProfileForms.css';

export default function ViewAndAddParent() {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const iepDocumentClient = new IEPDocumentClient(appContext);
  const navigate = useNavigate();
  const { addNotification } = useNotifications();
  const { t } = useLanguage();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [parentName, setParentName] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [hasExistingDocument, setHasExistingDocument] = useState<boolean>(false);

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
      
      // Check if parentName exists in the profile
      if (data.parentName) {
        setParentName(data.parentName);
      }
      
      // Check for existing documents
      await checkForExistingDocument();
      
      setError(null);
    } catch (err) {
      // console.error('Error loading profile or checking document:', err);
      setError('Service unavailable');
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
      addNotification('success', 'Parent information saved successfully');
      
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
      
      // Check for existing documents after potentially creating child
      await checkForExistingDocument();
      
      // Mark onboarding as completed since user has finished all required steps
      try {
        await apiClient.profile.updateProfile({ showOnboarding: false });
        // console.log('Onboarding completed - showOnboarding set to false');
      } catch (onboardingError) {
        // console.error('Error updating onboarding status:', onboardingError);
        // Don't fail the flow if this update fails
      }
      
      // Navigate based on whether user has existing documents
      if (hasExistingDocument) {
        navigate('/iep-documents');
      } else {
        navigate('/iep-documents');
      }
    } catch (err) {
      // console.error('Error saving parent name:', err);
      addNotification('error', 'Failed to save parent information');
    } finally {
      setSaving(false);
    }
  };

  const isFormValid = () => {
    return parentName.trim() !== '';
  };

  const handleBackClick = () => {
    navigate('/consent-form');
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

  return (
    <div>
      <div className="mt-3 text-start px-3 py-2">
        <Button variant="outline-secondary" onClick={handleBackClick} className='aiep-button'>
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
              <h2 className="parent-name-title">
                {t('parent.title')}
              </h2>
              
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
                    {saving ? t('parent.button.saving') : t('parent.button.save')}
                  </Button>
                </div>
              </Form>
            </div>
          </Col>
        </Row>
      </Container>
    </div>
  );
}