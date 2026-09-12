// UploadIEPDocument.tsx
import React, { useState, useContext, useRef, useEffect } from 'react';
import {
  Form,
  Button,
  Container,
  Alert,
  ProgressBar,
  ListGroup
} from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { IEPDocumentClient } from '../../common/api-client/iep-document-client';
import { isPlaceholderChildName } from '../../common/features';
import { FileUploader } from '../../common/file-uploader';
import { Utils } from '../../common/utils';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faFileAlt, faTimesCircle, faUpload } from '@fortawesome/free-solid-svg-icons';
import { useLanguage } from '../../common/language-context';
import { isLikelyEncryptedPdf } from '../../common/pdf-encryption';
import PdfPasswordPromptModal from '../../components/PdfPasswordPromptModal';
import './UploadIEPDocument.css';

/**
 * Local, per-file state for the password prompt pdf-decrypt.ts drives via its
 * requestPassword callback. Not merged into the many standalone useState
 * calls above: these three fields only ever change together (see
 * requestPassword/handlePasswordSubmit/handlePasswordCancel below), so one
 * object keeps them from drifting out of sync the way three separate
 * setters could.
 */
interface PasswordPromptState {
  isOpen: boolean;
  isWrongPassword: boolean;
  isChecking: boolean;
}

const CLOSED_PASSWORD_PROMPT: PasswordPromptState = {
  isOpen: false,
  isWrongPassword: false,
  isChecking: false,
};

// Define allowed file types and MIME types
const fileExtensions = new Set([".doc", ".docx", ".pdf"]);

/**
 * The largest file the pipeline can actually finish.
 *
 * Mistral's OCR API is the pipeline's first step and it rejects anything over
 * 50 MB (its Document AI FAQ, "Are there any limits regarding the OCR API?").
 * This gate used to sit at 100MB, so a file in between uploaded cleanly,
 * started the pipeline, and came back as a failure after a full wait on the
 * processing screen -- mistral_ocr/handler.py treats the provider's 4xx as
 * permanent and the state machine retries it zero times, correctly, because
 * the same file would be rejected every time. The parent had no way to know
 * the size was the problem. Refusing at the picker is the same fact, told
 * honestly, in the second they pick the file.
 *
 * Decimal MB rather than 1024-based: "50 MB" in the provider's docs does not
 * say which it means, and 50 * 1000 * 1000 is the reading that cannot admit a
 * file they would reject. It also matches the size macOS shows next to the
 * file, so the number in the message is the number the parent sees.
 *
 * The same FAQ caps documents at 1,000 pages. That is deliberately NOT checked
 * here: counting pages means parsing the file, which costs pdfjs-dist (~1.7 MB
 * of parser and worker) on every upload, works for PDFs only -- .doc/.docx
 * cannot be counted in the browser at all -- and a 1,000-page document that
 * still fits under 50 MB is not a shape a scanned IEP takes. See
 * pdf-encryption.ts's docblock, which weighed the same parser for the same
 * kind of check and reached the same answer.
 *
 * Exported so UploadIEPDocument.test.tsx can check the five dictionaries still
 * quote this number back to the parent: the limit and the copy that announces
 * it are in different files and different languages, and nothing else notices
 * when only one of them moves.
 */
export const MAX_FILE_SIZE_BYTES = 50 * 1000 * 1000;

const mimeTypes = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export interface UploadIEPDocumentProps {
  onUploadComplete: () => void;
  hasExistingDocument: boolean;
}

