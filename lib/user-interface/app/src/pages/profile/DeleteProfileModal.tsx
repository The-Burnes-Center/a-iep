import React, { useState, useContext } from 'react';
import { Modal, Button, Alert } from 'react-bootstrap';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { Auth } from 'aws-amplify';
import { useAuth } from '../../common/auth-provider';
import { useLanguage } from '../../common/language-context';

interface DeleteProfileModalProps {
  show: boolean;
  onHide: () => void;
}

const DeleteProfileModal: React.FC<DeleteProfileModalProps> = ({ show, onHide }) => {
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const { setAuthenticated } = useAuth();
  const { t } = useLanguage();

  const handleDeleteProfile = async () => {
    try {
      setProcessing(true);
      setError(null);
      
      // Delete the entire user profile and all data
      await apiClient.profile.deleteProfile();
      
      // Sign out the user
      await Auth.signOut();
      setAuthenticated(false);
      
      // Close modal and redirect will happen via auth context
      onHide();
    } catch (err) {
      // console.error('Error deleting profile:', err);
      setError(t('delete.error.failed'));
      setProcessing(false);
    }
  };

  const handleCancel = () => {
    if (!processing) {
      setError(null);
      onHide();
    }
  };

  return (
    <Modal show={show} onHide={handleCancel} centered>
      <Modal.Header closeButton={!processing}>
        <Modal.Title className="text-danger">
          <i className="bi bi-exclamation-triangle-fill me-2"></i>
          {t('delete.title')}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {error && (
          <Alert variant="danger" className="mb-3">
            {error}
          </Alert>
        )}
        
        <div className="mb-3">
          <p className="fw-bold text-danger">{t('delete.description1')}</p>
          <p className="mb-2">{t('delete.description2')}</p>
          <ul className="list-unstyled ms-3">
            <li>{t('delete.item1')}</li>
            <li>{t('delete.item2')}</li>
            <li>{t('delete.item3')}</li>
            <li>{t('delete.item4')}</li>
          </ul>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button 
          variant="secondary" 
          onClick={handleCancel}
          disabled={processing}
        >
          {t('delete.button.back')}
        </Button>
        <Button 
          variant="danger" 
          onClick={handleDeleteProfile}
          disabled={processing}
        >
          {processing ? (
            <>
              <span className="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
              {t('delete.button.processing')}
            </>
          ) : (
            t('delete.button.delete')
          )}
        </Button>
      </Modal.Footer>
    </Modal>
  );
};

export default DeleteProfileModal; 