/**
 * Where a parent is in the survey, decided from what the server holds, never
 * from something a screen remembered: the bottom nav unmounts a page, and a
 * survey that lived in useState would start over every time the parent
 * glanced at Account.
 */
import type { ChildSurvey } from '../../common/types';
import { BaselinePart, baselineParts } from './questions';

export type SurveyStep = 'invite' | BaselinePart | 'thanks' | 'closed';

const FINISHED = new Set(['done', 'declined']);

/** The baseline can still be answered: the summary is unopened and it is not finished. */
export const isBaselineOpen = (survey: ChildSurvey | undefined): boolean =>
  Boolean(survey) && !survey!.summaryFirstViewedAt && !FINISHED.has(survey!.before?.status ?? '');

export const isHouseholdDone = (survey: ChildSurvey | undefined): boolean =>
  survey?.household?.status === 'done';

/** The screen to open on. */
export const initialStep = (survey: ChildSurvey): SurveyStep => {
  const before = survey.before;
  if (before?.status === 'done') return 'thanks';
  if (!isBaselineOpen(survey)) return 'closed';
  if (!before || before.status === 'remind') return 'invite';
  const parts = baselineParts(isHouseholdDone(survey));
  return parts.includes(before.part as BaselinePart) ? (before.part as BaselinePart) : parts[0];
};

/**
 * The follow-up is worth asking only of a parent who gave a baseline to
 * compare it with, and only once.
 */
export const isFollowUpDue = (survey: ChildSurvey | undefined): boolean => {
  if (!survey) return false;
  const gaveBaseline = survey.before?.status === 'done' || survey.before?.status === 'started';
  return gaveBaseline && !FINISHED.has(survey.after?.status ?? '');
};

/** "While you wait" on the processing screen: a parent who has not finished or said no. */
export const isWhileYouWaitDue = (survey: ChildSurvey | undefined): boolean => isBaselineOpen(survey);

/** The family said more children have an IEP than are on the profile. */
export const isNextChildDue = (iepChildCount: number | null | undefined, childrenOnProfile: number): boolean =>
  typeof iepChildCount === 'number' && iepChildCount > childrenOnProfile;
