import React, { useContext, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Button from '../../components/ui/Button';
import { Notice } from '../../components/ui/feedback';
import PageShell from '../../components/page/PageShell';
import PageLoading from '../../components/PageLoading';
import ChildBar from '../../components/ChildBar';
import ProcessingStatusBar from '../../components/ProcessingStatusBar';
import { processingStepKey } from '../utils/processing-progress.mjs';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { SurveyClosedError } from '../../common/api-client/profile-client';
import { childDocumentQuery } from '../../common/child-document-query';
import { useLanguage } from '../../common/language-context';
import { useFeatures } from '../../common/hooks/use-features';
import { useActiveChild } from '../../common/hooks/use-active-child';
import { fillTemplate } from '../../common/active-child';
import { fillName } from './fill-name';
import { isPlaceholderChildName } from '../../common/features';
import type { ChildSurvey, SurveyAnswers, SurveySave } from '../../common/types';
import { childDocumentState, ChildDocumentState } from '../profile/my-children-status';
import { BaselinePart, baselineParts, looksLikeEmail, pruneBaseline, pruneHousehold, withoutBlanks } from './questions';
import { SurveyStep, initialStep, isHouseholdDone } from './survey-state';
import { surveyQueryKey, useChildSurvey } from './use-child-survey';
import { queueSurveySave } from './survey-saves';
import { useSurveyAutosave } from './use-survey-autosave';
import { ResearchChoice, SurveyPart } from './SurveyParts';
import './survey.css';

/** How often the progress card re-reads the IEP, the processing screen's rate. */
const DOCUMENT_POLL_MS = 5_000;

/**
 * The baseline survey, asked while a child's IEP is read.
 *
 * Nothing in the survey offers the summary while a question is open: a
 * parent who read the summary first would be answering about it, not about
 * where they started. The app's own navigation stays, so nobody is trapped
 * here; opening the summary that way closes the baseline, which the server
 * enforces. Every step is saved on the server as it is left, and answers on
 * an open part a moment after they are given and again on leaving, so leaving
 * and coming back (the bottom nav unmounts this page) lands on the same part
 * with the same answers.
 */
const SurveyPage: React.FC = () => {
  const { t } = useLanguage();
  const { isFeatureEnabled } = useFeatures();
  const enabled = isFeatureEnabled('onboardingSurvey');
  const appContext = useContext(AppContext);
  const { child, childId, isLoading, pathFor } = useActiveChild();
  const surveyQuery = useChildSurvey(childId, enabled);
  // Read here, beside the survey, so both load at once and the flow never
  // opens on a cached answer: one from before an upload says "no IEP yet",
  // and every way out of the survey would lead back to the upload form.
  const documentQuery = useQuery({ ...childDocumentQuery(appContext, childId, DOCUMENT_POLL_MS), enabled: enabled && Boolean(childId) });

  if (!enabled) return <Navigate to={pathFor('/summary-and-translations')} replace />;
  // Fresh from the server, never the cache: the flow starts from what it is
  // given, and a cached copy could write over answers from another device.
  const isFresh = (query: { isLoading: boolean; isFetchedAfterMount: boolean }) => !query.isLoading && query.isFetchedAfterMount;
  if (isLoading || !isFresh(surveyQuery) || !isFresh(documentQuery)) {
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
  return (
    <SurveyFlow
      key={childId}
      childId={childId}
      name={name}
      survey={surveyQuery.data}
      document={documentQuery.data as ProgressDocument | undefined}
      documentFailedToLoad={documentQuery.isError}
      summaryPath={pathFor('/summary-and-translations')}
      uploadPath={pathFor('/iep-documents')}
    />
  );
};

interface FlowProps {
  childId: string;
  name: string;
  survey: ChildSurvey;
  /** The child's IEP as the server last said, polled while it is read. */
  document: ProgressDocument | undefined;
  documentFailedToLoad: boolean;
  summaryPath: string;
  uploadPath: string;
}

const SurveyFlow: React.FC<FlowProps> = ({ childId, name, survey, document, documentFailedToLoad, summaryPath, uploadPath }) => {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const appContext = useContext(AppContext);
  const queryClient = useQueryClient();
  const headingRef = useRef<HTMLHeadingElement>(null);

  const [step, setStep] = useState<SurveyStep>(() => initialStep(survey));
  // How the survey stood when the parent arrived. Saves change `survey`, and
  // finishing must still show the thank-you, so this is read once.
  const [statusOnArrival] = useState(() => survey.before?.status);
  const [answers, setAnswers] = useState<SurveyAnswers>(survey.before?.answers ?? {});
  const [household, setHousehold] = useState<SurveyAnswers>(survey.household?.answers ?? {});
  // Unanswered stays undefined and is not sent: only an explicit yes is consent.
  const [consent, setConsent] = useState<boolean | undefined>(survey.before?.researchConsent);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [nothingAnswered, setNothingAnswered] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const parts = baselineParts(isHouseholdDone(survey));

  // Every save for this child, in order, and each one kept in the cache.
  const write = (save: SurveySave) => queueSurveySave(childId, async () => {
    const record = await new ApiClient(appContext).profile.saveSurvey(childId, save);
    queryClient.setQueryData<ChildSurvey>(surveyQueryKey(childId), (old) =>
      old ? { ...old, [save.phase]: record } : old);
    return record;
  });
  const isPart = (parts as SurveyStep[]).includes(step);
  const autosave = useSurveyAutosave({
    isPart,
    write,
    onClosed: () => setStep('closed'),
    saves: () => {
      const kept: SurveySave[] = [baseline('started', step)];
      // The household's answers go with them on their own part, unless the
      // email would be refused; "Next" says why.
      const email = (household.email as string | undefined)?.trim();
      if (step === 'you' && (!email || looksLikeEmail(email))) {
        kept.push({ phase: 'household', status: 'started', part: 'you', answers: pruneHousehold(withoutBlanks(household)) });
      }
      return kept;
    },
  });

  const documentState = childDocumentState(document as Parameters<typeof childDocumentState>[0], documentFailedToLoad);
  const progressDocument = (document ?? {}) as ProgressDocument;

  // A new screen: put the reader on its heading, as a page load would.
  // Focusing it also scrolls it into view, so a long part starts at its top.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  // The onboarding steps before an upload all lead here (firstUploadStep), so
  // a parent who already said no, or finished before uploading, meets the
  // survey again on the way to the upload, e.g. from the upload screen's
  // "how to ask for a PDF" detour. Step aside for them: the closed screen
  // would tell a parent who said no that they had opened a summary.
  const noIepOnArrival = childDocumentState(document as Parameters<typeof childDocumentState>[0], documentFailedToLoad) === 'none';
  if (statusOnArrival === 'declined') return <Navigate to={noIepOnArrival ? uploadPath : summaryPath} replace />;
  if (statusOnArrival === 'done' && noIepOnArrival) return <Navigate to={uploadPath} replace />;

  const persist = async (save: SurveySave): Promise<boolean> => {
    setSaving(true);
    setSaveFailed(false);
    autosave.saved();
    try {
      await write(save);
      return true;
    } catch (error) {
      if (error instanceof SurveyClosedError) {
        setStep('closed');
      } else {
        // The cause is in the API's log; the parent's answers stay on screen,
        // and are kept as unsaved, so leaving still saves them.
        setSaveFailed(true);
        autosave.changed();
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
  // "Later" means coming back, and opening a ready summary would close these
  // questions for good. So while the summary is ready there is no "later":
  // the parent answers now or says no, and "No thanks" opens the summary.
  const canLeaveForLater = documentState !== 'ready';
  // The survey comes before the upload, so with no IEP yet every way out of it
  // goes on to the upload. Otherwise to the child's summary, which itself
  // sends a child with no document to the upload.
  const noIepYet = documentState === 'none';
  const nextPath = noIepYet ? uploadPath : summaryPath;

  const leaveForNow = async (status: 'remind' | 'declined') => {
    // A reminder keeps what was answered and the consent given; "No thanks"
    // withdraws the consent with the survey.
    const save: SurveySave = status === 'declined'
      ? { phase: 'before', status, researchConsent: false }
      : baseline('remind');
    if (await persist(save)) navigate(nextPath);
  };

  const next = async (part: BaselinePart) => {
    const index = parts.indexOf(part);
    const isLast = index === parts.length - 1;
    // Any one question can be skipped; finishing with none answered is not a
    // survey, it is a "No thanks" that would be counted as a response.
    if (isLast && Object.keys(pruneBaseline(withoutBlanks(answers))).length === 0) {
      setNothingAnswered(true);
      return;
    }
    setNothingAnswered(false);
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
    if (await persist(baseline('started', part))) navigate(nextPath);
  };

  const setAnswer = (key: string, value: string | string[]) => {
    setAnswers((old) => ({ ...old, [key]: value }));
    autosave.changed();
  };
  const setHouseholdAnswer = (key: string, value: string | string[]) => {
    setHousehold((old) => ({ ...old, [key]: value }));
    autosave.changed();
  };
  const fill = (key: string) => fillName(t(key), name);

  const heading = (text: string) => (
    <h1 ref={headingRef} tabIndex={-1} className="survey-title" data-testid="survey-title">{text}</h1>
  );
  const saveError = (
    <>
      {nothingAnswered && <Notice tone="error" title={t('survey.error.nothingAnswered')} data-testid="survey-nothing-answered" />}
      {saveFailed && <Notice tone="error" title={t('survey.error.save')} />}
    </>
  );

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
        <FinishAction state={documentState} name={name} summaryPath={summaryPath} uploadPath={noIepYet ? uploadPath : undefined} />
      </SurveyShell>
    );
  }

  const banner = <DocumentBanner state={documentState} name={name} progressDocument={progressDocument} />;

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
          {noIepYet && <li>{fill('survey.invite.uploadNext')}</li>}
        </ul>
        <ResearchChoice name="research-before" value={consent} onChange={setConsent} />
        {saveError}
        <div className="survey-actions">
          <Button fullWidth busy={saving} busyLabel={t('common.saving')} onClick={start} data-testid="survey-start">
            {t('survey.invite.yes')}
          </Button>
          {canLeaveForLater && (
            <Button variant="secondary" fullWidth disabled={saving} onClick={() => leaveForNow('remind')} data-testid="survey-remind">
              {t('survey.invite.remind')}
            </Button>
          )}
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
      {canLeaveForLater && (
        <Button variant="text" fullWidth disabled={saving} onClick={() => later(step)} data-testid="survey-later">
          {t('survey.later')}
        </Button>
      )}
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

type ProgressDocument = React.ComponentProps<typeof ProcessingStatusBar>['document'];

/**
 * The IEP's progress while the parent answers: while it is read, the same
 * step-and-bar the processing screen shows, so the wait they are filling is
 * visibly moving. It never offers the summary: a ready summary is announced
 * as waiting for them, not linked.
 */
const DocumentBanner: React.FC<{ state: ChildDocumentState; name: string; progressDocument: ProgressDocument }> = ({
  state, name, progressDocument,
}) => {
  const { t } = useLanguage();
  const fill = (key: string) => fillName(t(key), name);
  if (state === 'reading') {
    return (
      <section className="page-card survey-reading" aria-labelledby="survey-reading-title" data-testid="survey-banner">
        <h2 id="survey-reading-title" className="survey-reading-title">{fill('survey.banner.readingTitle')}</h2>
        <ProcessingStatusBar
          document={progressDocument}
          stepLabel={t(processingStepKey(progressDocument))}
          stepOfTemplate={t('summary.processing.stepOf')}
          valueTextTemplate={t('summary.processing.stepValueText')}
        />
        <p className="survey-note">{t('survey.banner.readingNote')}</p>
      </section>
    );
  }
  if (state === 'ready') return <Notice tone="success" announce title={fill('survey.banner.ready')} data-testid="survey-banner" />;
  if (state === 'failed') return <Notice tone="warning" announce title={fill('survey.banner.failed')} data-testid="survey-banner" />;
  return null;
};

/** Where the thank-you sends the parent, by what their IEP is doing now. */
const FinishAction: React.FC<{ state: ChildDocumentState; name: string; summaryPath: string; uploadPath?: string }> = ({
  state, name, summaryPath, uploadPath,
}) => {
  const { t } = useLanguage();
  const fill = (key: string) => fillName(t(key), name);
  if (uploadPath) {
    return <Button to={uploadPath} fullWidth data-testid="survey-upload">{fill('survey.thanks.upload')}</Button>;
  }
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