const UploadIEPDocument: React.FC<UploadIEPDocumentProps> = ({ onUploadComplete, hasExistingDocument }) => {
  const appContext = useContext(AppContext);
  const apiClient = new IEPDocumentClient(appContext);
  const navigate = useNavigate();

  // The name the design puts in a gold chip above the heading, so a parent
  // uploading for one of several children can see which file they are about
  // to attach to whom. Empty until the profile answers, and empty for good if
  // it never does or if the child is still the auto-created placeholder: a
  // chip with nothing in it would be worse than no chip.
  const [childName, setChildName] = useState<string>('');

  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'uploading' | 'success' | 'error'>('idle');
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [currentFileName, setCurrentFileName] = useState<string>("");

  // True while an /Encrypt-flagged PDF is being opened client-side: the
  // silent empty-password attempt, and (if that fails) verifying whatever
  // the parent submits in the password prompt. Shown as neutral "checking"
  // copy rather than nothing, so a multi-page rebuild does not look like a
  // frozen file picker -- see pdf-decrypt.ts for why this can take a moment.
  const [isCheckingFile, setIsCheckingFile] = useState<boolean>(false);
  const [passwordPrompt, setPasswordPrompt] = useState<PasswordPromptState>(CLOSED_PASSWORD_PROMPT);
  // Bridges pdf-decrypt.ts's requestPassword callback to this component's
  // modal: holds the ONE pending attempt's resolver between "the modal is
  // shown" and "the parent submitted or cancelled it". Never holds a
  // password itself, only the function that hands one to the caller.
  const passwordResolverRef = useRef<((password: string | null) => void) | null>(null);

  const { t } = useLanguage();

  useEffect(() => {
    let cancelled = false;
    new ApiClient(appContext).profile
      .getProfile()
      .then((profile) => {
        const name = profile?.children?.[0]?.name;
        if (!cancelled && !isPlaceholderChildName(name)) setChildName(name as string);
      })
      .catch(() => {
        // The badge is a courtesy, not a precondition for uploading: a profile
        // that will not load leaves the chip off and the screen working. The
        // failure is already reported wherever the profile actually matters.
      });
    return () => { cancelled = true; };
  }, [appContext]);

  /**
   * Passed to pdf-decrypt.ts's resolveEncryptedPdf as its requestPassword
   * callback. Opens (or updates) the modal and returns a promise that
   * settles when the parent acts, via the ref above -- resolved by
   * handlePasswordSubmit/handlePasswordCancel, never by this function
   * itself, since it has no way to know when that happens.
   */
  const requestPassword = (isWrongPassword: boolean): Promise<string | null> => {
    setPasswordPrompt({ isOpen: true, isWrongPassword, isChecking: false });
    return new Promise((resolve) => {
      passwordResolverRef.current = resolve;
    });
  };

  const handlePasswordSubmit = (password: string) => {
    setPasswordPrompt((prev) => ({ ...prev, isChecking: true }));
    const resolve = passwordResolverRef.current;
    passwordResolverRef.current = null;
    resolve?.(password);
  };

  const handlePasswordCancel = () => {
    setPasswordPrompt(CLOSED_PASSWORD_PROMPT);
    const resolve = passwordResolverRef.current;
    passwordResolverRef.current = null;
    resolve?.(null);
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (!selectedFile) return;

    const fileExtension = selectedFile.name.slice(selectedFile.name.lastIndexOf('.')).toLowerCase();

    if (!fileExtensions.has(fileExtension)) {
      setFileError(t('upload.fileError.format'));
      setFile(null);
    } else if (selectedFile.size > MAX_FILE_SIZE_BYTES) {
      setFileError(t('upload.fileError.size'));
      setFile(null);
    // Only PDFs carry the /Encrypt trailer entry this checks for; a .doc/.docx
    // uses a different (OOXML/OLE) encryption mechanism this does not detect.
    // isLikelyEncryptedPdf never rejects: any error reading the file resolves
    // false, so a check that cannot run lets the upload proceed rather than
    // blocking a parent (see pdf-encryption.ts).
    } else if (fileExtension === '.pdf' && await isLikelyEncryptedPdf(selectedFile)) {
      // pdf-decrypt.ts is dynamically imported here, not at module scope: it
      // (and the pdfjs-dist/jsPDF it loads in turn) must never be fetched for
      // the overwhelming majority of uploads that are not encrypted at all.
      setIsCheckingFile(true);
      try {
        const { resolveEncryptedPdf } = await import('../../common/pdf-decrypt');
        const outcome = await resolveEncryptedPdf(selectedFile, { requestPassword });
        if (outcome.status === 'resolved') {
          // Either the empty-password attempt worked (owner-restricted only,
          // the parent never saw any of this) or a password they entered did.
          // Either way, what lands here is a clean, already-decrypted file.
          setFile(outcome.file);
          setFileError(null);
        } else if (outcome.status === 'cancelled') {
          // The parent chose not to enter a password. Leave them exactly
          // where a fresh file picker would: no file staged, no error either
          // -- they backed out, they did not fail at something.
          setFile(null);
          setFileError(null);
        } else {
          // pdf.js could not be loaded, or the file could not be opened at
          // all (corrupt, unsupported encryption). The one thing that has
          // always worked -- save an unprotected copy -- is still true.
          setFile(null);
          setFileError(t('upload.fileError.encrypted'));
        }
      } catch {
        // resolveEncryptedPdf's own contract is to resolve 'failed' rather
        // than throw for every internal error; this only catches a bug in
        // that contract, or the dynamic import itself failing outright (the
        // chunk could not be fetched at all). Never a silent swallow: the
        // parent still gets an actionable message, the same one they would
        // have gotten before this feature existed.
        setFile(null);
        setFileError(t('upload.fileError.encrypted'));
      } finally {
        setIsCheckingFile(false);
        setPasswordPrompt(CLOSED_PASSWORD_PROMPT);
      }
    } else {
      setFile(selectedFile);
      setFileError(null);
    }

    setGlobalError(null);
  };

  const handleUpload = async () => {
    if (!file) return;
    
    // Log upload start time for timing measurements
    const uploadStartTime = Date.now();
    // console.log(`🚀 Document upload started at ${new Date(uploadStartTime).toLocaleTimeString()}`);
    localStorage.setItem('iep-upload-start-time', uploadStartTime.toString());
    
    setUploadStatus('uploading');
    setUploadProgress(0);
    setCurrentFileName(file.name);
    
    const uploader = new FileUploader();
    let hasError = false;
    
    try {
      const fileExtension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
      const fileType = mimeTypes[fileExtension];
      
      // Get upload URL
      const uploadUrl = await apiClient.getUploadURL(file.name, fileType);
      
      // Upload file to S3
      await uploader.upload(
        file,
        uploadUrl,
        fileType,
        (uploaded: number) => {
          const percent = Math.round((uploaded / file.size) * 100);
          setUploadProgress(percent);
        }
      );
    } catch (error) {
      // console.error('Upload error:', error);
      setGlobalError(typeof error === 'string' ? error : t('upload.error.general'));
      hasError = true;
      setUploadStatus('error');
    }
    
    if (!hasError) {
      setUploadStatus('success');
      setFile(null);
      // Call the callback function to notify parent component
      onUploadComplete();
      
      // Navigate based on whether there was an existing document
      if (hasExistingDocument) {
        // If there was already a document, go to summary page
        navigate('/summary-and-translations');
      } else {
        // If this is the first document, go to about-app page
        navigate('/summary-and-translations');
      }
    }
  };

  const getProgressbarStatus = () => {
    switch (uploadStatus) {
      case 'error':
        return 'danger';
      case 'success':
        return 'success';
      default:
        return 'info';
    }
  };

  return (
    <Container className="p-0">
          {childName && (
            <p className="upload-child-badge" data-testid="upload-child-badge">
              {/* The name alone says nothing to a screen reader. */}
              <span className="visually-hidden">{t('upload.childBadge.label')}</span>
              <span>{childName}</span>
            </p>
          )}
          <h2 className="upload-iep-title">{t('upload.title')}</h2>
          <p>
          {t('upload.maxSize')}
          </p>
          
          {globalError && (
            <Alert variant="danger">{globalError}</Alert>
          )}
          
          <Form>
            <Form.Group controlId="formFile" className="mb-3">
              <div className={`seamless-file-upload`}>
                <input
                  type="file"
                  id="fileUpload"
                  onChange={handleFileChange}
                  disabled={uploadStatus === 'uploading' || isCheckingFile || passwordPrompt.isOpen}
                />
                <div className={`seamless-file-container ${uploadStatus === 'uploading' ? 'disabled' : ''}`}>
                  <span className="seamless-file-button">
                    {t('upload.selectFile')}
                  </span>
                  <span className={`seamless-file-text ${file ? 'has-file' : ''}`}>
                    {file ? file.name : t('upload.noFileSelected')}
                  </span>
                </div>
              </div>
              {isCheckingFile && !passwordPrompt.isOpen && (
                <Form.Text className="text-muted" data-testid="checking-file-indicator">
                  {t('upload.checkingFile')}
                </Form.Text>
              )}
              {fileError && (
                <Form.Text className="text-danger">
                  {fileError}
                </Form.Text>
              )}
              <Form.Text className="text-muted">
              {t('upload.supportedFormats')} {Array.from(fileExtensions).join(', ')}
              </Form.Text>
            </Form.Group>
            
            {file && (
              <ListGroup className="file-list">
                <ListGroup.Item className="d-flex justify-content-between align-items-center">
                  <div>
                    <FontAwesomeIcon icon={faFileAlt} className="me-2" />
                    {file.name} ({Utils.bytesToSize(file.size)})
                  </div>
                  <Button 
                    variant="link" 
                    className="text-danger" 
                    onClick={() => setFile(null)}
                  >
                    <FontAwesomeIcon icon={faTimesCircle} />
                  </Button>
                </ListGroup.Item>
              </ListGroup>
            )}
            
            {uploadStatus === 'uploading' && (
              <div className="progress-container">
                <p>{currentFileName}</p>
                <ProgressBar 
                  now={uploadProgress} 
                  label={`${uploadProgress}%`} 
                  variant={getProgressbarStatus()}
                  animated={uploadStatus === 'uploading'}
                />
              </div>
            )}
            
            {uploadStatus === 'success' && (
              <Alert variant="success" className="mt-3">
                {t('upload.success')}
              </Alert>
            )}
            
            {uploadStatus === 'error' && (
              <Alert variant="danger" className="mt-3">
                {t('upload.error')}
              </Alert>
            )}
            
            <div className="d-grid gap-2 mt-3">
              <Button
                variant="primary"
                onClick={handleUpload}
                disabled={!file || uploadStatus === 'uploading'}
                // Stable E2E hook: the label is localized
                data-testid="upload-submit-button"
              >
                <FontAwesomeIcon icon={faUpload} className="me-2" />
                {t('upload.button')}
              </Button>
            </div>
          </Form>

          <PdfPasswordPromptModal
            show={passwordPrompt.isOpen}
            wrongPassword={passwordPrompt.isWrongPassword}
            checking={passwordPrompt.isChecking}
            onSubmit={handlePasswordSubmit}
            onCancel={handlePasswordCancel}
          />
    </Container>
  );
};

export default UploadIEPDocument;