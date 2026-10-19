/**
 * The words of alarms created once per component (one per lambda, one per
 * table). Read the header of alert-copy.ts first.
 */
import { count, dollars, type AlertCopy } from './alert-copy';

// The component labels come from index.ts and new-auth.ts, which are written
// for engineers ("CreateAuthChallenge (sends the SMS code)"). This map says
// them the way a parent or an administrator would. A label with no entry
// fails the synth with the label named, so a new component cannot ship with
// an alert nobody can read.

const PLAIN_NAMES: Readonly<Record<string, string>> = {
  // Document pipeline steps.
  'Mistral OCR': 'text extraction',
  'PII redaction': 'privacy redaction',
  'delete original': 'original-upload deletion',
  'parsing agent': 'summary writing',
  translation: 'translation',
  'finalize results': 'final assembly',
  orchestrator: 'pipeline start',
  // Cognito triggers (the steps Cognito runs during sign-in and sign-up).
  PreSignUp: 'new-account approval',
  DefineAuthChallenge: 'sign-in flow control',
  'CreateAuthChallenge (sends the SMS code)': 'code creation',
  'VerifyAuthChallenge (checks the SMS code)': 'code verification',
  CustomMessage: 'sign-in message',
  PreAuthentication: 'pre-sign-in check',
  'PostConfirmation (secures a new account)': 'new-account security',
  // Other monitored functions, named in the daily health summary.
  signup: 'sign-up',
  'SMS failure attribution': 'SMS failure counting',
  // Sign-in endpoints.
  'auth start': 'sign-in start',
  'auth send': 'code sending',
  'auth verify': 'code checking',
  'auth session': 'session renewal',
  // App request handlers.
  'user profile': 'the account screen',
  upload: 'document upload',
  referrals: 'referrals',
  TTS: 'read-aloud audio',
  'PDF download': 'PDF download',
  'translation request': 'translation requests',
  'pipeline database writes': 'pipeline progress saving',
  // DynamoDB tables.
  'IEP documents': 'IEP documents',
  'user profiles': 'user profiles',
  'login rate limiting': 'login rate limiting',
  'sign-in sessions': 'sign-in sessions',
};

export function plainName(label: string): string {
  const name = PLAIN_NAMES[label];
  if (!name) {
    throw new Error(
      `alert-copy: no plain-language name for the monitored component "${label}". ` +
      'Add it to PLAIN_NAMES so its alerts are readable by someone who did not build it.',
    );
  }
  return name;
}

const SIGN_IN_ENDPOINT = 'Parents cannot get into the app, and the ones already in will be signed out within an hour.';

/** Cognito allows a trigger five seconds; see AUTH_TRIGGER_DURATION_ALARM_THRESHOLD_MS. */
const seconds = (ms: number) => `${Number((ms / 1000).toFixed(1))} seconds`;

