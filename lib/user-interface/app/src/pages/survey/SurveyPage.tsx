import React, { useContext, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Button from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/fields';
import { Notice } from '../../components/ui/feedback';
import PageShell from '../../components/page/PageShell';
import PageLoading from '../../components/PageLoading';
import ChildBar from '../../components/ChildBar';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { SurveyClosedError } from '../../common/api-client/profile-client';
import { IEPDocumentClient } from '../../common/api-client/iep-document-client';
import { useLanguage } from '../../common/language-context';
import { useFeatures } from '../../common/hooks/use-features';
import { useActiveChild } from '../../common/hooks/use-active-child';
import { fillTemplate } from '../../common/active-child';
import { isPlaceholderChildName } from '../../common/features';
import type { ChildSurvey, SurveyAnswers, SurveySave } from '../../common/types';
import { childDocumentState, ChildDocumentState } from '../profile/my-children-status';
import { BaselinePart, baselineParts, looksLikeEmail, pruneBaseline, pruneHousehold, withoutBlanks } from './questions';
import { SurveyStep, initialStep, isHouseholdDone } from './survey-state';
import { surveyQueryKey, useChildSurvey } from './use-child-survey';
import { SurveyPart } from './SurveyParts';
import './survey.css';

/** How often the banner re-reads the IEP's progress while it is being read. */
const DOCUMENT_POLL_MS = 15_000;

/**
 * The baseline survey, asked while a child's IEP is read.
 *
 * Nothing in the survey offers the summary while a question is open: a
 * parent who read the summary first would be answering about it, not about
 * where they started. The app's own navigation stays, so nobody is trapped
 * here; opening the summary that way closes the baseline, which the server
 * enforces. Every step is saved on the server as it is left, so leaving and
 * coming back (the bottom nav unmounts this page) lands on the same part.
 */
const SurveyPage: React.FC = () => {
  const { t } = useLanguage();
  const { isFeatureEnabled } = useFeatures();
  const enabled = isFeatureEnabled('onboardingSurvey');
  const { child, childId, isLoading, pathFor } = useActiveChild();
  const surveyQuery = useChildSurvey(childId, enabled);

  if (!enabled) return <Navigate to={pathFor('/summary-and-translations')} replace />;
  // Fresh from the server, never the cache: the flow starts from what it is
  // given, and a cached copy could write over answers from another device.
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

  const name = isPlaceholderChildName(child?.name) ? t('survey.yourChild') : (child?.name as string);
  return <SurveyFlow key={childId} childId={childId} name={name} survey={surveyQuery.data} summaryPath={pathFor('/summary-and-translations')} />;
};

interface FlowProps {
  childId: string;
  name: string;
  survey: ChildSurvey;
  summaryPath: string;
}

const SurveyFlow: React.FC<FlowProps> = ({ childId, name, survey, summaryPath }) => {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const appContext = useContext(AppContext);
  const queryClient = useQueryClient();
  const headingRef = useRef<HTMLHeadingElement>(null);

  const [step, setStep] = useState<SurveyStep>(() => initialStep(survey));
  const [answers, setAnswers] = useState<SurveyAnswers>(survey.before?.answers ?? {});
  const [household, setHousehold] = useState<SurveyAnswers>(survey.household?.answers ?? {});
  const [consent, setConsent] = useState<boolean>(survey.before?.researchConsent ?? false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const parts = baselineParts(isHouseholdDone(survey));
  const documentQuery = useQuery({
    queryKey: ['child-document', childId],
    queryFn: () => new IEPDocumentClient(appContext).getMostRecentDocumentWithSummary(childId),
    refetchInterval: (query) => (childDocumentState(query.state.data, false) === 'reading' ? DOCUMENT_POLL_MS : false),
    retry: false,
  });
  const documentState = childDocumentState(documentQuery.data, documentQuery.isError);

  // A new screen: put the reader on its heading, as a page load would.
  // Focusing it also scrolls it into view, so a long part starts at its top.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const persist = async (save: SurveySave): Promise<boolean> => {
    setSaving(true);
    setSaveFailed(false);
    try {
      const record = await new ApiClient(appContext).profile.saveSurvey(childId, save);
      queryClient.setQueryData<ChildSurvey>(surveyQueryKey(childId), (old) =>
        old ? { ...old, [save.phase]: record } : old);
      return true;
    } catch (error) {
      if (error instanceof SurveyClosedError) {
        setStep('closed');
      } else {
        // The cause is in the API's log; the parent's answers stay on screen.
        setSaveFailed(true);
      }
      return false;
    } finally {
      setSaving(false);
    }
  };

  const baseline = (status: string, part?: string): SurveySave => ({
    phase: 'before', status, part, answers: pruneBaseline(withoutBlanks(answers)), researchConsent: consent,
  });

  const start = async () => {
    if (await persist(baseline('started', parts[0]))) setStep(parts[0]);
  };
  // Leaving for now must not open a summary that is ready: that would close
  // the baseline the parent meant to come back to. Account is neutral.
  const leavePath = documentState === 'ready' ? '/account-center' : summaryPath;

  const leaveForNow = async (status: 'remind' | 'declined') => {
    // A reminder keeps what was answered and the consent given; "No thanks"
    // withdraws the consent with the survey.
    const save: SurveySave = status === 'declined'
      ? { phase: 'before', status, researchConsent: false }
      : baseline('remind');
    if (await persist(save)) navigate(leavePath);
  };

  const next = async (part: BaselinePart) => {
    const index = parts.indexOf(part);
    const isLast = index === parts.length - 1;
    if (part === 'you') {
      const email = (household.email as string | undefined)?.trim();
      if (household.stayInTouch === 'yes' && email && !looksLikeEmail(email)) {
        setErrors({ email: t('survey.error.email') });
        return;
      }
      setErrors({});
      const saved = await persist({
        phase: 'household', status: 'done', part: 'you', answers: pruneHousehold(withoutBlanks(household)),
      });
      if (!saved) return;
    }
    if (isLast) {
      if (await persist(baseline('done', part))) setStep('thanks');
      return;
    }
    if (await persist(baseline('started', parts[index + 1]))) setStep(parts[index + 1]);
  };

  const back = async (part: BaselinePart) => {
    const index = parts.indexOf(part);
    if (index === 0) {
      setStep('invite');
      return;
    }
    if (await persist(baseline('started', parts[index - 1]))) setStep(parts[index - 1]);
  };

  const later = async (part: BaselinePart) => {
    if (await persist(baseline('started', part))) navigate(leavePath);
  };

  const setAnswer = (key: string, value: string | string[]) => setAnswers((old) => ({ ...old, [key]: value }));
  const setHouseholdAnswer = (key: string, value: string | string[]) => setHousehold((old) => ({ ...old, [key]: value }));
  const fill = (key: string) => fillTemplate(t(key), { name });

  const heading = (text: string) => (
    <h1 ref={headingRef} tabIndex={-1} className="survey-title" data-testid="survey-title">{text}</h1>
  );
  const saveError = saveFailed && <Notice tone="error" title={t('survey.error.save')} />;

  if (step === 'closed' || step === 'thanks') {
    return (
      <SurveyShell banner={null}>
        {heading(t('survey.thanks.title'))}
        <p className="survey-lede">
          {step === 'closed' ? fill('survey.closed.body') : fill('survey.thanks.body')}
        </p>
        {step === 'thanks' && (survey.iepChildCount ?? 1) > 1 && (
          <p className="survey-lede">{t('survey.thanks.nextChild')}</p>
        )}
        <FinishAction state={documentState} name={name} summaryPath={summaryPath} />
      </SurveyShell>
    );
  }

  const banner = <DocumentBanner state={documentState} name={name} />;

  if (step === 'invite') {
    const reading = documentState === 'reading';
    const householdDone = isHouseholdDone(survey);
    return (
      <SurveyShell banner={banner}>
        {heading(reading ? fill('survey.invite.titleWhileReading') : t('survey.invite.title'))}
        <p className="survey-lede">{t('survey.invite.body')}</p>
        <ul className="survey-facts">
          <li>{householdDone ? t('survey.invite.timeShort') : t('survey.invite.timeLong')}</li>
          <li>{t('survey.invite.skip')}</li>
          <li>{t('survey.invite.private')}</li>
          {reading && <li>{fill('survey.invite.summaryWaits')}</li>}
        </ul>
        <Checkbox
          label={t('survey.consent.label')}
          hint={t('survey.consent.hint')}
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
        />
        {saveError}
        <div className="survey-actions">
          <Button fullWidth busy={saving} busyLabel={t('common.saving')} onClick={start} data-testid="survey-start">
            {t('survey.invite.yes')}
          </Button>
          <Button variant="secondary" fullWidth disabled={saving} onClick={() => leaveForNow('remind')} data-testid="survey-remind">
            {t('survey.invite.remind')}
          </Button>
          <Button variant="text" fullWidth disabled={saving} onClick={() => leaveForNow('declined')} data-testid="survey-decline">
            {t('survey.invite.no')}
          </Button>
        </div>
      </SurveyShell>
    );
  }

  const index = parts.indexOf(step);
  const isLast = index === parts.length - 1;
  return (
    <SurveyShell banner={banner}>
      <div className="survey-progress">
        <p className="survey-progress-label">
          <span>{fillTemplate(t('survey.progress'), { n: String(index + 1), total: String(parts.length) })}</span>
          <span>{t('survey.progress.skip')}</span>
        </p>
        <div
          className="survey-progress-bar"
          role="progressbar"
          aria-label={t('survey.progress.label')}
          aria-valuemin={0}
          aria-valuemax={parts.length}
          aria-valuenow={index + 1}
          aria-valuetext={fillTemplate(t('survey.progress'), { n: String(index + 1), total: String(parts.length) })}
        >
          <i style={{ width: `${((index + 1) / parts.length) * 100}%` }} />
        </div>
      </div>
      {heading(fill(`survey.part.${step}.title`))}
      <p className="survey-lede">{fill(`survey.part.${step}.intro`)}</p>
      <SurveyPart
        part={step}
        name={name}
        answers={answers}
        onAnswer={setAnswer}
        household={household}
        onHousehold={setHouseholdAnswer}
        errors={errors}
      />
      {saveError}
      <div className="survey-nav">
        <Button variant="secondary" disabled={saving} onClick={() => back(step)} data-testid="survey-back">
          {t('survey.back')}
        </Button>
        <Button busy={saving} busyLabel={t('common.saving')} onClick={() => next(step)} data-testid="survey-next">
          {isLast ? t('survey.finish') : t('survey.next')}
        </Button>
      </div>
      <Button variant="text" fullWidth disabled={saving} onClick={() => later(step)} data-testid="survey-later">
        {t('survey.later')}
      </Button>
    </SurveyShell>
  );
};

const SurveyShell: React.FC<{ banner: React.ReactNode; children: React.ReactNode }> = ({ banner, children }) => (
  <>
    <ChildBar />
    <PageShell className="survey-page">
      {banner}
      <section className="page-card survey-card">{children}</section>
    </PageShell>
  </>
);

/**
 * The IEP's progress while the parent answers. It never offers the summary:
 * a ready summary is announced as waiting for them, not linked.
 */
const DocumentBanner: React.FC<{ state: ChildDocumentState; name: string }> = ({ state, name }) => {
  const { t } = useLanguage();
  const fill = (key: string) => fillTemplate(t(key), { name });
  if (state === 'reading') return <Notice tone="info" title={fill('survey.banner.reading')} data-testid="survey-banner" />;
  if (state === 'ready') return <Notice tone="success" announce title={fill('survey.banner.ready')} data-testid="survey-banner" />;
  if (state === 'failed') return <Notice tone="warning" announce title={fill('survey.banner.failed')} data-testid="survey-banner" />;
  return null;
};

/** Where the thank-you sends the parent, by what their IEP is doing now. */
const FinishAction: React.FC<{ state: ChildDocumentState; name: string; summaryPath: string }> = ({ state, name, summaryPath }) => {
  const { t } = useLanguage();
  const fill = (key: string) => fillTemplate(t(key), { name });
  if (state === 'ready') {
    return <Button to={summaryPath} fullWidth data-testid="survey-see-summary">{fill('survey.thanks.seeSummary')}</Button>;
  }
  return (
    <>
      {state === 'reading' && <Notice tone="info" title={fill('survey.thanks.stillReading')} />}
      <Button to={summaryPath} fullWidth data-testid="survey-see-summary">{fill('survey.thanks.goToIep')}</Button>
    </>
  );
};

export default SurveyPage;
