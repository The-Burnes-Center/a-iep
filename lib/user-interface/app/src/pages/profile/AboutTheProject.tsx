import React, { useState, useEffect, useContext } from 'react';
import { Container, Row, Col, Alert, Spinner, Breadcrumb } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { AppContext } from '../../common/app-context';
import MobileTopNavigation from '../../components/MobileTopNavigation';
import AIEPFooter from '../../components/AIEPFooter';
import { ApiClient } from '../../common/api-client/api-client';
import { UserProfile } from '../../common/types';
import { useLanguage } from '../../common/language-context';
import './ChangeLanguage.css';
import './ProfileForms.css';

export default function AboutTheProject() {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const navigate = useNavigate();
  const { t } = useLanguage();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [, setProfile] = useState<UserProfile | null>(null);
  const [, setOriginalProfile] = useState<UserProfile | null>(null);

    useEffect(() => {
      loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only profile load by design
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

  const handleBackClick = () => {
    navigate('/account-center');
  };

  if (loading) {
    return (
      <Container className="text-center">
        <Spinner animation="border" role="status">
          <span className="visually-hidden">{t('changeLanguage.loading')}</span>
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
  <>
      <MobileTopNavigation />
      <div>
      {/* Breadcrumbs */}
      <div className="mt-3 text-start px-4">
        <Breadcrumb>
          <Breadcrumb.Item onClick={handleBackClick}>SUPPORT CENTER</Breadcrumb.Item>
          <Breadcrumb.Item active>ABOUT</Breadcrumb.Item>
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
            <h4 className="update-profile-header">About The Project</h4>
            <p className='update-profile-description'>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod  tempor incididunt.</p>
            </div>
          </Col>
        </Row>
      </Container>
    </div>
    <AIEPFooter />
  </>
  );
}