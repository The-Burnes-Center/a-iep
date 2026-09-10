import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as events from 'aws-cdk-lib/aws-events';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as path from 'path';
import * as kms from 'aws-cdk-lib/aws-kms';
import { getEnvironment, getResourceName, tagResource } from '../../tags';

/**
 * Outage alerting:
 *
 *   alarms -> alarmTopic -> alert-formatter -> alertTopic -> Chatbot -> #a-iep-dev
 *
 * Before this, nothing in AWS noticed an outage. The only automated signals
 * were two nightly GitHub Actions digests, so a prod failure at 02:00 waited
 * for a parent to report it.
 *
 * **Chatbot must be subscribed to alertTopic, not alarmTopic.** Subscribing it
 * to the raw topic still works, and produces the metric-dump card the
 * formatter exists to replace.
 *
 * Three things shape the design:
 *
 * 1. **Pipeline failures do not look like failures.** Every Task in
 *    iep-processing.asl.json catches into RecordFailure, RecordFailure ends
 *    with "End": true, and the machine has no state of type Fail. A failed
 *    document therefore produces a SUCCESSFUL execution, and
 *    ExecutionsFailed sits at zero through a total OCR outage. So there is
 *    deliberately no alarm on ExecutionsFailed: it would be the alarm that
 *    cannot fire. The signals used instead are the per-step lambda Errors
 *    (which also say WHICH stage broke) and a metric filter counting the
 *    failure marker record_failure now logs.
 *
 * 2. **The alarm description is the one line a person reads.** The formatter
 *    uses it verbatim as the impact statement under the headline, so each one
 *    is a single sentence about what a parent experiences, not a restatement
 *    of the metric. Keep them under ~250 characters: Chatbot truncates around
 *    there, and that limit also applies to the raw card it falls back to.
 *    Measured, after 17 of these were long enough to be cut mid-sentence.
 *
 * 3. **A missing metric must not read as healthy.** Anything that is a
 *    heartbeat uses treatMissingData.BREACHING. The default (MISSING) would
 *    leave a dead schedule looking fine, which is the exact failure the
 *    heartbeat exists to catch.
 *
 * Staging gets every alarm too, but staging alarms are informational: the
 * severity split lives in how Slack is configured to treat the topic, not
 * here, so that a noisy staging never trains anyone to ignore the channel.
 */

/**
 * Every pipeline Task in iep-processing.asl.json retries with MaxAttempts 3,
 * so ONE failing document invokes its step lambda 4 times and records 4
 * Errors. A threshold at or below 4 therefore fires for a single unreadable
 * PDF from a single parent, reported as though the whole stage were down.
 *
 * Measured, not reasoned about: a deliberate failing execution on staging
 * produced exactly 4 datapoints and tripped the original threshold of 2.
 *
 * 5 means at least two documents failed at the same stage inside five
 * minutes. Anything that raises the retry count has to raise this with it,
 * which is what the test/infra pin exists to force.
 */
/**
 * Deliberately a fraction of the account's SMS spend ceiling rather than the
 * ceiling itself: at the ceiling, login is already down, so an alarm there
 * reports an outage instead of preventing one.
 */
const SMS_SPEND_ALARM_USD = 25;

const PIPELINE_STEP_RETRY_INVOCATIONS = 4;
const PIPELINE_STEP_ERROR_THRESHOLD = PIPELINE_STEP_RETRY_INVOCATIONS + 1;

/** A lambda plus the human name used in the alarm and its description. */
export interface MonitoredFunction {
  readonly label: string;
  readonly fn: lambda.Function;
}

