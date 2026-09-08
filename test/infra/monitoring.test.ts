/**
 * CDK assertions for outage alerting (lib/chatbot-api/monitoring/monitoring.ts).
 *
 * Alerting has a failure mode the thing it watches does not: an alarm that
 * cannot fire is indistinguishable from a system that never breaks. Every
 * assertion here pins a property whose silent loss would leave Slack quiet
 * during an outage, which is worse than having no alarms at all because it
 * looks like coverage.
 *
 * The two that matter most:
 *
 *   - The sweep heartbeat must stay treatMissingData: BREACHING. A stopped
 *     EventBridge rule emits no datapoints, so the CloudWatch default
 *     (MISSING) renders a dead schedule as healthy. That is the exact failure
 *     the heartbeat exists to catch.
 *   - There must be NO alarm on the pipeline's ExecutionsFailed. Every Task in
 *     iep-processing.asl.json catches into RecordFailure, which ends the
 *     machine normally, so a failed document produces a SUCCESSFUL execution
 *     and that metric stays at zero through a total outage. An alarm on it
 *     would be pure theatre, and a future change adding one should fail here.
 *
 * Synthesizes staging once, then production once, because the alarm and topic
 * names are environment-derived and prod is the one that pages a human.
 */
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

/** Every alarm the construct is expected to create, by name suffix. */
const EXPECTED_ALARM_SUFFIXES = [
  'document pipeline failing',
  'document stuck: pipeline execution timed out',
  'pending-upload sweep has stopped running',
  'pending-upload sweep failing to invoke',
  'API returning 5xx',
  'pipeline step failing: Mistral OCR',
  'pipeline step failing: PII redaction',
  'pipeline step failing: parsing agent',
  'pipeline step failing: translation',
  'pipeline step failing: finalize results',
  'login broken: PreSignUp trigger failing',
  'login broken: DefineAuthChallenge trigger failing',
  'login broken: CreateAuthChallenge (sends the SMS code) trigger failing',
  'login broken: VerifyAuthChallenge (checks the SMS code) trigger failing',
  'DynamoDB throttling: IEP documents',
  'DynamoDB throttling: user profiles',
];

function synth(environment: string): Template {
  const saved = process.env.ENVIRONMENT;
  process.env.ENVIRONMENT = environment;
  process.env.JSII_DEPRECATED = 'quiet';
  try {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { GenAiMvpStack } = require('../../lib/gen-ai-mvp-stack');
    const { stackName } = require('../../lib/constants');
    /* eslint-enable @typescript-eslint/no-var-requires */
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    return Template.fromStack(new GenAiMvpStack(app, stackName, {}));
  } finally {
    process.env.ENVIRONMENT = saved;
  }
}

/** All alarms in the template as plain property objects. */
function alarmsOf(template: Template): Record<string, any>[] {
  return Object.values(template.findResources('AWS::CloudWatch::Alarm')).map(
    (r: any) => r.Properties,
  );
}

