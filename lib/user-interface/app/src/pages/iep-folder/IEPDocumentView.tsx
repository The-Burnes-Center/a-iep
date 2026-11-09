import React, { useState } from 'react';
import { Alert } from 'react-bootstrap';
import UploadIEPDocument from './UploadIEPDocument';
import CurrentIEPDocument from './CurrentIEPDocument';
import './IEPDocumentView.css';
import { useLanguage } from '../../common/language-context';
import { STEP } from '../../common/breadcrumb-steps';
import ChildBar from '../../components/ChildBar';
import PageShell from '../../components/page/PageShell';
import PageHero from '../../components/page/PageHero';
import { useActiveChild } from '../../common/hooks/use-active-child';

/**
 * The upload screen, in the shared page system (components/page).
 *
 * The trail says where the parent is, not where a summary would be: a parent
 * uploading their first IEP has no summary, so "Summary > Upload IEP" pointed
 * them at a screen that does not exist yet (UI audit, 2026-11-09). Until a
 * document is on file the trail is this screen alone; once one is, it leads
 * back to that child's summary.
 */
const IEPDocumentView: React.FC = () => {
  const [refreshNeeded, setRefreshNeeded] = useState(false);
  const [documentExists, setDocumentExists] = useState(false);
  const { t } = useLanguage();
  const { pathFor } = useActiveChild();

  const handleUploadComplete = () => {
    setRefreshNeeded(true);
  };

  const handleRefreshNeeded = () => {
    setRefreshNeeded(false);
  };

  const handleDocumentStateChange = (exists: boolean) => {
    setDocumentExists(exists);
  };

  const trail = documentExists
    ? [{ ...STEP.summary, to: pathFor(STEP.summary.to) }, STEP.uploadIep]
    : [STEP.uploadIep];

  return (
    <PageShell trail={trail}>
      <ChildBar />
      <PageHero
        titleId="upload-title"
        title={t(documentExists ? 'upload.hero.titleReplace' : 'upload.title')}
        description={t('upload.maxSize')}
      />
      {refreshNeeded && (
        <Alert variant="info" dismissible onClose={() => setRefreshNeeded(false)} className="mb-0">
          {t('document.updateAlert')}
        </Alert>
      )}
      <section className="page-card" aria-labelledby="upload-title">
        <UploadIEPDocument
          onUploadComplete={handleUploadComplete}
          hasExistingDocument={documentExists}
          showTitle={false}
        />
      </section>
      <CurrentIEPDocument
        onRefreshNeeded={handleRefreshNeeded}
        onDocumentStateChange={handleDocumentStateChange}
      />
    </PageShell>
  );
};

export default IEPDocumentView;
