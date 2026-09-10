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
  'the SMS provider is rejecting login codes',
  'the pipeline cannot write to its database',
  // The signup endpoint. It is the ONLY way to create an account, because
  // Cognito's public SignUp API is closed, and for its first day it had no
  // alarm of any kind: not in pipelineFunctions, not in authTriggerFunctions,
  // not in apiFunctions, no metric filter on any of its markers.
  'signup broken: nobody can create an account',
  'signup throttled: nobody can create an account',
  'sign-ups are being refused in bulk',
  'signup broken: accounts are not being created',
  'new accounts may be reachable by whoever created them',
  'the signup bot check is switched off',
  // The alerting path watching itself, both halves of it.
  'alerts are not reaching the formatter',
  'the daily health brief is failing',
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

/**
 * The same contract, for the signup endpoint.
 *
 * Nearly every way that function turns a family away is a deliberate 4xx
 * refusal that raises nothing, so Lambda Errors stays flat through a total
 * signup outage and these markers are the only signal there is. The lambda
 * side is pinned in test/lambdas/phone-otp-auth/signup-endpoint.test.js.
 */
const SIGNUP_MARKERS: [string, string][] = [
  ['SIGNUP_REFUSED', 'SignupRefused'],
  ['SIGNUP_FAILED', 'SignupFailed'],
  ['SIGNUP_ORPHANED', 'SignupOrphaned'],
  ['TURNSTILE_NOT_CONFIGURED', 'TurnstileNotConfigured'],
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
  // which looks exactly like a healthy system. Its own alarms therefore must
  // NOT route through it. Routing them through the formatter would be the
  // canonical alarm that cannot fire.
  //
  // There are two, because "the formatter ran and raised" and "the formatter
  // was never invoked" are different failures with no overlap. The second was
  // added after an audit found nothing at all watched SNS delivery from the
  // alarm topic to the formatter: subscription deleted, invoke permission
  // lost, or SNS giving up retrying would each drop every alert silently,
  // with the formatter's own Errors flat at zero.
  test.each([
    'alerting itself is broken',
    'alerts are not reaching the formatter',
  ])('the "%s" alarm bypasses the formatter', (name) => {
    const selfAlarm = alarms.find((a) => a.AlarmName === `${namePrefix}${name}`);
    expect(selfAlarm).toBeDefined();

    const alertTopicRefs = Object.entries(template.findResources('AWS::SNS::Topic'))
      .filter(([, r]: [string, any]) => r.Properties.TopicName === expectedAlertTopicName)
      .map(([id]) => id);
    expect(alertTopicRefs).toHaveLength(1);

    // Its action points at the alert topic (Chatbot) directly, not the raw one.
    expect(JSON.stringify(selfAlarm!.AlarmActions)).toContain(alertTopicRefs[0]);

    // But its RECOVERY goes back through the formatter, and the asymmetry is
    // deliberate. When this fires the formatter cannot be trusted, so the
    // alert takes the direct route; when it clears the formatter is by
    // definition working, so the recovery can be formatted -- and the
    // formatter's coming-online suppression applies. Without that, first
    // deploy posts a raw card reading "1 datapoint [0.0] was not greater than
    // or equal to the threshold (1.0)" under a green tick, which tells a
    // reader nothing and trains them to skim the channel.
    const rawTopicId = Object.entries(template.findResources('AWS::SNS::Topic'))
      .filter(([, r]: [string, any]) => r.Properties.TopicName === expectedTopicName)
      .map(([id]) => id)[0];
    expect(JSON.stringify(selfAlarm!.OKActions)).toContain(rawTopicId);
  });

  // Every other alarm goes the long way round, through the formatter, so that
  // the message a person reads is the formatted one.
  test('every other alarm routes through the formatter', () => {
    const rawTopicId = Object.entries(template.findResources('AWS::SNS::Topic'))
      .filter(([, r]: [string, any]) => r.Properties.TopicName === expectedTopicName)
      .map(([id]) => id)[0];

    const bypassByDesign = [
      `${namePrefix}alerting itself is broken`,
      `${namePrefix}alerts are not reaching the formatter`,
    ];
    const routedElsewhere = alarms
      .filter((a) => !bypassByDesign.includes(a.AlarmName))
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

  // Scoped to the pipeline, not to the metric. Every pipeline state catches
  // into RecordFailure and the machine then ends successfully, so
  // ExecutionsFailed can never move there and an alarm on it would be one
  // that cannot fire. The single-language translation machine is different:
  // it ends in a Fail state, so the same metric is the correct signal. Which
  // machine it is, is the whole distinction.
  test('the pipeline is not alarmed on ExecutionsFailed, which cannot move for it', () => {
    const pipelineFailed = alarms.filter(
      (a) =>
        a.MetricName === 'ExecutionsFailed' &&
        JSON.stringify(a.Dimensions ?? []).includes('IEPProcessing'),
    );
    expect(pipelineFailed).toEqual([]);
    // The real signal for a stuck document is the timeout, which RecordFailure
    // does NOT catch.
    expect(alarms.some((a) => a.MetricName === 'ExecutionsTimedOut')).toBe(true);
  });

  // ...and the translation machine IS alarmed on it, because there the
  // executions really do fail.
  test('the translation machine is alarmed on ExecutionsFailed, which does move for it', () => {
    const translationFailed = alarms.filter(
      (a) =>
        a.MetricName === 'ExecutionsFailed' &&
        JSON.stringify(a.Dimensions ?? []).includes('Translation'),
    );
    expect(translationFailed).toHaveLength(1);
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
  // Seven, not six: PostConfirmation joined the set. It rotates a phone
  // signup's client-chosen password, which is the only thing that makes
  // auto-confirming a signup safe, and on failure it disables the account
  // instead. Either outcome costs a parent their account, so it is alarmed
  // like the rest of the login path rather than as an ordinary API lambda.
  test('all seven custom-auth triggers are alarmed at a threshold of one error', () => {
    const authAlarms = alarms.filter((a) =>
      String(a.AlarmName).startsWith(`${namePrefix}login broken:`),
    );
    expect(authAlarms).toHaveLength(7);
    for (const alarm of authAlarms) {
      expect(alarm.Threshold).toBe(1);
      expect(alarm.MetricName).toBe('Errors');
    }
  });
});

describe('the signup endpoint is watched at all', () => {
  // It is the only way to create an account, and for its first day it was in
  // none of the three monitoring lists: no Errors alarm, no Throttles alarm,
  // no metric filter on any of its six markers. This describe block exists so
  // that a future change dropping it from the list fails here.
  test.each(SIGNUP_MARKERS)('%s is counted into %s', (marker, metricName) => {
    for (const environment of ['production', 'staging']) {
      synth(environment).hasResourceProperties('AWS::Logs::MetricFilter', {
        FilterPattern: marker,
        MetricTransformations: Match.arrayWith([
          Match.objectLike({ MetricName: metricName, MetricNamespace: 'AI-IEP/Auth' }),
        ]),
      });
    }
  });

  // An account created but not secured is reachable by whoever created it,
  // which is the hole the PostConfirmation rotation closed for the ~1,030
  // accounts of the 2026-09-09 run. One is enough.
  test('one unsecured account is enough to alarm', () => {
    const alarm = Object.values(synth('production').findResources('AWS::CloudWatch::Alarm'))
      .map((r: any) => r.Properties)
      .find((p: any) => String(p.AlarmName).includes('reachable by whoever created them'));

    expect(alarm).toBeDefined();
    expect(alarm.Threshold).toBe(1);
  });

  // The endpoint is in the daily brief too, so a day with zero signups is
  // visible rather than merely un-alarmed.
  test('the endpoint reaches the daily brief', () => {
    const manifest = JSON.stringify(
      synth('production').findResources('AWS::SSM::Parameter'));

    expect(manifest).toContain('the only way to create an account');
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

describe('the daily brief', () => {
  // Alarms answer "did something break". They cannot answer "is anything
  // still happening", and a component that stops being invoked raises no
  // errors, so every alarm stays green while nothing works. The brief is
  // what makes silence from this system mean something.
  test('it runs once a day, on a schedule', () => {
    for (const environment of ['production', 'staging']) {
      const template = synth(environment);
      template.hasResourceProperties('AWS::Events::Rule', Match.objectLike({
        ScheduleExpression: 'cron(0 13 * * ? *)',
        State: 'ENABLED',
      }));
    }
  });

  test('it can read metrics and alarm state, and change neither', () => {
    const template = synth('production');
    const statements = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement as any[]);
    const briefStatements = statements.filter((st) =>
      JSON.stringify(st.Action).includes('cloudwatch:GetMetricData'),
    );
    expect(briefStatements.length).toBeGreaterThan(0);

    for (const st of briefStatements) {
      const actions = ([] as string[]).concat(st.Action);
      // Read-only. It reports on alarms; it must never be able to silence one.
      expect(actions.every((a) => a === 'cloudwatch:GetMetricData'
        || a === 'cloudwatch:DescribeAlarms')).toBe(true);
    }
  });

  // The manifest lives in Parameter Store, not an environment variable:
  // Lambda caps all environment variables at 4KB combined and this one
  // measured past it, taking a staging deploy down after CI went green.
  test('every monitored component reaches the brief with a purpose', () => {
    const template = synth('production');
    const parameters = Object.values(template.findResources('AWS::SSM::Parameter'))
      .map((r: any) => r.Properties)
      .filter((p: any) => String(p.Name ?? '').includes('daily-brief'));
    expect(parameters).toHaveLength(1);

    // The manifest embeds function-name tokens, so it synthesizes as an
    // Fn::Join. Rebuilding it with the tokens replaced by a placeholder
    // checks the property that matters: that what the lambda reads at
    // runtime is well-formed JSON, tokens and all.
    const raw = parameters[0].Value;
    const joined = typeof raw === 'string'
      ? raw
      : (raw['Fn::Join'][1] as any[])
          .map((part) => (typeof part === 'string' ? part : 'resolved-name'))
          .join(raw['Fn::Join'][0]);
    const manifest = JSON.parse(joined);

    // Pipeline, auth triggers and API handlers: every lambda a parent's
    // experience depends on.
    expect(manifest.length).toBeGreaterThanOrEqual(20);
    for (const component of manifest) {
      // A line without a purpose is decoration: "0 runs" cannot be judged
      // without knowing whether the thing was meant to run.
      expect(component.purpose.length).toBeGreaterThan(10);
      expect(component.label.length).toBeGreaterThan(0);
    }
  });

  // Staging and production share an account, so the name prefix is the only
  // thing stopping a staging brief reporting production's alarms.
  test('the brief only reports its own environment alarms', () => {
    const prefixes = ['production', 'staging'].map((environment) => {
      const template = synth(environment);
      const fn = Object.values(template.findResources('AWS::Lambda::Function'))
        .map((r: any) => r.Properties)
        .find((p: any) => String(p.Description).includes('daily A-IEP health brief'));
      return fn.Environment.Variables.ALARM_PREFIX;
    });
    expect(prefixes[0]).not.toEqual(prefixes[1]);
    expect(prefixes[1]).toContain('staging');
  });
});

// CloudWatch caps an alarm period at 86,400 seconds. Above that it cannot
// aggregate the metric, so the alarm sees no datapoints; combined with
// treatMissingData BREACHING that produces an alarm which is permanently red
// and permanently wrong, whatever the thing it watches is doing. A 26-hour
// heartbeat shipped exactly that, and nothing in CI knew: CloudFormation
// accepts the template and CloudWatch accepts the alarm.
describe('alarm periods are ones CloudWatch can actually evaluate', () => {
  const CLOUDWATCH_MAX_PERIOD_SECONDS = 86_400;

  test.each(['production', 'staging'])('%s', (environment) => {
    const alarms = Object.entries(synth(environment).findResources('AWS::CloudWatch::Alarm'));
    expect(alarms.length).toBeGreaterThan(0);

    const tooLong = alarms
      .map(([logicalId, resource]) => ({
        logicalId,
        period: (resource as any).Properties.Period,
        // Metric-math alarms carry the period on each member metric instead.
        memberPeriods: ((resource as any).Properties.Metrics ?? [])
          .map((m: any) => m.MetricStat?.Period)
          .filter(Boolean),
      }))
      .filter((a) =>
        (a.period ?? 0) > CLOUDWATCH_MAX_PERIOD_SECONDS ||
        a.memberPeriods.some((p: number) => p > CLOUDWATCH_MAX_PERIOD_SECONDS));

    expect(tooLong).toEqual([]);
  });

  // The other half of the same limit: period x evaluationPeriods is the
  // window CloudWatch looks at, and it may not exceed a day either.
  test.each(['production', 'staging'])('%s evaluation windows', (environment) => {
    const alarms = Object.entries(synth(environment).findResources('AWS::CloudWatch::Alarm'));

    const tooWide = alarms
      .map(([logicalId, resource]) => {
        const props = (resource as any).Properties;
        const period = props.Period
          ?? (props.Metrics ?? []).map((m: any) => m.MetricStat?.Period).find(Boolean)
          ?? 0;
        return { logicalId, window: period * (props.EvaluationPeriods ?? 1) };
      })
      .filter((a) => a.window > CLOUDWATCH_MAX_PERIOD_SECONDS);

    expect(tooWide).toEqual([]);
  });
});

describe('undelivered login codes', () => {
  // This pin was wrong, and it is corrected here rather than deleted.
  //
  // It asserted that NO alarm watches AWS/SNS NumberOfNotificationsFailed, on
  // the reasoning that SNS does not emit that metric when a direct publish is
  // dropped at the account spend cap. The account's own data says otherwise:
  // SNS recorded 390 failures in the 19:00 hour on 2026-09-09 and 392 across
  // the day, under PhoneNumber=PhoneNumberDirect. The metric moved exactly
  // when it should have.
  //
  // What was actually broken was the DIMENSION. The original alarm queried
  // the metric with no dimensions at all, and that series has never had a
  // single datapoint. So the fix was one dimension, not a replacement, and
  // the correct assertion is not "no such alarm" but "no such alarm on the
  // empty series".
  test('the delivery-failure metric alarm names a dimension that exists', () => {
    // Two alarms share this metric name: SMS delivery (below) and alert
    // delivery from the alarm topic to the formatter. Both are dimensioned,
    // and a zero-dimension one is the bug, so assert on the whole set.
    const alarms = Object.values(synth('production').findResources('AWS::CloudWatch::Alarm'))
      .map((r: any) => r.Properties)
      .filter((p: any) => p.MetricName === 'NumberOfNotificationsFailed');

    expect(alarms.length).toBeGreaterThan(0);
    for (const alarm of alarms) {
      // Load-bearing: without a dimension the alarm watches a series with no
      // data and sits green through a total outage, which is what it did.
      expect(alarm.Dimensions).toBeDefined();
      expect(alarm.Dimensions.length).toBeGreaterThan(0);
    }

    const sms = alarms.find((p: any) => String(p.AlarmName).includes('SMS provider is rejecting'));
    expect(sms.Dimensions).toEqual([
      { Name: 'PhoneNumber', Value: 'PhoneNumberDirect' },
    ]);
  });

  // Two independent signals, kept deliberately. The metric needs no ops step
  // and works in both environments; the log filter carries the REASON but
  // only exists where delivery-status logging is switched on. Neither
  // subsumes the other, and this alarm has already been wrong twice.
  test('the delivery log is read as well as the metric', () => {
    synth('production').hasResourceProperties('AWS::Logs::MetricFilter', Match.objectLike({
      MetricTransformations: Match.arrayWith([
        Match.objectLike({ MetricName: 'SmsDeliveryFailed', MetricNamespace: 'AI-IEP/Auth' }),
      ]),
    }));
  });

  // One undelivered code is one parent who cannot get in. Unlike a failing
  // document, there is no benign volume of these to tolerate.
  test('a single undelivered code is enough to alarm', () => {
    const alarm = Object.values(synth('production').findResources('AWS::CloudWatch::Alarm'))
      .map((r: any) => r.Properties)
      .find((p: any) => String(p.AlarmName).includes('accepted and then not delivered'));

    expect(alarm).toBeDefined();
    expect(alarm.Threshold).toBe(1);
  });

  // The log group is account-level and shared by both environments, so a
  // filter in each would count every failure twice.
  test('the filter is created once, in production only', () => {
    const countFilters = (environment: string) =>
      Object.values(synth(environment).findResources('AWS::Logs::MetricFilter'))
        .map((r: any) => r.Properties)
        .filter((p: any) => JSON.stringify(p.MetricTransformations).includes('SmsDeliveryFailed'))
        .length;

    expect(countFilters('production')).toBe(1);
    expect(countFilters('staging')).toBe(0);
  });
});
