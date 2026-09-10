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
  'signup flood: someone is abusing the signup form',
  'SMS budget half spent',
  'login codes being requested for numbers we do not serve',
  'login codes are being refused: the sending limit is reached',
  'login codes are not being delivered',
  'the SMS provider is failing to deliver login codes',
];

/**
 * The markers create-auth-challenge logs, and the metric each one feeds.
 *
 * These strings are a contract across two languages: the lambda emits them
 * and a metric filter counts them, and nothing else connects the two. Reword
 * one end and the alarm goes quiet while every test still passes, which is
 * the failure mode this pins shut. The lambda side is pinned in
 * test/lambdas/phone-otp-auth/create-auth-challenge.test.js.
 */
const SMS_MARKERS: [string, string][] = [
  ['SMS_REFUSED_DESTINATION', 'SmsRefusedDestination'],
  ['SMS_BUDGET_EXHAUSTED', 'SmsBudgetExhausted'],
  ['SMS_SEND_FAILED', 'SmsSendFailed'],
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
  ['staging', 'a-iep-alarms-staging', 'a-iep-alerts-staging', 'a-iep-staging '],
  ['production', 'a-iep-alarms', 'a-iep-alerts', 'a-iep '],
])('outage alerting (%s)', (environment, expectedTopicName, expectedAlertTopicName, namePrefix) => {
  let template: Template;
  let alarms: Record<string, any>[];

  beforeAll(() => {
    template = synth(environment);
    alarms = alarmsOf(template);
  }, 180_000);

  test('both topics exist: alarms in, readable alerts out', () => {
    template.hasResourceProperties('AWS::SNS::Topic', { TopicName: expectedTopicName });
    template.hasResourceProperties('AWS::SNS::Topic', { TopicName: expectedAlertTopicName });
  });

  // The formatter is what turns "Threshold Crossed: 1 datapoint [4.0]" into a
  // sentence. If it stops being subscribed, alarms fire into a topic nobody
  // reads and Slack goes quiet during an outage.
  test('the formatter is subscribed to the raw alarm topic', () => {
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'lambda',
      TopicArn: Match.objectLike({ Ref: Match.stringLikeRegexp('.*AlarmTopic.*') }),
    });
  });

  test('the formatter can publish to the alert topic and knows which one', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'handler.lambda_handler',
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          ALERT_TOPIC_ARN: Match.anyValue(),
          ENVIRONMENT: environment === 'production' ? 'prod' : 'dev',
        }),
      }),
    });
  });

  // WHY: a broken formatter breaks every alert while every alarm still fires,
  // which looks exactly like a healthy system. Its own alarm therefore must
  // NOT route through it. Routing it through the formatter would be the
  // canonical alarm that cannot fire.
  test('the alerting-is-broken alarm bypasses the formatter', () => {
    const selfAlarm = alarms.find(
      (a) => a.AlarmName === `${namePrefix}alerting itself is broken`,
    );
    expect(selfAlarm).toBeDefined();

    const alertTopicRefs = Object.entries(template.findResources('AWS::SNS::Topic'))
      .filter(([, r]: [string, any]) => r.Properties.TopicName === expectedAlertTopicName)
      .map(([id]) => id);
    expect(alertTopicRefs).toHaveLength(1);

    // Its action points at the alert topic (Chatbot) directly, not the raw one.
    expect(JSON.stringify(selfAlarm!.AlarmActions)).toContain(alertTopicRefs[0]);
  });

  // Every other alarm goes the long way round, through the formatter, so that
  // the message a person reads is the formatted one.
  test('every other alarm routes through the formatter', () => {
    const rawTopicId = Object.entries(template.findResources('AWS::SNS::Topic'))
      .filter(([, r]: [string, any]) => r.Properties.TopicName === expectedTopicName)
      .map(([id]) => id)[0];

    const routedElsewhere = alarms
      .filter((a) => a.AlarmName !== `${namePrefix}alerting itself is broken`)
      .filter((a) => !JSON.stringify(a.AlarmActions).includes(rawTopicId))
      .map((a) => a.AlarmName);

    expect(routedElsewhere).toEqual([]);
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
  // The description is used verbatim as the impact line, and is also the body
  // of the raw card if the formatter is down. Chatbot truncates around 250
  // characters: 17 of these were once long enough to be cut mid-sentence,
  // losing the most actionable part.
  test('every description is a usable length for Slack', () => {
    for (const alarm of alarms) {
      expect(typeof alarm.AlarmDescription).toBe('string');
      expect(alarm.AlarmDescription.length).toBeGreaterThan(40);
      expect(alarm.AlarmDescription.length).toBeLessThanOrEqual(250);
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

  // Signup volume and SMS spend are the two leading indicators of abuse of
  // the phone-signup flow, and the harm lands on families: once SMS delivery
  // stops, no parent can receive a login code until the month rolls over.
  // Both alarms must exist, and the spend one must sit below the ceiling.
  test('a signup flood is alarmed on, well below the SMS cap', () => {
    const surge = alarms.find(
      (a) => a.AlarmName === `${namePrefix}signup flood: someone is abusing the signup form`,
    );
    expect(surge).toBeDefined();
    expect(surge!.MetricName).toBe('Invocations');
    // Cognito triggers are not retried, so one invocation is one real attempt.
    // Organic signup traffic for this service is a small number per day, so
    // the threshold sits far above it and far below an abuse run.
    expect(surge!.Threshold).toBeLessThanOrEqual(50);
  });

  test('SMS spend alarms below the cap, not at it', () => {
    const spend = alarms.find((a) => a.AlarmName === `${namePrefix}SMS budget half spent`);
    expect(spend).toBeDefined();
    expect(spend!.Namespace).toBe('AWS/SNS');
    expect(spend!.MetricName).toBe('SMSMonthToDateSpentUSD');
    // At the cap login is ALREADY down and stays down until the month rolls
    // over, so an alarm at the cap is an alarm that reports a finished outage.
    expect(spend!.Threshold).toBeLessThan(50);
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

describe('the SMS send path is watched through log markers', () => {
  // Lambda Errors cannot see any of this: create-auth-challenge reports a
  // failed send through the challenge parameter rather than raising, so its
  // error count stays at zero through a total delivery outage.
  test.each(SMS_MARKERS)('%s is counted into %s', (marker, metricName) => {
    for (const environment of ['production', 'staging']) {
      const template = synth(environment);
      template.hasResourceProperties('AWS::Logs::MetricFilter', {
        FilterPattern: marker,
        MetricTransformations: Match.arrayWith([
          Match.objectLike({ MetricName: metricName, MetricNamespace: 'AI-IEP/Auth' }),
        ]),
      });
    }
  });

  test('a single refused destination does not page, a run does', () => {
    const template = synth('production');
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'))
      .map((r: any) => r.Properties)
      .filter((p: any) => String(p.AlarmName).includes('numbers we do not serve'));

    expect(alarms).toHaveLength(1);
    // A parent mistyping a country code is possible; one of those must not
    // wake anyone, and an abuse run produces these in bulk.
    expect(alarms[0].Threshold).toBeGreaterThan(1);
  });

  test('a refused parent or an undelivered code alarms on the first occurrence', () => {
    const template = synth('production');
    const byName = (needle: string) =>
      Object.values(template.findResources('AWS::CloudWatch::Alarm'))
        .map((r: any) => r.Properties)
        .find((p: any) => String(p.AlarmName).includes(needle));

    // Unlike a refused destination, both of these mean a real parent was
    // already turned away, so there is no benign volume to tolerate.
    expect(byName('the sending limit is reached').Threshold).toBe(1);
    expect(byName('are not being delivered').Threshold).toBe(1);
  });
});
