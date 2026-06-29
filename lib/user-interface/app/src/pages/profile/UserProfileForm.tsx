import React, { useState, useEffect, useContext } from 'react';
import { Container, Form, Button, Row, Col, Alert, Spinner } from 'react-bootstrap';
import { Auth } from "aws-amplify";
import { AppContext } from '../../common/app-context';
import { useAuth } from '../../common/auth-provider';
import { ApiClient } from '../../common/api-client/api-client';
import { UserProfile } from '../../common/types';
import { useNotifications } from '../../components/notif-manager';
import { useLanguage, SupportedLanguage } from '../../common/language-context';
import { LANGUAGES, filterEnabledOptions } from '../../common/languages';
import { useNavigate } from 'react-router-dom';
import MobileTopNavigation from '../../components/MobileTopNavigation';
import AIEPFooter from '../../components/AIEPFooter';
import DeleteProfileModal from './DeleteProfileModal';
import './ProfileForms.css';

export default function UserProfileForm() {
  const appContext = useContext(AppContext);
  const { setAuthenticated } = useAuth();
  const apiClient = new ApiClient(appContext);
  const { addNotification } = useNotifications();
  const { t, setLanguage, enabledLanguages } = useLanguage();

  // Language options enabled for this environment
  const languageOptions = filterEnabledOptions(LANGUAGES, enabledLanguages);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [originalProfile, setOriginalProfile] = useState<UserProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    try {
      setLoading(true);
      const data = await apiClient.profile.getProfile();
      setProfile(data);
      setOriginalProfile(data);
      setError(null);
    } catch (err) {
      setError(t('profile.error.serviceUnavailable'));
    } finally {
      setLoading(false);
    }
  };

  // Check if profile has changes
  const hasChanges = () => {
    if (!profile || !originalProfile) return false;
    return (
      profile.parentName !== originalProfile.parentName ||
      profile.secondaryLanguage !== originalProfile.secondaryLanguage
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;

    try {
      setSaving(true);
      await apiClient.profile.updateProfile(profile);
      
      // Update language context if secondary language changed
      if (profile.secondaryLanguage && profile.secondaryLanguage !== originalProfile?.secondaryLanguage) {
        setLanguage(profile.secondaryLanguage as SupportedLanguage);
      }
      
      setOriginalProfile(profile); // Update original profile after successful save
      addNotification('success', t('profile.success.update'));
    } catch (err) {
      addNotification('error', t('profile.error.update'));
    } finally {
      setSaving(false);
    }
  };

  const handlePreferredLanguageChange = (languageCode: string) => {
    setProfile(prev => prev ? {...prev, secondaryLanguage: languageCode} : null);
  };



  const handleDeleteProfile = () => {
    setShowDeleteModal(true);
  };

  const handleSignOut = async () => {
    try {
      navigate('/', { replace: true });
      await Auth.signOut();
      setAuthenticated(false);
    } catch (error) {
      // console.error("Error signing out:", error);
    }
  };

  if (loading) {
    return (
      <Container className="mt-4 text-center">
        <Spinner animation="border" role="status">
          <span className="visually-hidden">{t('profile.loading')}</span>
        </Spinner>
      </Container>
    );
  }

  if (error) {
    return (
      <Container className="mt-4">
        <Alert variant="danger">{error}</Alert>
      </Container>
    );
  }

  const handleBackClick = () => {
    navigate('/summary-and-translations');
  };

  return (
    <>
    <MobileTopNavigation />
    <Container className="mt-4">
      <div className="mt-3 text-start">
        <Button variant="outline-secondary" onClick={handleBackClick}>
          {t('common.back')}
        </Button>
      </div>
      <Form onSubmit={handleSubmit} className="mt-4">
        <h3 className="mb-3">{t('profile.title')}</h3>
        
        <Row className="mb-3">
          <Col md={10}>
            <Form.Group controlId="formParentName">
              <Form.Label className="small">{t('profile.parentName')}</Form.Label>
              <Form.Control 
                type="text" 
                value={profile?.parentName || ''}
                onChange={e => {
                  setProfile(prev => prev ? {...prev, parentName: e.target.value} : null);
                }}
              />
            </Form.Group>
          </Col>
        </Row>

        {/* Preferred Language Section */}
        <Row className="mb-4">
          <Col md={10}>
            <Form.Group controlId="formPreferredLanguage">
              <Form.Label className="small">{t('profile.preferredLanguage')}</Form.Label>
              <Form.Select 
                value={profile?.secondaryLanguage || 'en'}
                onChange={e => handlePreferredLanguageChange(e.target.value)}
              >
                {languageOptions.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.englishLabel}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
          </Col>
        </Row>

        <div className="mt-4 profile-actions">
          <Button 
            variant="primary" 
            type="submit" 
            disabled={saving || !hasChanges()}
          >
            {saving ? t('profile.button.updating') : t('profile.button.update')}
          </Button>
          <Button 
            variant="outline-secondary" 
            onClick={handleSignOut}
            className="button-text"
          >
            {t('profile.button.logOut')}
          </Button>
          <Button 
            variant="danger" 
            onClick={handleDeleteProfile}
            className="button-text"
          >
            {t('profile.button.deleteProfile')}
          </Button>
        </div>
      </Form>
    </Container>
    <DeleteProfileModal 
      show={showDeleteModal} 
      onHide={() => setShowDeleteModal(false)} 
    />
    <AIEPFooter />
    </>
  );
}