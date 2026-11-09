import React, { useState, useContext } from 'react';
import { Modal } from 'react-bootstrap';
import { IconAlertTriangle } from '@tabler/icons-react';
import Button from '../../components/ui/Button';
import { Notice } from '../../components/ui/feedback';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { useAuth } from '../../common/auth-provider';
import { useLanguage } from '../../common/language-context';
import './DeleteProfileModal.css';

interface DeleteProfileModalProps {
  show: boolean;
  onHide: () => void;
}

const DeleteProfileModal: React.FC<DeleteProfileModalProps> = ({ show, onHide }) => {
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

    // Sign out through the context, which is the only thing that also drops
    // the passwordless session handle; Amplify's signOut() alone leaves it in
    // localStorage for the next page load to resume.
    try {
      await logout();
    } catch {
      // The profile is already deleted and this device is already cleared.
      setAuthenticated(false);
    }

    // Close modal and redirect will happen via auth context
    onHide();
  };

  const handleCancel = () => {
    if (!processing) {
      setError(null);
      onHide();
    }
  };

  return (
    <Modal show={show} onHide={handleCancel} centered>
      <Modal.Header closeButton={!processing} closeLabel={t('common.close')}>
        <Modal.Title className="delete-profile-title">
          <IconAlertTriangle size={22} stroke={2} className="delete-profile-icon" aria-hidden="true" />
          {t('delete.title')}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {error && <Notice tone="error">{error}</Notice>}
        
        <div className="delete-profile-body">
          <p className="delete-profile-warning">{t('delete.description1')}</p>
          <p>{t('delete.description2')}</p>
          <ul className="delete-profile-list">
            <li>{t('delete.item1')}</li>
            <li>{t('delete.item2')}</li>
            <li>{t('delete.item3')}</li>
            <li>{t('delete.item4')}</li>
          </ul>
        </div>
      </Modal.Body>
      <Modal.Footer className="delete-profile-footer">
        <Button variant="secondary" onClick={handleCancel} disabled={processing}>
          {t('delete.button.back')}
        </Button>
        <Button
          variant="danger"
          onClick={handleDeleteProfile}
          busy={processing}
          busyLabel={t('delete.button.processing')}
        >
          {t('delete.button.delete')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
};

export default DeleteProfileModal;