export const COMPONENT_COPY = {
  pipelineStep: (label: string): AlertCopy => ({
    severity: 'medium',
    alarmName: `pipeline step failing: ${label}`,
    symptom: `Uploaded documents are failing at the ${plainName(label)} step`,
    impact: 'Parents who upload an IEP see an error instead of a summary, for every document that reaches this step.',
    check: [
      'Open the logs for this pipeline step (the Logs link below) and read the latest error.',
      'If the step calls an outside provider (Mistral, OpenAI, AWS Comprehend or Translate), check its status page.',
    ],
    runbook: 'documents',
    unit: count('error', 'errors'),
  }),
  authTriggerErrors: (label: string): AlertCopy => ({
    severity: 'critical',
    alarmName: `login broken: ${label} trigger failing`,
    symptom: `Sign-in and sign-up are failing at the ${plainName(label)} step`,
    impact: 'Parents cannot sign in or create an account.',
    check: [
      'Open the logs for this sign-in step (the Logs link below) and read the latest error.',
      'Check for a recent deploy and roll back if it lines up.',
    ],
    runbook: 'signInFailing',
    unit: count('error', 'errors'),
    recovery: `Sign-in and sign-up are working again at the ${plainName(label)} step`,
  }),
  authTriggerDuration: (label: string, thresholdMs: number): AlertCopy => ({
    severity: 'critical',
    alarmName: `login slow: ${label} trigger nearing Cognito's 5-second limit`,
    symptom: `Sign-in is running slow at the ${plainName(label)} step`,
    impact: 'Cognito gives up on a sign-in step after 5 seconds, so parents may be turned away even though no error shows.',
    check: [
      'Open the logs for this sign-in step (the Logs link below) and look at the slowest requests.',
      'Check whether a service it depends on (DynamoDB, SNS, SES) is slow.',
    ],
    runbook: 'signInFailing',
    unit: { render: () => `a step taking ${seconds(thresholdMs)} or longer` },
    recovery: `Sign-in speed is back to normal at the ${plainName(label)} step`,
  }),
  apiErrors: (label: string): AlertCopy => ({
    severity: 'medium',
    alarmName: `API handler failing: ${label}`,
    symptom: `Errors in ${plainName(label)}`,
    impact: `Parents using ${plainName(label)} get errors until this clears.`,
    check: [
      'Open the logs for this part of the app (the Logs link below) and read the latest error.',
      'Check for a recent deploy and roll back if it lines up.',
    ],
    runbook: 'api',
    unit: count('error', 'errors'),
  }),
  apiThrottles: (label: string): AlertCopy => ({
    severity: 'medium',
    alarmName: `API handler throttled: ${label}`,
    symptom: `Requests to ${plainName(label)} are being throttled`,
    impact: `Parents using ${plainName(label)} get errors because the function is at its capacity limit, not because of a bug.`,
    check: [
      'Open this function\'s metrics and compare concurrent runs with the account concurrency limit.',
      'If the load is real, raise the limit; if it is a flood, see the abuse steps in the runbook.',
    ],
    runbook: 'api',
    unit: count('throttled request', 'throttled requests'),
  }),
  authEndpointErrors: (label: string): AlertCopy => ({
    severity: 'critical',
    alarmName: `sign-in broken: ${label}`,
    symptom: `Sign-in is failing at the ${plainName(label)} step`,
    impact: SIGN_IN_ENDPOINT,
    check: [
      'Open the logs for this sign-in step (the Logs link below) and read the latest error.',
      'Check for a recent deploy and roll back if it lines up.',
    ],
    runbook: 'signInFailing',
    unit: count('error', 'errors'),
    recovery: `Sign-in is working again at the ${plainName(label)} step`,
  }),
  authEndpointThrottles: (label: string): AlertCopy => ({
    severity: 'critical',
    alarmName: `sign-in throttled: ${label}`,
    symptom: `Sign-in is being throttled at the ${plainName(label)} step`,
    impact: 'Parents are refused before any of our code runs, because this step is at its concurrency cap. This is capacity, not a bug.',
    check: [
      'Open this function\'s metrics and check whether the volume is a flood or real demand.',
      'If it is a flood, see the abuse steps in the runbook; if it is real, raise the reserved concurrency.',
    ],
    runbook: 'signInFailing',
    unit: count('throttled request', 'throttled requests'),
    recovery: `Sign-in is no longer being throttled at the ${plainName(label)} step`,
  }),
  tableThrottle: (label: string): AlertCopy => ({
    severity: 'critical',
    alarmName: `DynamoDB throttling: ${label}`,
    symptom: `The ${plainName(label)} database is throttling requests`,
    impact: 'Parents see random errors rather than a clean outage.',
    check: [
      'Open the table in the DynamoDB console, Monitoring tab, and see which of reads or writes is throttled.',
      'Look for a traffic spike or a runaway script, then see the runbook.',
    ],
    runbook: 'database',
    unit: count('throttled request', 'throttled requests'),
    recovery: `The ${plainName(label)} database is no longer throttling`,
  }),
} as const;

/** The near-cap alarm's name carries the percentage, so it is built at synth from the constants. */
export function smsSpendNearCap(percent: number): AlertCopy {
  return {
    severity: 'medium',
    alarmName: `SMS spend is past ${percent}% of the monthly cap`,
    symptom: 'SMS spending is close to the monthly cap',
    impact: 'No one yet. At the cap, no parent can receive a sign-in code until the month rolls over.',
    check: [
      'Check whether this month\'s signups explain the spend, or whether it is abuse (see the runbook).',
      'Decide whether to raise the SNS monthly spend limit before the cap is hit.',
    ],
    runbook: 'smsSpend',
    unit: { render: ({ threshold }) => `month-to-date SMS spend above ${dollars(threshold)}` },
    accountWide: true,
  };
}