export interface MonitoringProps {
  /** Pipeline step lambdas. An error here fails one parent's document. */
  readonly pipelineFunctions: MonitoredFunction[];
  /** Cognito custom-auth triggers. An error here blocks login or signup. */
  readonly authTriggerFunctions: MonitoredFunction[];
  /** Request-path lambdas behind the HTTP API. */
  readonly apiFunctions: MonitoredFunction[];
  /** The lambda that runs record_failure, whose log group is filtered. */
  readonly ddbServiceFunction: lambda.Function;
  readonly iepProcessingStateMachine: stepfunctions.StateMachine;
  /** The 10-minute pending-upload sweep, watched as a heartbeat. */
  readonly pendingUploadSweepRule: events.Rule;
  readonly tables: { readonly label: string; readonly table: dynamodb.ITable }[];
  readonly httpApi: apigwv2.IHttpApi;
  /**
   * The application CMK, for the formatter's environment.
   *
   * Its variables are a topic ARN and an environment name, neither sensitive.
   * It is encrypted anyway because test/infra pins EVERY ChatbotAPI lambda to
   * the CMK, and a security pin with one exemption in it is a security pin
   * that grows exemptions.
   */
  readonly kmsKey: kms.IKey;
}

export class MonitoringStack extends Construct {
  /** Alarms publish here. The formatter is the only subscriber. */
  public readonly alarmTopic: sns.Topic;
  /**
   * Human-readable alerts. **This is the topic AWS Chatbot subscribes to.**
   * Subscribing Chatbot to alarmTopic instead gets the raw metric card.
   */
  public readonly alertTopic: sns.Topic;
  /** Rewrites alarms into Chatbot custom notifications. */
  public readonly alertFormatter: lambda.Function;
  /** Every alarm created, so test/infra can assert the set. */
  public readonly alarms: cloudwatch.Alarm[] = [];

  private readonly env: string;

