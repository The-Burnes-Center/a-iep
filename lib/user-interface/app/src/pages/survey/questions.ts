/**
 * The survey's questions: the app's copy of
 * lib/chatbot-api/functions/user-profile-handler/survey_schema.json, which the
 * server validates every save against. questions.test.ts fails if the two
 * differ, so an answer offered here is always one the server accepts.
 *
 * The wording is in the dictionaries (survey.q.<key>), with {name} for the
 * child. It is the onboarding prototype's, and a placeholder until the
 * research team signs it off.
 */
import type { SurveyAnswers } from '../../common/types';

export const SCALE = ['disagree', 'somewhat_disagree', 'somewhat_agree', 'agree', 'unsure'] as const;
const YES_NO = ['yes', 'no'] as const;
const YES_NO_UNSURE = ['yes', 'no', 'unsure'] as const;

type Choice = 'scale' | readonly string[];

interface PhaseQuestions {
  parts: readonly string[];
  statuses: readonly string[];
  choice: Record<string, Choice>;
  multi: Record<string, readonly string[]>;
  text: Record<string, number>;
  email?: readonly string[];
}

export const QUESTIONS = {
  before: {
    // 'you' is where the walk stands while the household questions are open.
    parts: ['about', 'understand', 'speak', 'reflect', 'you'],
    statuses: ['remind', 'started', 'declined', 'done'],
    choice: {
      k12: YES_NO,
      englishLearner: YES_NO_UNSURE,
      homeLanguageCopy: YES_NO_UNSURE,
      u1: 'scale', u2: 'scale', u3: 'scale', u4: 'scale', u5: 'scale', u6: 'scale',
      p1: 'scale', p2: 'scale', p3: 'scale', p4: 'scale', p5: 'scale',
      r1: 'scale', r2: 'scale',
    },
    multi: {
      reflectParts: ['presentLevels', 'eligibility', 'goals', 'services', 'accommodations', 'placement', 'other'],
    },
    // Sized so a whole phase, in a 3-byte-per-character script, still fits
    // in one KMS Encrypt call (4096 bytes): see survey.py ANSWERS_MAX_BYTES.
    text: { speakWhy: 500, reflectOther: 500 },
  },
  after: {
    parts: ['followUp'],
    statuses: ['started', 'declined', 'done'],
    choice: { u3: 'scale', u4: 'scale', p1: 'scale', p5: 'scale' },
    multi: {},
    text: { anythingElse: 1000 },
  },
  household: {
    parts: ['you'],
    statuses: ['started', 'done'],
    choice: {
      aiUse: ['daily', 'weekly', 'monthly', 'tried', 'never'],
      stayInTouch: YES_NO,
    },
    multi: {},
    text: { aiTools: 200 },
    email: ['email'],
  },
} as const satisfies Record<'before' | 'after' | 'household', PhaseQuestions>;

/** The screens of the baseline, in order. 'you' is the household's, asked once. */
export type BaselinePart = 'about' | 'understand' | 'speak' | 'reflect' | 'you';
export const CHILD_PARTS: BaselinePart[] = ['about', 'understand', 'speak', 'reflect'];

/** The statements each screen shows, on the agreement scale. */
export const UNDERSTAND_KEYS = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'] as const;
export const SPEAK_KEYS = ['p1', 'p2', 'p3', 'p4', 'p5'] as const;
export const REFLECT_KEYS = ['r1', 'r2'] as const;
/** Repeated word for word after the summary, so the change can be measured. */
export const FOLLOW_UP_KEYS = ['u3', 'u4', 'p1', 'p5'] as const;
/** Statements with a one-line plain explanation under them. */
export const HELP_KEYS: readonly string[] = ['u5', 'u6'];

export const optionsFor = (choice: Choice): readonly string[] => (choice === 'scale' ? SCALE : choice);

const DISAGREE = new Set(['disagree', 'somewhat_disagree']);
/** Any of these statements answered on the disagree side: show the follow-up box. */
export const anyDisagree = (answers: SurveyAnswers, keys: readonly string[]): boolean =>
  keys.some((key) => DISAGREE.has(answers[key] as string));

/** The parts a parent walks, given whether the household questions are done. */
export const baselineParts = (householdDone: boolean): BaselinePart[] =>
  householdDone ? CHILD_PARTS : [...CHILD_PARTS, 'you'];

/** Answers with the follow-up boxes dropped once nothing calls for them. */
export const pruneBaseline = (answers: SurveyAnswers): SurveyAnswers => {
  const kept = { ...answers };
  if (!anyDisagree(kept, SPEAK_KEYS)) delete kept.speakWhy;
  if (!anyDisagree(kept, REFLECT_KEYS)) {
    delete kept.reflectParts;
    delete kept.reflectOther;
  }
  const parts = kept.reflectParts;
  if (!Array.isArray(parts) || !parts.includes('other')) delete kept.reflectOther;
  if (Array.isArray(parts) && parts.length === 0) delete kept.reflectParts;
  return kept;
};

export const pruneHousehold = (answers: SurveyAnswers): SurveyAnswers => {
  const kept = { ...answers };
  if (kept.stayInTouch !== 'yes') delete kept.email;
  if (typeof kept.email === 'string' && !kept.email.trim()) delete kept.email;
  return kept;
};

/** Whole answers trimmed of empty strings, so a cleared box is not saved as "". */
export const withoutBlanks = (answers: SurveyAnswers): SurveyAnswers =>
  Object.fromEntries(Object.entries(answers).filter(([, value]) => value !== '' && value !== undefined));

/** A loose shape check, the same one the server applies. */
export const looksLikeEmail = (value: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());
