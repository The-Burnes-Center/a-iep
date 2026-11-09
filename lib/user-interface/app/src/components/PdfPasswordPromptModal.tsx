// PdfPasswordPromptModal.tsx
//
// Presentational only: everything about pdf.js, empty-password attempts and
// rebuilding a clean file lives in ../common/pdf-decrypt.ts. This component's
// only job is to ask for a password and report back what the parent typed (or
// that they cancelled), and to hold that password for as short a time as
// possible: `password` is local state that is cleared right after every
// submit AND whenever the modal is hidden (see the effect below), so no
// mounted-but-hidden copy of a previous attempt lingers between files.
import React, { useEffect, useState } from 'react';
import { Modal, Form } from 'react-bootstrap';
import Button from './ui/Button';
import { TextField } from './ui/fields';
import { useLanguage } from '../common/language-context';

interface PdfPasswordPromptModalProps {
  show: boolean;
  /** True once a password the parent typed has been rejected. False for the
   * first prompt shown for a given file. */
  wrongPassword: boolean;
  /** True while pdf-decrypt.ts is verifying the last submitted password. */
  checking: boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

const PdfPasswordPromptModal: React.FC<PdfPasswordPromptModalProps> = ({
  show,
  wrongPassword,
  checking,
  onSubmit,
  onCancel,
}) => {
  const { t } = useLanguage();
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Belt and suspenders alongside the post-submit clear below: whenever this
  // modal is not shown (cancelled, or the parent's file resolved), whatever
  // was last typed is discarded rather than left sitting in state.
  useEffect(() => {
    if (!show) {
      setPassword('');
    }
  }, [show]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!password || checking) return;
    const submitted = password;
    setPassword('');
    onSubmit(submitted);
  };

  const handleCancel = () => {
    if (checking) return;
    setPassword('');
    onCancel();
  };

  return (
    <Modal show={show} onHide={handleCancel} centered>
      <Form onSubmit={handleSubmit}>
        <Modal.Header closeButton={!checking} closeLabel={t('common.close')}>
          <Modal.Title>{t('upload.passwordProtected.title')}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p>{t('upload.passwordProtected.explanation')}</p>
          {/* The wrong-password message is the field's own error: it is linked
              to the field (aria-describedby, aria-invalid) and announced. */}
          <TextField
            label={t('auth.password')}
            placeholder={t('auth.enterPassword')}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type={showPassword ? 'text' : 'password'}
            error={wrongPassword ? t('upload.passwordProtected.wrongPassword') : null}
            // This is a one-off file password, not an account credential: it
            // should never be offered to the browser's saved-password store.
            autoComplete="off"
          />
          <Button variant="text" onClick={() => setShowPassword((v) => !v)}>
            {showPassword ? t('upload.passwordProtected.hide') : t('upload.passwordProtected.show')}
          </Button>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={handleCancel} disabled={checking}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={!password || checking}
            busy={checking}
            busyLabel={t('upload.passwordProtected.unlocking')}
          >
            {t('upload.passwordProtected.submit')}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
};

export default PdfPasswordPromptModal;
