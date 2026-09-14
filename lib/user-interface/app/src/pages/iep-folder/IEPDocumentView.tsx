import React, { useState } from 'react';
import { Container, Row, Col, Alert } from 'react-bootstrap';
import UploadIEPDocument from './UploadIEPDocument';
import CurrentIEPDocument from './CurrentIEPDocument';
import './IEPDocumentView.css';
import { useLanguage } from '../../common/language-context';
import { STEP } from '../../common/breadcrumb-steps';
import Breadcrumbs from '../../components/Breadcrumbs';
import MobileTopNavigation from '../../components/MobileTopNavigation';

const IEPDocumentView: React.FC = () => {
  
  const [refreshNeeded, setRefreshNeeded] = useState(false);
  const [documentExists, setDocumentExists] = useState(false);

  const handleUploadComplete = () => {
    setRefreshNeeded(true);
  };

  const handleRefreshNeeded = () => {
    setRefreshNeeded(false);
  };

  const handleDocumentStateChange = (exists: boolean) => {
    setDocumentExists(exists);
  };

  const { t } = useLanguage();

  return (
    <>
    <MobileTopNavigation />
    <Breadcrumbs trail={[STEP.summary, STEP.uploadIep]} />
    <Container className="document-container mt-4 mb-5">
      <Row>
        <Col>
          <h1 className="document-title"></h1>          
          {refreshNeeded && (
            <Alert variant="info" dismissible onClose={() => setRefreshNeeded(false)}>
              {t('document.updateAlert')}
            </Alert>
          )}
          
          <div className="document-sections-container">
            <div className="document-section">
              <UploadIEPDocument 
                onUploadComplete={handleUploadComplete} 
                hasExistingDocument={documentExists}
              />
            </div>
            
            <div className="document-section">
              <CurrentIEPDocument 
                onRefreshNeeded={handleRefreshNeeded}
                onDocumentStateChange={handleDocumentStateChange}
              />
            </div>
          </div>
        </Col>
      </Row>
    </Container>
    </>
  );
};

export default IEPDocumentView;