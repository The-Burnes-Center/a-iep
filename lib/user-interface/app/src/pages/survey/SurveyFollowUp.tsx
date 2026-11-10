import React, { useContext, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import Button from '../../components/ui/Button';
import { TextArea } from '../../components/ui/fields';
import { Notice } from '../../components/ui/feedback';
import PageShell from '../../components/page/PageShell';
import PageLoading from '../../components/PageLoading';
import ChildBar from '../../components/ChildBar';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { useLanguage } from '../../common/language-context';
import { useFeatures } from '../../common/hooks/use-features';
import { useActiveChild } from '../../common/hooks/use-active-child';
import { isPlaceholderChildName } from '../../common/features';
import { STEP } from '../../common/breadcrumb-steps';
import type { ChildSurvey, SurveyAnswers, SurveySave } from '../../common/types';
import { QUESTIONS, withoutBlanks } from './questions';
import { isFollowUpDue } from './survey-state';
import { surveyQueryKey, useChildSurvey } from './use-child-survey';
import { FollowUpStatements, ResearchChoice } from './SurveyParts';
import './survey.css';

/**
 * A few of the baseline's statements again, word for word, after the summary,
 * so the change can be measured. Research consent is asked again here rather
 * than carried over: the parent is agreeing to a second set of answers.
 */
const SurveyFollowUp: React.FC = () => {
  const { t } = useLanguage();
  const { isFeatureEnabled } = useFeatures();
  const enabled = isFeatureEnabled('onboardingSurvey');
  const navigate = useNavigate();
  const appContext = useContext(AppContext);
  const queryClient = useQueryClient();
  const { child, childId, isLoading, pathFor } = useActiveChild();
  const surveyQuery = useChildSurvey(childId, enabled);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [answers, setAnswers] = useState<SurveyAnswers | null>(null);
  const [consent, setConsent] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => { headingRef.current?.focus(); }, [surveyQuery.isSuccess]);

  const summaryPath = pathFor('/summary-and-translations');
  if (!enabled) return <Navigate to={summaryPath} replace />;
  if (isLoading || surveyQuery.isLoading || (surveyQuery.isFetching && !surveyQuery.isFetchedAfterMount)) {
    return <PageLoading message={t('common.loading')} />;
  }
  if (surveyQuery.isError || !surveyQuery.data || !childId) {
    return (
      <PageShell>
        <Notice tone="error" title={t('survey.error.load')} />
        <Button variant="secondary" onClick={() => surveyQuery.refetch()}>{t('common.tryAgain')}</Button>
      </PageShell>
    );
  }
  if (!isFollowUpDue(surveyQuery.data)) return <Navigate to={summaryPath} replace />;

  const shown = answers ?? surveyQuery.data.after?.answers ?? {};
  const agreed = consent ?? surveyQuery.data.after?.researchConsent;
  const name = isPlaceholderChildName(child?.name) ? t('survey.yourChild') : (child?.name as string);

  const finish = async (status: 'done' | 'declined') => {
    const save: SurveySave = status === 'done'
      ? { phase: 'after', status, part: 'followUp', answers: withoutBlanks(shown), researchConsent: agreed }
      : { phase: 'after', status };
    setSaving(true);
    setSaveFailed(false);
    try {
      const record = await new ApiClient(appContext).profile.saveSurvey(childId, save);
      queryClient.setQueryData<ChildSurvey>(surveyQueryKey(childId), (old) => (old ? { ...old, after: record } : old));
      navigate(summaryPath);
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const setAnswer = (key: string, value: string | string[]) => setAnswers({ ...shown, [key]: value });
  return (
    <>
      <ChildBar />
      <PageShell trail={[{ ...STEP.summary, to: summaryPath }, STEP.followUp]} className="survey-page">
        <section className="page-card survey-card">
          <h1 ref={headingRef} tabIndex={-1} className="survey-title" data-testid="survey-title">{t('survey.followUp.title')}</h1>
          <p className="survey-lede">{t('survey.followUp.intro')}</p>
          <FollowUpStatements name={name} answers={shown} onAnswer={setAnswer} />
          <TextArea
            label={t('survey.q.anythingElse')}
            optionalLabel={t('survey.optional')}
            maxLength={QUESTIONS.after.text.anythingElse}
            value={(shown.anythingElse as string) ?? ''}
            onChange={(e) => setAnswer('anythingElse', e.target.value)}
          />
          <ResearchChoice name="research-after" value={agreed} onChange={setConsent} />
          {saveFailed && <Notice tone="error" title={t('survey.error.save')} />}
          <div className="survey-actions">
            <Button fullWidth busy={saving} busyLabel={t('common.saving')} onClick={() => finish('done')} data-testid="follow-up-send">
              {t('survey.followUp.send')}
            </Button>
            <Button variant="text" fullWidth disabled={saving} onClick={() => finish('declined')} data-testid="follow-up-decline">
              {t('survey.invite.no')}
            </Button>
          </div>
        </section>
      </PageShell>
    </>
  );
};

export default SurveyFollowUp;
