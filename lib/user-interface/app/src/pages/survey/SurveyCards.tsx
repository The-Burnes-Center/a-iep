import React, { useContext, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { IconPlus } from '@tabler/icons-react';
import Button from '../../components/ui/Button';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { useLanguage } from '../../common/language-context';
import { useFeatures } from '../../common/hooks/use-features';
import { useActiveChild } from '../../common/hooks/use-active-child';
import { fillName } from './fill-name';
import { isPlaceholderChildName } from '../../common/features';
import { isFollowUpDue, isNextChildDue, isWhileYouWaitDue } from './survey-state';
import { surveyQueryKey, useChildSurvey } from './use-child-survey';
import './survey.css';

/** One retry for recording that the summary was opened. */
const SUMMARY_VIEWED_RETRY_MS = 3_000;

const useChildName = () => {
  const { t } = useLanguage();
  const { child } = useActiveChild();
  return isPlaceholderChildName(child?.name) ? t('survey.yourChild') : (child?.name as string);
};

/**
 * On the processing screen: answer the survey while the IEP is read. Shown
 * only while the baseline is open, and worded as a resume once started.
 */
export const SurveyWhileYouWait: React.FC = () => {
  const { t } = useLanguage();
  const { isFeatureEnabled } = useFeatures();
  const enabled = isFeatureEnabled('onboardingSurvey');
  const { childId, pathFor } = useActiveChild();
  const { data } = useChildSurvey(childId, enabled);
  const name = useChildName();
  if (!enabled || !isWhileYouWaitDue(data)) return null;

  const started = data?.before?.status === 'started';
  return (
    <section className="survey-wait-card" aria-labelledby="survey-wait-title" data-testid="survey-wait-card">
      <h2 id="survey-wait-title" className="survey-card-title">{t('survey.wait.title')}</h2>
      <p>{fillName(t(started ? 'survey.wait.resume' : 'survey.wait.body'), name)}</p>
      <Button to={pathFor('/survey')} variant="secondary" fullWidth data-testid="survey-wait-open">
        {t(started ? 'survey.wait.resumeButton' : 'survey.wait.button')}
      </Button>
    </section>
  );
};

/**
 * At the end of a summary the parent can read: record that they opened it
 * (which closes the baseline for good), then offer the follow-up questions
 * and, where the family said more children have an IEP, the next child.
 */
export const SummarySurveyCards: React.FC = () => {
  const { t } = useLanguage();
  const { isFeatureEnabled } = useFeatures();
  const enabled = isFeatureEnabled('onboardingSurvey');
  const appContext = useContext(AppContext);
  const queryClient = useQueryClient();
  const { childId, children, pathFor } = useActiveChild();
  const { data } = useChildSurvey(childId, enabled);
  const name = useChildName();

  useEffect(() => {
    if (!enabled || !childId) return undefined;
    // Idempotent on the server, so it is retried once. It never blocks the
    // summary: if both tries fail, the cost is that this child's baseline
    // stays open, and the record still shows when each answer was given.
    const client = new ApiClient(appContext).profile;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const done = () => queryClient.invalidateQueries({ queryKey: surveyQueryKey(childId) });
    client.markSummaryViewed(childId).then(done).catch(() => {
      retry = setTimeout(() => {
        client.markSummaryViewed(childId).then(done).catch(() => undefined);
      }, SUMMARY_VIEWED_RETRY_MS);
    });
    return () => clearTimeout(retry);
  }, [enabled, childId, appContext, queryClient]);

  if (!enabled) return null;
  const followUp = isFollowUpDue(data);
  const nextChild = isFeatureEnabled('multiChild') && isNextChildDue(data?.iepChildCount, children.length);
  if (!followUp && !nextChild) return null;

  return (
    <div className="survey-summary-cards">
      {followUp && (
        <section className="page-card survey-summary-card" aria-labelledby="survey-follow-up-title" data-testid="survey-follow-up-card">
          <h2 id="survey-follow-up-title" className="survey-card-title">{t('survey.followUp.title')}</h2>
          <p>{t('survey.followUp.cardBody')}</p>
          <Button to={pathFor('/survey/follow-up')} variant="secondary" fullWidth data-testid="survey-follow-up-open">
            {t('survey.followUp.cardButton')}
          </Button>
        </section>
      )}
      {nextChild && (
        <section className="page-card survey-summary-card survey-next-child" aria-labelledby="survey-next-child-title" data-testid="survey-next-child-card">
          <h2 id="survey-next-child-title" className="survey-card-title">{t('survey.nextChild.title')}</h2>
          <p>{fillName(t('survey.nextChild.body'), name)}</p>
          <Button to="/account-center/children/add" icon={<IconPlus size={20} />} fullWidth data-testid="survey-next-child-add">
            {t('survey.nextChild.button')}
          </Button>
        </section>
      )}
    </div>
  );
};
