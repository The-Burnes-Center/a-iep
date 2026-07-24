import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Container, Row, Col, Button } from 'react-bootstrap';
import { useLanguage } from '../common/language-context';
import MobileTopNavigation from '../components/MobileTopNavigation';
import AIEPFooter from '../components/AIEPFooter';
import './RightsAndOnboarding.css';

const RightsAndOnboarding: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useLanguage();

  // Create an array of bullet point keys
  const bulletPointKeys = [
    'rights.bulletPoints.1',
    'rights.bulletPoints.2',
    'rights.bulletPoints.3',
    'rights.bulletPoints.4',
    'rights.bulletPoints.5',
    'rights.bulletPoints.6'
  ];

  const handleBackClick = () => {
    // The legacy /welcome-page card hub is retired; Summary is the app home
    navigate('/summary-and-translations');
  };

  return (
    <>
    <MobileTopNavigation />
    <Container className="mt-4 mb-5">
      <div className="mt-3 text-start">
        <Button variant="outline-secondary" onClick={handleBackClick}>
          {t('common.back')}
        </Button>
      </div>
      <Row>
        <Col>
          <div className="content-section rights-tab-content">
            <h2>{t('rights.title')}</h2>
            <p>{t('rights.description')}</p>
            <ul className="mt-3 rights-list">
              {bulletPointKeys.map((key, index) => (
                <li key={index} className="mb-2">{t(key)}</li>
              ))}
            </ul>
          </div>
        </Col>
      </Row>
    </Container>
    <AIEPFooter />
    </>
  );
};

export default RightsAndOnboarding;