import React, { useContext, useEffect, useState } from 'react';
import { Alert, Card, Spinner } from 'react-bootstrap';
import { AppContext } from '../../common/app-context';
import { IEPDocumentClient } from '../../common/api-client/iep-document-client';
import './CurrentIEPDocument.css';
import { useLanguage } from '../../common/language-context';

export interface CurrentIEPDocumentProps {
  onRefreshNeeded: () => void;
  onDocumentStateChange: (exists: boolean) => void;
}

const CurrentIEPDocument: React.FC<CurrentIEPDocumentProps> = ({ onRefreshNeeded, onDocumentStateChange }) => {
  const appContext = useContext(AppContext);
  const apiClient = new IEPDocumentClient(appContext);
  
  const [documentName, setDocumentName] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const { t } = useLanguage();

  const fetchDocument = async () => {
    setLoading(true);
    setError(null);
    
    try {
      // Get the most recent document
      const recentDocument = await apiClient.getMostRecentDocumentWithSummary();

      if (recentDocument && recentDocument.documentUrl) {
        // Extract the filename from the document URL
        // Example: s3://bucket/path/to/file/filename.pdf
        const documentUrl = recentDocument.documentUrl;
        const fileName = documentUrl.split('/').pop() || 'No filename available';
        setDocumentName(fileName);
        // Notify parent that document exists
        onDocumentStateChange(true);
      } else {
        setDocumentName(null);
        // Notify parent that no document exists
        onDocumentStateChange(false);
      }
    } catch (err) {
      // console.error('Error fetching document:', err);
      // setError('Failed to load document. Please try again.');
      // Notify parent that no document exists (due to error)
      onDocumentStateChange(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDocument();
    // Call the onRefreshNeeded callback after fetching to signal that refresh is complete
    if (onRefreshNeeded) {
      onRefreshNeeded();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchDocument is recreated every render; refetch is keyed to onRefreshNeeded by design
  }, [onRefreshNeeded]);

  return (
    <Card className="current-document-container">
      <Card.Body>        
        {error && (
          <Alert variant="danger">{error}</Alert>
        )}
        
        {loading ? (
          <div className="text-center my-4">
            <Spinner animation="border" role="status">
              <span className="visually-hidden">{t('current.loading')}</span>
            </Spinner>
          </div>
        ) : documentName ? (
        // The two data-testids below are stable E2E hooks for "is a document
        // on file?"; both messages are localized.
        <div className='upload-info' data-testid="current-document-present">
          <h3>{t('current.header1')}</h3>
          <p>
            {t('current.paragraph1')}
          </p>
        </div>
        ) : (
        <div className='upload-info' data-testid="current-document-absent">
          <h3>{t('current.header2')}</h3>
          <p>
            {t('current.paragraph2')}
          </p>
        </div>
        )}
      </Card.Body>
    </Card>
  );
};

export default CurrentIEPDocument;