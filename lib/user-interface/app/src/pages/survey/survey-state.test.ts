import { describe, expect, test } from 'vitest';
import type { ChildSurvey, SurveyRecord } from '../../common/types';
import { initialStep, isBaselineOpen, isFollowUpDue, isNextChildDue } from './survey-state';

const record = (status: string, part?: string): SurveyRecord =>
  ({ version: 1, status, part, answers: {}, startedAt: 1, updatedAt: 1 });
const survey = (over: Partial<ChildSurvey> = {}): ChildSurvey => ({
  version: 1, before: null, after: null, household: null, summaryFirstViewedAt: null, iepChildCount: null, ...over,
});

describe('where the survey opens', () => {
  test('nothing saved, or a reminder, opens on the invite', () => {
    expect(initialStep(survey())).toBe('invite');
    expect(initialStep(survey({ before: record('remind') }))).toBe('invite');
  });

  test('a started survey resumes on its saved part', () => {
    expect(initialStep(survey({ before: record('started', 'speak') }))).toBe('speak');
  });

  test('the household part is skipped once answered, even if saved there', () => {
    expect(initialStep(survey({ before: record('started', 'you') }))).toBe('you');
    expect(initialStep(survey({ before: record('started', 'you'), household: record('done') }))).toBe('about');
  });

  test('a finished survey opens on the thank-you', () => {
    expect(initialStep(survey({ before: record('done') }))).toBe('thanks');
  });

  test('opening the summary closes the baseline, however far it got', () => {
    const viewed = { summaryFirstViewedAt: 5 };
    expect(isBaselineOpen(survey(viewed))).toBe(false);
    expect(initialStep(survey({ ...viewed, before: record('started', 'speak') }))).toBe('closed');
    expect(initialStep(survey({ before: record('declined') }))).toBe('closed');
  });
});

describe('the cards on the summary', () => {
  test('the follow-up is due only after a baseline, and only once', () => {
    expect(isFollowUpDue(survey())).toBe(false);
    expect(isFollowUpDue(survey({ before: record('declined') }))).toBe(false);
    expect(isFollowUpDue(survey({ before: record('started', 'speak') }))).toBe(true);
    expect(isFollowUpDue(survey({ before: record('done'), after: record('done') }))).toBe(false);
    expect(isFollowUpDue(survey({ before: record('done'), after: record('declined') }))).toBe(false);
  });

  test('the next child is due while fewer children are on the profile than the family said', () => {
    expect(isNextChildDue(null, 1)).toBe(false);
    expect(isNextChildDue(1, 1)).toBe(false);
    expect(isNextChildDue(3, 2)).toBe(true);
  });
});
