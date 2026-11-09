import React from 'react';
import IEPSummarizationAndTranslation from './IEPSummarizationAndTranslation';
import ChildBar from '../../components/ChildBar';
import PageLoading from '../../components/PageLoading';
import { useActiveChild } from '../../common/hooks/use-active-child';
import { useLanguage } from '../../common/language-context';

/**
 * The summary route. It waits for the profile before mounting the page, so
 * the page's first document fetch is already for the right child: fetching
 * while `?child=` was still unresolved would load the first child's document
 * for a moment under a link to another's.
 *
 * Keyed by child, so switching children remounts the page and no document,
 * poller or translation state from one child can survive onto another.
 */
const SummaryAndTranslationsPage: React.FC = () => {
  const { t } = useLanguage();
  const { childId, isLoading } = useActiveChild();
  if (isLoading) return <PageLoading message={t('common.loading')} />;

  return (
    <>
      <ChildBar />
      <IEPSummarizationAndTranslation key={childId ?? 'first-child'} />
    </>
  );
};

export default SummaryAndTranslationsPage;
