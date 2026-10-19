/**
 * The words of every A-IEP alarm, in one reviewable place.
 *
 * This file defines the format and how it is rendered. The words themselves
 * are in two sibling files: `alert-copy-table.ts` (one entry per alarm) and
 * `alert-copy-components.ts` (alarms made once per lambda or table).
 *
 * What a person reads in Slack is built from three things: the alarm's
 * description (this file), the alert formatter lambda that lays it out, and
 * the runbook it links to (docs/RUNBOOK.md). Nothing else carries wording, so
 * changing how an alert reads is an edit to this file and nowhere else.
 *
 * ## The format
 *
 * Every alarm description is written by `renderAlarmDescription` and looks like
 * this (the alert formatter parses exactly this shape, and
 * `test/python/test_alert_formatter.py` runs the real descriptions through it):
 *
 *     [PROD] [CRITICAL] Sign-in codes are not being sent
 *     Impact: Parents ask for a sign-in code and none goes out.
 *     Fires when: at least 3 failed code sends in 5 minutes.
 *     Check first:
 *     1. Open the sign-in code logs and search for AUTH_DISPATCH_FAILED.
 *     2. Check whether the SMS or email provider has an incident.
 *     Runbook: https://github.com/.../docs/RUNBOOK.md#sign-in-codes-are-not-arriving
 *     Recovery: Sign-in codes are being sent again
 *
 * Environment and severity come first and are words, not colours, so the
 * message is legible in a push notification, a screen reader and a plain-text
 * export. Staging is capped at WARNING and says so: nobody should have to open
 * an alert to learn whether real families are affected.
 *
 * ## Rules for writing an entry
 *
 * - **Symptom, not cause.** "Sign-in codes are not being sent", never
 *   "AUTH_DISPATCH_FAILED over threshold". Say what a person would notice.
 * - **Impact names who.** Parents, administrators, or "no one yet".
 * - **Check first is one or two concrete steps.** Where to look, and what for.
 * - **No internal ids.** No CloudFormation logical ids, no generated function
 *   names, no tokens. `test/infra/monitoring.test.ts` fails the build if one
 *   appears.
 * - **Plain words.** Say "sign-in code", not "OTP challenge".
 * - **`recovery` is required for CRITICAL alarms**, because only those post a
 *   resolution to Slack. It states what is true now, not what was wrong.
 *
 * ## Why alarm names are not here
 *
 * `alarmName` is unchanged from before this file existed, on purpose. A
 * CloudWatch alarm's name is its identity: renaming one makes CloudFormation
 * replace it, for all ~200 alarms in both stacks at once, each reborn in
 * INSUFFICIENT_DATA. Nothing durable is attached to an alarm, but the churn
 * buys nothing, since Slack never shows the name any more: the headline comes
 * from the description. Tests also look alarms up by name.
 */

import type * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';

/**
 * How urgent an alarm is.
 *
 * - `critical`: families cannot use the service right now. Shown as CRITICAL
 *               in prod, WARNING in staging.
 * - `medium`:   degraded, or heading for critical if left. WARNING.
 * - `low`:      worth knowing, nothing is broken. INFO.
 *
 * Assigned per alarm rather than derived, because urgency is a judgement about
 * what a parent experiences and no metric carries it.
 */
export type Severity = 'critical' | 'medium' | 'low';

export type EnvironmentLabel = 'prod' | 'dev';

/** The words shown in Slack. Staging never reads as CRITICAL. */
export function severityLabel(severity: Severity, environment: EnvironmentLabel): string {
  if (severity === 'low') return 'INFO';
  if (severity === 'medium') return 'WARNING';
  return environment === 'prod' ? 'CRITICAL' : 'WARNING';
}

export function environmentLabel(environment: EnvironmentLabel): string {
  return environment === 'prod' ? 'PROD' : 'STAGING';
}

/** The runbook section an alert links to. Each is a `##` heading in docs/RUNBOOK.md. */
export const RUNBOOK_SECTIONS = {
  signInCodes: 'sign-in-codes-are-not-arriving',
  signInFailing: 'sign-in-is-failing-or-slow',
  smsSpend: 'sms-spend-and-the-monthly-cap',
  signup: 'sign-up-is-failing',
  abuse: 'suspected-abuse',
  api: 'the-app-is-returning-errors',
  documents: 'documents-are-failing-to-process',
  privacy: 'student-records-were-not-removed',
  database: 'database-throttling',
  email: 'email-sending-reputation',
  alerting: 'the-alerting-itself-is-broken',
  awsUsage: 'unusual-aws-api-volume',
} as const;

export type RunbookKey = keyof typeof RUNBOOK_SECTIONS;

/** Where the runbook lives. Staging links its own branch so a link is never dead before a promotion. */
export function runbookUrl(environment: EnvironmentLabel, key: RunbookKey): string {
  const branch = environment === 'prod' ? 'main' : 'staging';
  return `https://github.com/The-Burnes-Center/a-iep/blob/${branch}/docs/RUNBOOK.md#${RUNBOOK_SECTIONS[key]}`;
}

/** What an alarm looks at, handed to `Unit.render` so the threshold can be said in words. */
export interface ConditionInput {
  readonly threshold: number;
  readonly periodSeconds: number;
  readonly evaluationPeriods: number;
  readonly datapointsToAlarm?: number;
  readonly comparison: 'gte' | 'gt' | 'lt' | 'lte';
}

