import React, { useEffect, useState } from 'react';
import { Container, Row, Col, Card, Button } from 'react-bootstrap';
import { signOut, getCurrentUser, fetchAuthSession } from 'aws-amplify/auth';
import { useAuth } from '../common/auth-provider';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../common/language-context'; 
import MobileTopNavigation from '../components/MobileTopNavigation';
import AIEPFooter from '../components/AIEPFooter';
import './WelcomePage.css';

export default function WelcomePage() {
  const { setAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [, setUserEmail] = useState<string>('');
  const { t } = useLanguage();

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const result = await getCurrentUser();
        if (!result || Object.keys(result).length === 0) {
          // console.log("No authenticated user found");
          await signOut();
          setAuthenticated(false);
          navigate('/');
        }
        else {
          // console.log("JWT Payload:", result?.signInUserSession?.idToken?.payload);
          
          // v6: ID-token claims come from fetchAuthSession(), not the user object.
          const payload = ((await fetchAuthSession()).tokens?.idToken?.payload ?? {}) as Record<string, unknown>;
          const email = payload['email'];
          
          // Set the email in state
          setUserEmail(typeof email === 'string' ? email : '');
          
          // console.log("User details:", {
          //   email,
          //   name,
          //   role,
          //   sub,
          //   tokenExpiration: new Date(exp * 1000).toLocaleString()
          // });
        }
      } catch (error) {
        // console.error("Authentication check failed:", error);
        await signOut();
        setAuthenticated(false);
        navigate('/');
      }
    };

    checkAuth();
  }, [setAuthenticated, navigate]);

  return (
    <>
    <MobileTopNavigation />
    <Container fluid className="welcome-container">
      <Row style={{ width: '100%', justifyContent: 'center' }}>
        <Col xs={12} md={8} lg={6}>
          {/* First Card - Summary and Translation */}
          <Card 
            className="hover-effect option-card"
            onClick={() => navigate('/summary-and-translations')}
          >
            <Card.Body className="py-4">
              <div className="d-flex align-items-center">
                <div className="flex-shrink-0">
                  <i className="bi bi-translate text-success" style={{ fontSize: '2rem' }}></i>
                </div>
                <div className="ms-4 text-start">
                  <h3 className="mb-1">{t('welcome.summary.title')}</h3>
                  <p className="text-muted mb-0">{t('welcome.summary.description')}</p>
                </div>
              </div>
            </Card.Body>
          </Card>

          {/* Second Card - Upload IEP */}
          <Card 
            className="mb-4 hover-effect option-card"
            onClick={() => navigate('/iep-documents')}
          >
            <Card.Body className="py-4">
              <div className="d-flex align-items-center">
                <div className="flex-shrink-0">
                  <i className="bi bi-upload text-primary" style={{ fontSize: '2rem' }}></i>
                </div>
                <div className="ms-4 text-start">
                  <h3 className="mb-1">{t('welcome.upload.title')}</h3>
                  <p className="text-muted mb-0">{t('welcome.upload.description')}</p>
                </div>
              </div>
            </Card.Body>
          </Card>
          
          {/* Third Card - Rights and Onboarding */}
          <Card 
            className="mb-4 hover-effect option-card"
            onClick={() => navigate('/rights-and-onboarding')}
          >
            <Card.Body className="py-4">
              <div className="d-flex align-items-center">
                <div className="flex-shrink-0">
                  <i className="bi bi-info-circle text-info" style={{ fontSize: '2rem' }}></i>
                </div>
                <div className="ms-4 text-start">
                  <h3 className="mb-1">{t('welcome.rights.title')}</h3>
                  <p className="text-muted mb-0">{t('welcome.rights.description')}</p>
                </div>
              </div>
            </Card.Body>
          </Card>
        </Col>
        <Col xs={12} className="text-center mb-4">
          <Button 
            variant="link" 
            className='text-decoration-none'
            onClick={() => navigate('/profile')}
          >
            {t('welcome.update.profile')} <i className="bi bi-arrow-right"></i>
          </Button>
        </Col>
      </Row>
    </Container>
    <AIEPFooter />
    </>
  );
}