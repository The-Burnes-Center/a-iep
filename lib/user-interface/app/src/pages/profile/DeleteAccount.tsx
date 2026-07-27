import React, { useState, useContext } from 'react';
import { Container, Form, Row, Col, Breadcrumb } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { Auth } from 'aws-amplify';
import { useAuth } from '../../common/auth-provider';
import { useNotifications } from '../../components/notif-manager';
import { useLanguage } from '../../common/language-context'; 
import './UpdateProfileName.css';
import './ProfileForms.css';
import DeleteButton from '../../components/DeleteButton';
import MobileTopNavigation from '../../components/MobileTopNavigation';
import AIEPFooter from '../../components/AIEPFooter';

export default function DeleteAccount() {
  const [processing, setProcessing] = useState(false);
  const [, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const { setAuthenticated } = useAuth();
  const { addNotification } = useNotifications();
  const { t } = useLanguage();

  const handleDeleteProfile = async () => {
    try {
      setProcessing(true);
      setError(null);
      
      // Delete the entire user profile and all data
      await apiClient.profile.deleteProfile();
      
      // Show success notification
      addNotification('success', t('delete.success'));
      
      // Navigate to root BEFORE signing out to reset browser history
      navigate('/', { replace: true });
      
      // Sign out the user
      await Auth.signOut();
      setAuthenticated(false);
    } catch (err) {
      // console.error('Error deleting profile:', err);
      setError(t('delete.error.failed'));
      setProcessing(false);
    }
  };

  const handleBackClick = () => {
    navigate('/account-center');
  };

  return (
    <>
    <MobileTopNavigation />
    <div>
      {/* Breadcrumbs */}
      <div className="mt-3 text-start px-4 breadcrumb-container">
        <Breadcrumb>
          <Breadcrumb.Item onClick={handleBackClick}>{t('deleteAccount.breadcrumb.account')}</Breadcrumb.Item>
          <Breadcrumb.Item active>{t('deleteAccount.breadcrumb.deleteAccount')}</Breadcrumb.Item>
        </Breadcrumb>
      </div>
      
      <Container 
        fluid 
        className="update-profile-container"
      >
        <Row style={{ width: '100%', justifyContent: 'center' }}>
          <Col xs={12} md={8} lg={6}>
            <div className="profile-form">
            <h4 className="update-profile-header">{t('deleteAccount.title')}</h4>
            <p className='update-profile-description'>{t('deleteAccount.description')}</p> 
              <Form onSubmit={(e) => { e.preventDefault(); handleDeleteProfile(); }}>

                <div className="d-grid">
                  <DeleteButton
                    loading={processing}
                    buttonText={processing ? t('delete.button.processing') : t('deleteAccount.button.deleteMyAccount')}
                    disabled={processing}
                  />
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