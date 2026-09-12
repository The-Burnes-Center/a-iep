import React, { useState, useContext } from 'react';
import { Container, Form, Row, Col, Breadcrumb, Alert } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { useAuth } from '../../common/auth-provider';
import { useLanguage } from '../../common/language-context'; 
import './UpdateProfileName.css';
import './ProfileForms.css';
import DeleteButton from '../../components/DeleteButton';
import MobileTopNavigation from '../../components/MobileTopNavigation';
import AIEPFooter from '../../components/AIEPFooter';

export default function DeleteAccount() {
  const [processing, setProcessing] = useState(false);
  // Rendered below. This used to be a write-only `const [, setError]`, so a
  // failed deletion told the parent nothing at all: the toast that was meant to
  // carry it never reached anyone, and the state it also set had no reader.
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const { logout, setAuthenticated } = useAuth();
  const { t } = useLanguage();

  const handleDeleteProfile = async () => {
    setProcessing(true);
    setError(null);

    try {
      // Delete the entire user profile and all data
      await apiClient.profile.deleteProfile();
    } catch (err) {
      setError(t('delete.error.failed'));
      setProcessing(false);
      return;
    }

    // The account is gone. End the session BEFORE routing away, and through
    // the context's logout() so the passwordless handle goes with it: this
    // used to navigate first and sign out behind the navigation, which is the
    // window a page load lands in and rehydrates a session for a user who no
    // longer exists (see clearStaleSession in components/CustomLogin.tsx).
    // A handle here would 401 session_invalid and self-clear on next use, but
    // relying on that is relying on the server to undo something we should
    // never have left behind.
    try {
      await logout();
    } catch {
      // Deletion already succeeded and logout() has already cleared this
      // device. A failed Amplify call is not a failed deletion, so it does
      // not get reported to the parent as one.
      setAuthenticated(false);
    }
    navigate('/', { replace: true });
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
              {error && <Alert variant="danger">{error}</Alert>}
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