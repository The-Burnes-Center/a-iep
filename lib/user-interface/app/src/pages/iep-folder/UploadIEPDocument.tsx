// UploadIEPDocument.tsx
import React, { useState, useContext } from 'react';
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
import { IEPDocumentClient } from '../../common/api-client/iep-document-client';
import { FileUploader } from '../../common/file-uploader';
import { Utils } from '../../common/utils';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faFileAlt, faTimesCircle, faUpload } from '@fortawesome/free-solid-svg-icons';
import { useLanguage } from '../../common/language-context';
import './UploadIEPDocument.css';

// Define allowed file types and MIME types
const fileExtensions = new Set([".doc", ".docx", ".pdf"]);

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
  
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'uploading' | 'success' | 'error'>('idle');
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [currentFileName, setCurrentFileName] = useState<string>("");

  const { t } = useLanguage();

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (!selectedFile) return;
    
    const fileExtension = selectedFile.name.slice(selectedFile.name.lastIndexOf('.')).toLowerCase();
    
    if (!fileExtensions.has(fileExtension)) {
      setFileError(t('upload.fileError.format'));
      setFile(null);
    } else if (selectedFile.size > 100 * 1024 * 1024) { // 100MB
      setFileError(t('upload.fileError.size'));
      setFile(null);
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
                  disabled={uploadStatus === 'uploading'}
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
    </Container>
  );
};

export default UploadIEPDocument;