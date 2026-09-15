import React from 'react';
import { Container, Row, Col } from 'react-bootstrap';
import { useLanguage } from '../common/language-context';
import { STEP } from '../common/breadcrumb-steps';
import Breadcrumbs from '../components/Breadcrumbs';
import './RightsAndOnboarding.css';

const RightsAndOnboarding: React.FC = () => {
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

  return (
    <>
    {/* The legacy /welcome-page card hub is retired; Summary is the app home */}
    <Breadcrumbs trail={[STEP.summary, STEP.rights]} />
    <Container className="mt-4 mb-5">
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
    </>
  );
};

export default RightsAndOnboarding;