describe.each([
  ['staging', 'a-iep-alarms-staging', 'a-iep-staging '],
  ['production', 'a-iep-alarms', 'a-iep '],
])('outage alerting (%s)', (environment, expectedTopicName, namePrefix) => {
  let template: Template;
  let alarms: Record<string, any>[];

  beforeAll(() => {
    template = synth(environment);
    alarms = alarmsOf(template);
  }, 180_000);

  test('an alarm topic exists for AWS Chatbot to subscribe to', () => {
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: expectedTopicName,
    });
  });

  test('every expected alarm exists', () => {
    const names = alarms.map((a) => a.AlarmName);
    for (const suffix of EXPECTED_ALARM_SUFFIXES) {
      expect(names).toContain(`${namePrefix}${suffix}`);
    }
  });

  // An alarm with no action is the classic dead check: it goes red on a
  // dashboard nobody opens and never reaches Slack.
  test('every alarm notifies the topic, on both alarm and recovery', () => {
    expect(alarms.length).toBeGreaterThan(0);
    for (const alarm of alarms) {
      expect(alarm.AlarmActions).toBeDefined();
      expect(alarm.AlarmActions).toHaveLength(1);
      // Recovery too: otherwise Slack shows an outage beginning and never ending.
      expect(alarm.OKActions).toHaveLength(1);
    }
  });

  // AWS Chatbot renders AlarmDescription in its Slack card and nothing else
  // here carries context, so an empty description ships an alert that says
  // only that a metric moved.
  test('every alarm carries a description for the Slack card', () => {
    for (const alarm of alarms) {
      expect(typeof alarm.AlarmDescription).toBe('string');
      expect(alarm.AlarmDescription.length).toBeGreaterThan(80);
    }
  });

  test('the sweep heartbeat breaches on missing data, not on a low count alone', () => {
    const heartbeat = alarms.find(
      (a) => a.AlarmName === `${namePrefix}pending-upload sweep has stopped running`,
    );
    expect(heartbeat).toBeDefined();
    // BREACHING is the whole point of this alarm: a stopped rule emits no
    // datapoints at all, and the default MISSING would read as healthy.
    expect(heartbeat!.TreatMissingData).toBe('breaching');
    expect(heartbeat!.ComparisonOperator).toBe('LessThanThreshold');
    expect(heartbeat!.Threshold).toBe(1);
  });

  test('no alarm watches the pipeline ExecutionsFailed metric, which cannot move', () => {
    const failedExecutionAlarms = alarms.filter((a) => a.MetricName === 'ExecutionsFailed');
    expect(failedExecutionAlarms).toEqual([]);
    // The real signal for a stuck document is the timeout, which RecordFailure
    // does NOT catch.
    expect(alarms.some((a) => a.MetricName === 'ExecutionsTimedOut')).toBe(true);
  });

  test('document failures are counted from the record_failure log marker', () => {
    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: 'RECORD_FAILURE',
      MetricTransformations: Match.arrayWith([
        Match.objectLike({
          MetricName: 'DocumentFailures',
          MetricNamespace: 'AI-IEP/Pipeline',
        }),
      ]),
    });
  });

  // A single legitimately-unreadable scan must not page anyone: production has
  // run roughly 5.5% lifetime failures, so the threshold is a rate.
  test('the document-failure alarm needs several failures, not one', () => {
    const alarm = alarms.find(
      (a) => a.AlarmName === `${namePrefix}document pipeline failing`,
    );
    expect(alarm!.Threshold).toBeGreaterThanOrEqual(3);
    expect(alarm!.MetricName).toBe('DocumentFailures');
  });

  // WHY, measured on staging: every pipeline Task retries with MaxAttempts 3,
  // so ONE failing document invokes its step lambda 4 times and records 4
  // Errors. A deliberate failing execution produced exactly 4 datapoints and
  // tripped the original threshold of 2, i.e. a single unreadable PDF from a
  // single parent would have paged the channel as though the stage were down.
  // Raising the retry count without raising this reintroduces that, so the
  // relationship is pinned rather than the number alone.
  test('a single failing document cannot trip a pipeline step alarm', () => {
    const stepAlarms = alarms.filter((a) =>
      String(a.AlarmName).startsWith(`${namePrefix}pipeline step failing:`),
    );
    expect(stepAlarms.length).toBeGreaterThanOrEqual(7);
    for (const alarm of stepAlarms) {
      expect(alarm.MetricName).toBe('Errors');
      // 4 invocations is one document's retries; the alarm must need more.
      expect(alarm.Threshold).toBeGreaterThan(4);
    }
  });

  // Every Cognito trigger gets its own alarm: an error in any of them locks
  // families out, and phone signup has already been silently dead for a month
  // once (2026-07).
  test('all six custom-auth triggers are alarmed at a threshold of one error', () => {
    const authAlarms = alarms.filter((a) =>
      String(a.AlarmName).startsWith(`${namePrefix}login broken:`),
    );
    expect(authAlarms).toHaveLength(6);
    for (const alarm of authAlarms) {
      expect(alarm.Threshold).toBe(1);
      expect(alarm.MetricName).toBe('Errors');
    }
  });
});