  constructor(scope: Construct, id: string, props: MonitoringProps) {
    super(scope, id);
    this.env = getEnvironment();

    // Two topics, because the alert a person reads is not the alarm AWS
    // emits:
    //
    //   alarms -> alarmTopic -> alert-formatter -> alertTopic -> Chatbot
    //
    // Chatbot's own alarm card is a metric dump that truncates the
    // description and leads with the account id. The formatter replaces it
    // with a title, one impact line, a context line and a log link.
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: getResourceName('a-iep-alarms'),
      displayName: `A-IEP ${this.env} alarms (raw)`,
    });
    tagResource(this.alarmTopic, { Resource: 'SNSTopic', Function: 'AlarmTopic' });

    this.alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: getResourceName('a-iep-alerts'),
      displayName: `A-IEP ${this.env} alerts`,
    });
    tagResource(this.alertTopic, { Resource: 'SNSTopic', Function: 'AlertTopic' });

    this.alertFormatter = this.addAlertFormatter(props.kmsKey);

    this.addDocumentFailureAlarm(props.ddbServiceFunction);
    this.addPipelineStepAlarms(props.pipelineFunctions);
    this.addAuthAlarms(props.authTriggerFunctions);
    this.addApiAlarms(props.apiFunctions, props.httpApi);
    this.addStateMachineAlarms(props.iepProcessingStateMachine);
    this.addSweepHeartbeatAlarm(props.pendingUploadSweepRule);
    this.addTableThrottleAlarms(props.tables);
    this.addAbuseAlarms(props.authTriggerFunctions);
    this.addSmsPathAlarms(props.authTriggerFunctions);

    new cdk.CfnOutput(this, 'AlarmTopicArn', { value: this.alarmTopic.topicArn });
    // The one an operator needs: this is what Chatbot must subscribe to.
    new cdk.CfnOutput(this, 'AlertTopicArn', { value: this.alertTopic.topicArn });
  }

  /**
   * The formatter, plus the one alarm that watches the alerter itself.
   *
   * If this lambda breaks, every alarm still fires but no alert reaches
   * Slack, which looks exactly like a healthy system. So its own Errors alarm
   * publishes STRAIGHT to alertTopic, bypassing the formatter: a broken
   * formatter degrades to Chatbot's ugly raw card rather than to silence.
   *
   * No pip dependencies, so no Docker bundling: boto3 comes with the runtime.
   *
   * Not added, and a deliberate limit: there is no dead-letter queue. SNS
   * retries a failed lambda invocation and then drops the message, so alerts
   * raised while the formatter is down are lost rather than replayed. Being
   * TOLD the formatter is down is what matters for an alerting path; being
   * able to replay yesterday's alert is not. A DLQ is the follow-up if that
   * ever proves wrong.
   */
  private addAlertFormatter(kmsKey: kms.IKey): lambda.Function {
    const formatter = new lambda.Function(this, 'AlertFormatterFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '../functions/alert-formatter'),
        { assetHashType: cdk.AssetHashType.SOURCE, exclude: ['__pycache__'] },
      ),
      timeout: cdk.Duration.seconds(15),
      environment: {
        ALERT_TOPIC_ARN: this.alertTopic.topicArn,
        ENVIRONMENT: this.env,
      },
      description: 'Rewrites CloudWatch alarms as readable Slack alerts',
      logRetention: logs.RetentionDays.ONE_MONTH,
      environmentEncryption: kmsKey,
    });
    tagResource(formatter, { Resource: 'Lambda', Function: 'AlertFormatter' });

    this.alertTopic.grantPublish(formatter);
    this.alarmTopic.addSubscription(new subscriptions.LambdaSubscription(formatter));

    this.alarm('AlertFormatterFailingAlarm', {
      name: 'alerting itself is broken',
      description:
        'Alarms are firing but their alerts are not reaching Slack, so the ' +
        'channel looks quiet while something may be wrong. Check CloudWatch ' +
        'alarms directly until this is fixed.',
      metric: formatter.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      // Straight to Chatbot: routing this through the thing that is broken
      // would be the alarm that cannot fire.
      topic: this.alertTopic,
    });

    return formatter;
  }

  /**
   * One alarm, wired to the topic, with the description doing the explaining.
   * `treatMissingData` defaults to NOT_BREACHING because for an error count no
   * data genuinely means no errors; heartbeats pass BREACHING explicitly.
   */
  private alarm(
    id: string,
    opts: {
      name: string;
      description: string;
      metric: cloudwatch.IMetric;
      threshold: number;
      evaluationPeriods: number;
      comparisonOperator?: cloudwatch.ComparisonOperator;
      treatMissingData?: cloudwatch.TreatMissingData;
      /** Defaults to alarmTopic (via the formatter). Only the formatter's own
       *  alarm overrides this, to bypass the component it is reporting on. */
      topic?: sns.Topic;
    },
  ): cloudwatch.Alarm {
    const alarm = new cloudwatch.Alarm(this, id, {
      // Named for a human reading Slack at 2am, not for the metric.
      alarmName: `${getResourceName('a-iep')} ${opts.name}`,
      alarmDescription: opts.description,
      metric: opts.metric,
      threshold: opts.threshold,
      evaluationPeriods: opts.evaluationPeriods,
      comparisonOperator:
        opts.comparisonOperator ?? cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: opts.treatMissingData ?? cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const target = opts.topic ?? this.alarmTopic;
    alarm.addAlarmAction(new actions.SnsAction(target));
    // Recovery is as newsworthy as the failure: without this, Slack shows an
    // outage starting and never ending.
    alarm.addOkAction(new actions.SnsAction(target));
    this.alarms.push(alarm);
    return alarm;
  }

  /**
   * Aggregate "documents are failing", from the marker record_failure logs.
   *
   * Threshold is a rate, not a count: some documents legitimately fail (a
   * corrupt PDF, a scan OCR cannot read), and production has run about 5.5%
   * lifetime failures, so alarming on a single failure would page for normal
   * operation. Three inside fifteen minutes is not normal.
   */
  private addDocumentFailureAlarm(ddbServiceFunction: lambda.Function): void {
    const metricNamespace = 'AI-IEP/Pipeline';
    const metricName = 'DocumentFailures';

    new logs.MetricFilter(this, 'DocumentFailureFilter', {
      logGroup: ddbServiceFunction.logGroup,
      // record_failure logs "RECORD_FAILURE iep=<id> step=<step>". Ids only,
      // never document content.
      filterPattern: logs.FilterPattern.literal('RECORD_FAILURE'),
      metricNamespace,
      metricName,
      metricValue: '1',
      defaultValue: 0,
    });

    this.alarm('DocumentsFailingAlarm', {
      name: 'document pipeline failing',
      description:
        'Uploads are erroring instead of producing summaries. Usually Mistral ' +
        'OCR, OpenAI or Comprehend is down.',
      metric: new cloudwatch.Metric({
        namespace: metricNamespace,
        metricName,
        statistic: 'Sum',
        period: cdk.Duration.minutes(15),
      }),
      threshold: 3,
      evaluationPeriods: 1,
    });
  }

  /**
   * Per-step lambda errors. A step lambda raises to trigger the state
   * machine's Catch, so Errors is exactly "this stage crashed", and having one
   * alarm per step means the alarm name alone identifies the failing stage.
   */
  private addPipelineStepAlarms(fns: MonitoredFunction[]): void {
    for (const { label, fn } of fns) {
      this.alarm(`PipelineStepErrors${label.replace(/[^A-Za-z0-9]/g, '')}`, {
        name: `pipeline step failing: ${label}`,
        description:
          `Documents are failing at the ${label} step, so every upload ` +
          'reaching this stage is affected.',
        metric: fn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        threshold: PIPELINE_STEP_ERROR_THRESHOLD,
        evaluationPeriods: 1,
      });
    }
  }

  /**
   * Cognito trigger errors. Highest severity in the system: a broken trigger
   * means nobody can log in or sign up, and phone signup has already been
   * silently dead for a month once (2026-07).
   *
   * A caveat that belongs next to these alarms rather than in a doc: the
   * Amplify v6 regression of 2026-09 threw in the browser, before any Cognito
   * call, so none of these would have fired. The scheduled auth check in
   * .github/workflows/auth_healthcheck.yml is what covers that.
   */
  private addAuthAlarms(fns: MonitoredFunction[]): void {
    for (const { label, fn } of fns) {
      this.alarm(`AuthTriggerErrors${label.replace(/[^A-Za-z0-9]/g, '')}`, {
        name: `login broken: ${label} trigger failing`,
        description:
          `Families cannot log in or sign up: the ${label} trigger is failing.`,
        metric: fn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 1,
      });
    }
  }

  private addApiAlarms(fns: MonitoredFunction[], httpApi: apigwv2.IHttpApi): void {
    this.alarm('ApiServerErrorAlarm', {
      name: 'API returning 5xx',
      description:
        'Parents cannot load summaries, save a profile or start an upload.',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '5xx',
        dimensionsMap: { ApiId: httpApi.apiId },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
    });

    for (const { label, fn } of fns) {
      this.alarm(`ApiFunctionErrors${label.replace(/[^A-Za-z0-9]/g, '')}`, {
        name: `API handler failing: ${label}`,
        description:
          `The ${label} part of the app is broken for everyone using it now.`,
        metric: fn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        threshold: 5,
        evaluationPeriods: 1,
      });
      this.alarm(`ApiFunctionThrottles${label.replace(/[^A-Za-z0-9]/g, '')}`, {
        name: `API handler throttled: ${label}`,
        description:
          `The ${label} handler is throttled: failing on capacity, not bugs.`,
        metric: fn.metricThrottles({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 1,
      });
    }
  }

  /**
   * Timeouts only. ExecutionsFailed is deliberately absent: see the class
   * docblock. A timeout is NOT caught by RecordFailure, so it is the one
   * state-machine failure that leaves a document stuck with no status change
   * and no parent-visible error.
   */
  private addStateMachineAlarms(sm: stepfunctions.StateMachine): void {
    this.alarm('PipelineTimedOutAlarm', {
      name: 'document stuck: pipeline execution timed out',
      description:
        'A document stuck for six hours was never marked failed, so the parent ' +
        'is still on the processing screen. Fail the row closed by hand.',
      metric: sm.metricTimedOut({ period: cdk.Duration.minutes(15), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
    });
  }

  /**
   * The sweep is what fails a stalled upload closed. If it stops, parents sit
   * on the processing screen forever, which is the state PR #64 removed.
   *
   * BREACHING is the whole point: a rule that has stopped emits no datapoints
   * at all, so the CloudWatch default of MISSING would render a dead schedule
   * as a healthy one.
   */
  private addSweepHeartbeatAlarm(rule: events.Rule): void {
    this.alarm('SweepHeartbeatAlarm', {
      name: 'pending-upload sweep has stopped running',
      description:
        'Stalled uploads are no longer failed closed, so parents sit on the ' +
        'processing screen indefinitely. The 10-minute sweep has stopped.',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Events',
        metricName: 'Invocations',
        dimensionsMap: { RuleName: rule.ruleName },
        statistic: 'Sum',
        period: cdk.Duration.minutes(30),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    this.alarm('SweepFailingAlarm', {
      name: 'pending-upload sweep failing to invoke',
      description:
        'EventBridge cannot invoke the pending-upload sweep, so stalled ' +
        'uploads are never failed closed.',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Events',
        metricName: 'FailedInvocations',
        dimensionsMap: { RuleName: rule.ruleName },
        statistic: 'Sum',
        period: cdk.Duration.minutes(15),
      }),
      threshold: 1,
      evaluationPeriods: 1,
    });
  }

  /**
   * Abuse of the phone-signup flow. Signup volume and SMS spend are the two
   * leading indicators of it, and both are alarmed here because the harm
   * lands on families rather than on us: once SMS delivery stops, no parent
   * can receive a login code until the calendar month rolls over.
   *
   * - Signup surge. Cognito triggers are not retried, so one invocation is
   *   one real attempt, and the threshold sits far above anything organic
   *   for this service.
   * - SMS spend. Alarmed at a fraction of the ceiling, which leaves room to
   *   react while codes are still being delivered.
   */
  /**
   * The SMS send path, watched through the markers create-auth-challenge
   * logs rather than through Lambda Errors.
   *
   * Errors cannot see any of this. The trigger reports a failed send through
   * the challenge parameter instead of raising, so its error count stays at
   * zero through a total delivery outage and every "login broken" alarm stays
   * green. That is why the markers exist and why these read logs.
   *
   * Refusals are the leading indicator. Spend only moves after money is gone;
   * a burst of refused destinations is the same event while it is happening.
   */
  private addSmsPathAlarms(authTriggers: MonitoredFunction[]): void {
    const createAuth = authTriggers.find((f) => f.label.startsWith('CreateAuthChallenge'));
    if (!createAuth) {
      return;
    }
    const metricNamespace = 'AI-IEP/Auth';

    const markerMetric = (id: string, marker: string, metricName: string) => {
      new logs.MetricFilter(this, id, {
        logGroup: createAuth.fn.logGroup,
        // Marker only. These are pinned by the lambda's own unit tests, since
        // a reworded log line would disarm the alarm without failing anything.
        filterPattern: logs.FilterPattern.literal(marker),
        metricNamespace,
        metricName,
        metricValue: '1',
        defaultValue: 0,
      });
      return new cloudwatch.Metric({
        namespace: metricNamespace,
        metricName,
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });
    };

    this.alarm('SmsDestinationRefusedAlarm', {
      name: 'login codes being requested for numbers we do not serve',
      description:
        'Someone is asking for login codes for numbers outside the countries ' +
        'this service texts. The codes are being refused, so no money is ' +
        'being spent, but this is what an abuse run looks like starting.',
      metric: markerMetric('SmsRefusedDestinationFilter', 'SMS_REFUSED_DESTINATION', 'SmsRefusedDestination'),
      // A real parent mistyping a country code is possible but rare, and one
      // refusal should not page. A run produces these in bulk.
      threshold: 10,
      evaluationPeriods: 1,
    });

    this.alarm('SmsBudgetExhaustedAlarm', {
      name: 'login codes are being refused: the sending limit is reached',
      description:
        'The service-wide limit on login codes has been hit, so parents are ' +
        'being turned away at sign-in. Either an abuse run is under way or ' +
        'real demand has outgrown the limit.',
      metric: markerMetric('SmsBudgetExhaustedFilter', 'SMS_BUDGET_EXHAUSTED', 'SmsBudgetExhausted'),
      // Any occurrence matters: this one only fires when a parent was refused.
      threshold: 1,
      evaluationPeriods: 1,
    });

    this.alarm('SmsSendFailedAlarm', {
      name: 'login codes are not being delivered',
      description:
        'Sending a login code is failing outright, so no parent can sign in. ' +
        'This is the alarm the trigger error alarms cannot raise, because a ' +
        'failed send is reported to the app rather than thrown.',
      metric: markerMetric('SmsSendFailedFilter', 'SMS_SEND_FAILED', 'SmsSendFailed'),
      threshold: 1,
      evaluationPeriods: 1,
    });

    // Delivery failures counted by SNS itself, which is the only way to see a
    // message that was accepted and then not delivered. Needs SMS delivery
    // status logging enabled on the account; without it this stays flat, so
    // it is a complement to SMS_SEND_FAILED rather than a replacement.
    this.alarm('SmsDeliveryFailureAlarm', {
      name: 'the SMS provider is failing to deliver login codes',
      description:
        'Codes are being accepted for sending and then not arriving. Parents ' +
        'see "code sent" and no code, which looks to them like the app is ' +
        'broken.',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SNS',
        metricName: 'NumberOfNotificationsFailed',
        statistic: 'Sum',
        period: cdk.Duration.minutes(15),
      }),
      threshold: 5,
      evaluationPeriods: 1,
    });
  }

  private addAbuseAlarms(authTriggers: MonitoredFunction[]): void {
    const preSignUp = authTriggers.find((f) => f.label.startsWith('PreSignUp'));
    if (preSignUp) {
      this.alarm('SignupSurgeAlarm', {
        name: 'signup flood: someone is abusing the signup form',
        description:
          'Far more accounts are being created than this service ever sees. ' +
          'Each one sends an SMS, so this burns the monthly SMS budget and ' +
          'ends with families unable to receive login codes.',
        metric: preSignUp.fn.metricInvocations({
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 20,
        evaluationPeriods: 1,
      });
    }

    this.alarm('SmsSpendAlarm', {
      name: 'SMS budget half spent',
      description:
        'Monthly SMS spend has passed half the cap. At the cap, SNS stops ' +
        'sending and NO parent can receive a login code until the calendar ' +
        'month rolls over. Check for signup abuse before raising the limit.',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SNS',
        metricName: 'SMSMonthToDateSpentUSD',
        statistic: 'Maximum',
        period: cdk.Duration.minutes(15),
      }),
      threshold: SMS_SPEND_ALARM_USD,
      evaluationPeriods: 1,
    });
  }

  private addTableThrottleAlarms(
    tables: { readonly label: string; readonly table: dynamodb.ITable }[],
  ): void {
    for (const { label, table } of tables) {
      this.alarm(`TableThrottle${label.replace(/[^A-Za-z0-9]/g, '')}`, {
        name: `DynamoDB throttling: ${label}`,
        description:
          `The ${label} table is throttling: parents see random intermittent ` +
          'errors rather than a clean outage.',
        metric: new cloudwatch.MathExpression({
          expression: 'read + write',
          usingMetrics: {
            read: table.metric('ReadThrottleEvents', { statistic: 'Sum' }),
            write: table.metric('WriteThrottleEvents', { statistic: 'Sum' }),
          },
          period: cdk.Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
      });
    }
  }
}