/** How an alarm's threshold is said in words: a counted noun, or a custom sentence. */
export type Unit =
  | { readonly one: string; readonly many: string }
  | { readonly render: (input: ConditionInput) => string };

export interface AlertCopy {
  readonly severity: Severity;
  /** The existing CloudWatch alarm name, without the `a-iep` prefix. Do not edit: see the file header. */
  readonly alarmName: string;
  /** The Slack headline: what is wrong, in the present tense, no trailing full stop. */
  readonly symptom: string;
  /** Who is affected and how. Starts with the group: parents, administrators, or no one. */
  readonly impact: string;
  /** One or two concrete first steps. */
  readonly check: readonly string[];
  readonly runbook: RunbookKey;
  readonly unit: Unit;
  /**
   * What is true once it clears, for CRITICAL alarms ("Sign-in codes are being
   * sent again"). Absent on the rest, which post no resolution.
   */
  readonly recovery?: string;
  /**
   * The alarm counts discrete failures, so it clears when they stop arriving,
   * not when something is fixed. Its Slack resolution says "no new failures"
   * rather than claiming a cause was repaired.
   */
  readonly countsFailures?: boolean;
  /** Reads an account-level metric, so a staging alarm still describes production. */
  readonly accountWide?: boolean;
}

// ── Saying the threshold in words ───────────────────────────────────────

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60);
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  }
  const hours = Math.round(seconds / 3600);
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

/** A counted noun, for `Fires when: at least 3 failed sends in 5 minutes`. */
export const count = (one: string, many: string): Unit => ({ one, many });

/** "at least 3 failed code sends in 5 minutes". */
export function describeCondition(unit: Unit, input: ConditionInput): string {
  if ('render' in unit) return unit.render(input);
  const span = formatDuration(input.periodSeconds * input.evaluationPeriods);
  const noun = input.threshold === 1 ? unit.one : unit.many;
  return `at least ${input.threshold} ${noun} in ${span}`;
}

export const percent = (fraction: number) => Number((fraction * 100).toFixed(3));
export const dollars = (value: number) => `$${Number.isInteger(value) ? value : value.toFixed(2)}`;

// ── Rendering ───────────────────────────────────────────────────────────

/** CloudFormation caps an alarm description at 1024 characters. */
export const ALARM_DESCRIPTION_MAX = 1024;

/**
 * The description CloudWatch carries into the SNS payload, and so the one
 * field the alert formatter can read. See the file header for the shape.
 */
export function renderAlarmDescription(
  environment: EnvironmentLabel,
  copy: AlertCopy,
  condition: ConditionInput,
): string {
  const staging = environment !== 'prod';
  const impact = !staging
    ? copy.impact
    : copy.accountWide
      ? 'This reads an account-wide signal, so production is affected too.'
      : 'Staging only. No real families are affected.';

  const lines = [
    `[${environmentLabel(environment)}] [${severityLabel(copy.severity, environment)}] ${copy.symptom}`,
    `Impact: ${impact}`,
    `Fires when: ${describeCondition(copy.unit, condition)}.`,
    'Check first:',
    ...copy.check.map((step, index) => `${index + 1}. ${step}`),
    `Runbook: ${runbookUrl(environment, copy.runbook)}`,
  ];
  if (copy.countsFailures) {
    lines.push('Recovery: quiet');
  } else if (copy.recovery) {
    lines.push(`Recovery: ${copy.recovery}`);
  }
  const description = lines.join('\n');
  if (description.length > ALARM_DESCRIPTION_MAX) {
    throw new Error(
      `alert-copy: the description for "${copy.alarmName}" is ${description.length} characters; ` +
      `CloudFormation allows ${ALARM_DESCRIPTION_MAX}. Shorten its check steps or impact.`,
    );
  }
  return description;
}

/** What an alarm helper hands over so the description can state the real threshold. */
export interface AlarmThreshold {
  readonly metric: cloudwatch.IMetric;
  readonly threshold: number;
  readonly evaluationPeriods: number;
  readonly datapointsToAlarm?: number;
  readonly comparisonOperator?: cloudwatch.ComparisonOperator;
}

const COMPARISONS: Readonly<Record<string, ConditionInput['comparison']>> = {
  GreaterThanOrEqualToThreshold: 'gte',
  GreaterThanThreshold: 'gt',
  LessThanThreshold: 'lt',
  LessThanOrEqualToThreshold: 'lte',
};

/**
 * The description for one alarm, with the threshold, window and operator read
 * from the alarm itself so the words cannot disagree with the alarm.
 */
export function renderAlarmDescriptionFor(
  environment: EnvironmentLabel,
  copy: AlertCopy,
  alarm: AlarmThreshold,
): string {
  const config = alarm.metric.toMetricConfig();
  const period = config.metricStat?.period.toSeconds() ?? config.mathExpression?.period ?? 300;
  return renderAlarmDescription(environment, copy, {
    threshold: alarm.threshold,
    periodSeconds: period,
    evaluationPeriods: alarm.evaluationPeriods,
    datapointsToAlarm: alarm.datapointsToAlarm,
    comparison: COMPARISONS[alarm.comparisonOperator ?? 'GreaterThanOrEqualToThreshold'] ?? 'gte',
  });
}
