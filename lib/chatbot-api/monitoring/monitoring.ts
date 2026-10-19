import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as logsDestinations from 'aws-cdk-lib/aws-logs-destinations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as path from 'path';
import * as kms from 'aws-cdk-lib/aws-kms';
import { getEnvironment, getMetricNamespace, getResourceName, tagResource, type Environment } from '../../tags';
import {
  renderAlarmDescriptionFor,
  type AlarmThreshold,
  type AlertCopy,
  type Severity,
} from './alert-copy';
import { COMPONENT_COPY, plainName, smsSpendNearCap } from './alert-copy-components';
import { ALERT_COPY } from './alert-copy-table';

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
 * 1. **A failed document is one signal, not two.** Every Task in
 *    iep-processing.asl.json catches into RecordFailure, which logs the
 *    RECORD_FAILURE marker and then ends the execution in a Fail state
 *    (DocumentProcessingFailed; a RecordFailure that itself fails ends as
 *    RecordFailureFailed). So ExecutionsFailed now moves once per failed
 *    document and the console lists them. It used to stay at zero, because
 *    RecordFailure ended the machine normally. There is still deliberately no
 *    alarm on ExecutionsFailed: the marker filter below already alarms on the
 *    same event, and a second alarm would page twice per failure. The signals
 *    used are the per-step lambda Errors (which also say WHICH stage broke)
 *    and the metric filter counting the failure marker.
 *
 * 2. **The alarm description carries the whole message.** CloudWatch passes
 *    the alarm name, description and state into the SNS payload and nothing
 *    else we control, so the environment, severity, symptom, impact, next
 *    steps and runbook link all travel in the description, written by
 *    alert-copy.ts and laid out by the formatter. The wording of every alarm
 *    is in that one file; this file only says what is measured and when it
 *    fires. The two alarms that bypass the formatter fall back to Chatbot's
 *    raw card, which truncates around 250 characters, so a description leads
 *    with the headline and impact for exactly that reason.
 *
 * 3. **A missing metric must not read as healthy.** Anything that is a
 *    heartbeat uses treatMissingData.BREACHING. The default (MISSING) would
 *    leave a dead schedule looking fine, which is the exact failure the
 *    heartbeat exists to catch.
 *
 * Staging gets every alarm too, and says so: its alerts read [STAGING]
 * [WARNING] at most, state that no real families are affected, and never post
 * a resolution. Recoveries post only for CRITICAL alarms in prod; see the
 * formatter. Both environments currently post to the same Slack channel, so
 * the label on the first line is what tells them apart.
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
 * The account's SNS MonthlySpendLimit, in dollars. Mirrors an account setting
 * CDK does not own (raised from 50 to 60 after the 2026-09-09 outage), so a
 * change to the limit has to be made here as well or the near-cap alarm
 * below drifts to the wrong fraction.
 */
export const SMS_MONTHLY_LIMIT_USD = 60;

/**
 * The near-cap alarm fires at this fraction of the limit: at the limit itself
 * login is already down, so an alarm there reports an outage instead of
 * preventing one. 0.8 leaves $12 of headroom, which is roughly a thousand
 * codes: time to decide whether to raise the limit before anyone is locked
 * out.
 *
 * It replaces a fixed $25 alarm on the same month-to-date series. That one
 * could only ever fire once a month and then stay red until the 1st, so from
 * 2026-09-10 it read as "1 problem" in every daily brief of both
 * environments while nothing was happening.
 */
export const SMS_NEAR_CAP_FRACTION = 0.8;

/**
 * Spend velocity, in dollars per hour, that counts as an abuse run.
 *
 * Measured, not guessed. A normal week is about 12 codes at about $0.012
 * each, so ordinary traffic spends cents per DAY and the busiest real hour
 * is a parent retrying a code three times ($0.04). The 2026-09-09 attack
 * spent $49 inside one five-minute datapoint, about $590 an hour.
 *
 * $2 an hour is roughly 170 codes an hour, or 14 inside one five-minute
 * datapoint: fifty times the busiest real hour, and three hundred times
 * below the attack. A drip slower than this is what the near-cap alarm is
 * for; at exactly this rate the $60 cap is still 30 hours away.
 */
export const SMS_SPEND_VELOCITY_ALARM_USD_PER_HOUR = 2;

/**
 * SNS's own words for a publish dropped at the monthly spend cap, matched as a
 * prefix. Compared against `$.delivery.providerResponse` in the delivery log,
 * which is the only place the REASON for a failure appears.
 */
const SMS_QUOTA_PROVIDER_RESPONSE = 'No quota left for account';

/**
 * Cognito's own SMS-configuration validation number, excluded from the
 * delivery-failure metrics because it is not a parent.
 *
 * Calling UpdateUserPool or SetUserPoolMfaConfig makes Cognito send a test SMS
 * to this number to check the SNS caller role, and it does not deliver. Every
 * CloudFormation deploy that re-applies the pool's SMS settings makes both
 * calls, so each one writes two FAILURE records that no parent ever saw.
 *
 * Identified, not guessed. Over the delivery log's 30-day retention this
 * destination appears 12 times, and all 12 land on the same second as a
 * CloudTrail UpdateUserPool or SetUserPoolMfaConfig by AWSCloudFormation,
 * in sub-second pairs. It never appears without one. Against that, the
 * providerResponse is useless as a tell: these records read "No quota left
 * for account" during the 2026-09-09 cap outage and "Unknown error attempting
 * to reach phone" outside it, exactly like a real send.
 *
 * If AWS changes the number this stops excluding anything and the deploy
 * noise comes back, which is the safe direction to fail in: a filter that
 * over-matches pages someone, a filter that under-matches hides an outage.
 */
const COGNITO_SMS_VALIDATION_NUMBER = '+12064350128';

export type { Severity };

const PIPELINE_STEP_RETRY_INVOCATIONS = 4;
const PIPELINE_STEP_ERROR_THRESHOLD = PIPELINE_STEP_RETRY_INVOCATIONS + 1;

/**
 * 1: alarm on every document failure, not a rate. This was 3 (inside 15
 * minutes) until the 2026-09-11 password-protected-PDF incident, where the
 * single failure this alarm exists to catch produced no alarm at all -- the
 * whole point of a rate threshold is that one occurrence is exactly what it
 * will not page for. The product owner chose, explicitly and knowingly, to
 * accept the resulting noise while upload volume stays low rather than wait
 * for a pattern. Raising this back to a rate (3, say) is the one-line
 * change to make if volume grows enough that the noise stops being worth it.
 */
const DOCUMENT_FAILURE_ALARM_THRESHOLD = 1;

/**
 * Cognito enforces its own hard, non-adjustable 5-second budget on every
 * SYNCHRONOUS trigger invocation -- verified against AWS's own Cognito
 * documentation: "You can't change this five-second timeout value." That is
 * wholly separate from the 30-second Lambda function timeout configured on
 * each trigger in new-auth.ts. Past the 5-second budget, Cognito gives up and
 * fails the parent's sign-in or sign-up outright, even though the Lambda
 * invocation keeps running in the background and finishes with no exception,
 * so Errors -- what addAuthAlarms below watches -- stays at zero through
 * exactly this failure.
 */
const COGNITO_TRIGGER_HARD_BUDGET_MS = 5_000;

/**
 * 80% of the hard budget above, reasoned rather than a round guess.
 * Production's worst observed trigger Duration over the trailing 30 days
 * (measured 2026-09-10) is 2.46s, 49% of the budget, so 4s sits 63% above the
 * worst real reading -- comfortable headroom against ordinary jitter -- while
 * still leaving only a one-second margin before Cognito actually abandons the
 * call. That margin is deliberately thin: the point of this alarm is to catch
 * a trigger heading for the wall, not to wait until a parent has already been
 * turned away.
 */
const AUTH_TRIGGER_DURATION_ALARM_THRESHOLD_MS = COGNITO_TRIGGER_HARD_BUDGET_MS * 0.8;

/** One line in the daily brief: what ran, and what it is for. */
interface BriefComponent {
  readonly label: string;
  readonly functionName: string;
  /** Why a reader who did not build this should care that it ran, or did not.
   *  Without it, "0 runs" is unreadable: some of these are meant to be idle. */
  readonly purpose: string;
}

/** A lambda plus the human name used in the alarm and its description. */
export interface MonitoredFunction {
  readonly label: string;
  readonly fn: lambda.Function;
  /**
   * One line on what this is for, shown in the daily brief.
   *
   * Required, because the brief's value is that a reader who did not build
   * the thing can still judge it: "0 runs" is meaningless without knowing
   * whether it is supposed to run hourly or only when a parent acts. An
   * unexplained green line is decoration.
   */
  readonly purpose: string;
}

export interface MonitoringProps {
  /** Pipeline step lambdas. An error here fails one parent's document. */
  readonly pipelineFunctions: MonitoredFunction[];
  /** Cognito custom-auth triggers. An error here blocks login or signup. */
  readonly authTriggerFunctions: MonitoredFunction[];
  /**
   * The /auth/* endpoints and the dispatcher behind them.
   *
   * Their own list rather than apiFunctions, for two reasons. Their alarms are
   * critical where an API handler's are medium: the app being partly broken is
   * not the same as nobody being able to get in. And these are the first
   * functions in this repo with reserved concurrency, which is a hard cap as
   * well as a floor -- past it Lambda returns 429 before the handler runs, and
   * what it sheds here is a parent's sign-in. A throttle on this list means
   * something a generic capacity alarm would understate.
   */
  readonly authEndpointFunctions: MonitoredFunction[];
  /**
   * Every lambda in this environment that texts a phone directly, each of
   * which logs the MessageId SNS returns. Undelivered SMS are attributed to
   * this environment by finding their id in these log groups, so a sender
   * missing from this list makes its failures invisible here.
   */
  readonly smsSenderFunctions: lambda.Function[];
  /** Request-path lambdas behind the HTTP API. */
  readonly apiFunctions: MonitoredFunction[];
  /** The lambda that runs record_failure, whose log group is filtered. */
  readonly ddbServiceFunction: lambda.Function;
  readonly iepProcessingStateMachine: stepfunctions.StateMachine;
  /** The on-demand "translate it now" machine. A parent is waiting on this
   *  one in the foreground, unlike the upload pipeline. */
  readonly translationStateMachine: stepfunctions.StateMachine;
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

  private readonly env: Environment;

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
    this.addTranslationSkippedAlarm(props.pipelineFunctions);
    this.addAuthAlarms(props.authTriggerFunctions);
    this.addAuthDurationAlarms(props.authTriggerFunctions);
    this.addApiAlarms(props.apiFunctions, props.httpApi);
    this.addStateMachineAlarms(props.iepProcessingStateMachine);
    this.addSweepHeartbeatAlarm(props.pendingUploadSweepRule);
    this.addTableThrottleAlarms(props.tables);
    this.addAbuseAlarms(props.authTriggerFunctions);
    this.addSmsPathAlarms(props.authTriggerFunctions);
    const smsFailureClassifier = this.addSmsDeliveryFailureAlarm(
      props.smsSenderFunctions, props.kmsKey);
    this.addAuthEndpointAlarms(props.authEndpointFunctions);
    this.addDeletionAlarms(props.apiFunctions, props.ddbServiceFunction);
    this.addTranslationAndUsageAlarms(props.translationStateMachine);
    this.addDailyBrief(props.kmsKey, [
      ...props.pipelineFunctions,
      ...props.authTriggerFunctions,
      ...props.authEndpointFunctions,
      ...props.apiFunctions,
      {
        label: 'SMS failure attribution',
        fn: smsFailureClassifier,
        purpose: 'works out which environment sent each undelivered login code; runs only when one fails',
      },
    ].map(({ label, fn, purpose }) => ({
      // Plain words, because the brief is read by people who did not build
      // the stack: "code creation", not a Cognito trigger name.
      label: plainName(label),
      functionName: fn.functionName,
      purpose,
    })));

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
  /**
   * The once-a-day brief: a positive statement that things ran.
   *
   * Alarms answer "did something break". They cannot answer "is anything
   * still happening", and a component that stops being invoked at all raises
   * no errors, so every alarm stays green while nothing works. Silence from
   * an alerting system is ambiguous; this is what makes it mean something.
   *
   * The component manifest is built here rather than in the lambda, so adding
   * a monitored thing is one edit in one place and the brief cannot drift out
   * of step with the alarms.
   */
  private addDailyBrief(kmsKey: kms.IKey, components: BriefComponent[]): void {
    // The manifest goes in Parameter Store, not an environment variable.
    //
    // Lambda caps ALL environment variables at 4KB combined, and this one
    // alone measured 4,745 bytes at 23 components: the deploy failed, and it
    // failed at CloudFormation rather than in CI. Trimming it to fit would
    // only move the failure to whoever adds the 24th component, so the size
    // ceiling has to go away rather than be squeezed under. Advanced tier
    // because standard parameters share the same 4KB limit.
    //
    // It cannot be a file in the lambda asset: the manifest carries function
    // names, which are CloudFormation tokens that do not exist until deploy.
    const manifestJson = JSON.stringify(components);
    const manifestParameter = new ssm.StringParameter(this, 'DailyBriefComponents', {
      parameterName: `/a-iep/${this.env}/daily-brief/components`,
      stringValue: manifestJson,
      tier: ssm.ParameterTier.ADVANCED,
      description: 'What the daily brief reports on, and what each component is for',
    });

    const brief = new lambda.Function(this, 'DailyBriefFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '../functions/daily-brief'),
        { assetHashType: cdk.AssetHashType.SOURCE, exclude: ['__pycache__'] },
      ),
      // 51 alarms and two metric queries per component: seconds, not
      // milliseconds, and a slow CloudWatch day should not fail the brief.
      timeout: cdk.Duration.minutes(2),
      environment: {
        ALERT_TOPIC_ARN: this.alertTopic.topicArn,
        ENVIRONMENT: this.env,
        BRIEF_COMPONENTS_PARAM: manifestParameter.parameterName,
        // Scoped so a staging brief never reports production's alarms. They
        // share an account and the name prefix is all that separates them.
        ALARM_PREFIX: `${getResourceName('a-iep')} `,
      },
      description: 'Publishes the daily A-IEP health brief to Slack',
      logRetention: logs.RetentionDays.ONE_MONTH,
      environmentEncryption: kmsKey,
    });
    tagResource(brief, { Resource: 'Lambda', Function: 'DailyBrief' });

    // Read-only on metrics and alarm state. It must never be able to change
    // an alarm it reports on.
    brief.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:GetMetricData', 'cloudwatch:DescribeAlarms'],
      resources: ['*'],
    }));
    this.alertTopic.grantPublish(brief);
    manifestParameter.grantRead(brief);

    // 13:00 UTC is 9am Eastern, which is when someone is actually reading.
    const schedule = new events.Rule(this, 'DailyBriefSchedule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '13' }),
      description: 'Triggers the daily A-IEP health brief',
    });
    schedule.addTarget(new targets.LambdaFunction(brief));

    // The brief is itself a thing that can stop running, and its whole value
    // is that its absence means something. BREACHING so a dead schedule reads
    // as broken rather than as quiet.
    this.alarm('DailyBriefMissingAlarm', {
      copy: ALERT_COPY.DailyBriefMissingAlarm,
      // 24 one-hour periods, not one 26-hour period. CloudWatch caps an alarm
      // period at 86,400 seconds; above that it cannot aggregate, so it sees
      // no datapoints, treats every one as breaching, and sits in ALARM
      // forever no matter what the function does. The first version of this
      // alarm was written that way and was broken from the moment it deployed:
      // permanently red, and permanently wrong.
      //
      // Invocations emits nothing when a function does not run, so each empty
      // hour breaches and 24 consecutive empty hours mean a full day has
      // passed with no brief. The single daily run keeps at least one hour in
      // any 24-hour window populated, so this cannot flap on cadence alone.
      metric: brief.metricInvocations({ period: cdk.Duration.hours(1), statistic: 'Sum' }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 24,
      datapointsToAlarm: 24,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    // The heartbeat above cannot see this one. Lambda emits Invocations for a
    // FAILED invocation exactly as it does for a successful one, so a brief
    // that raises every single morning still lands one datapoint an hour and
    // keeps "has the brief stopped running" permanently green. The schedule
    // firing and the brief being sent are two different facts, and only the
    // second one is the point.
    this.alarm('DailyBriefFailingAlarm', {
      copy: ALERT_COPY.DailyBriefFailingAlarm,
      metric: brief.metricErrors({ period: cdk.Duration.hours(1), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
    });
  }

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

    // To say how long an alert lasted in its resolution message. Read-only,
    // and scoped to this environment's alarms: the name prefix is what keeps
    // prod's formatter out of staging's history and the other way round. The
    // lookup is best effort in the lambda, so a denied call loses only the
    // duration, never the message.
    formatter.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:DescribeAlarmHistory'],
      resources: [
        cdk.Stack.of(this).formatArn({
          service: 'cloudwatch',
          resource: 'alarm',
          resourceName: `${getResourceName('a-iep')} *`,
          arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
    }));

    this.alarmTopic.addSubscription(new subscriptions.LambdaSubscription(formatter));

    this.alarm('AlertFormatterFailingAlarm', {
      copy: ALERT_COPY.AlertFormatterFailingAlarm,
      metric: formatter.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      // Straight to Chatbot: routing this through the thing that is broken
      // would be the alarm that cannot fire.
      topic: this.alertTopic,
    });

    // The alarm above only covers a formatter that runs and raises. It says
    // nothing about a formatter that is never CALLED: if this subscription is
    // deleted, the invoke permission is lost, or SNS gives up retrying, then
    // Errors stays at zero forever and every alarm in this file is silently
    // dropped on the way to Slack. The channel goes quiet and quiet is
    // exactly what it means when nothing is wrong.
    //
    // Also straight to alertTopic, for the same reason as above.
    this.alarm('AlertDeliveryFailingAlarm', {
      copy: ALERT_COPY.AlertDeliveryFailingAlarm,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SNS',
        metricName: 'NumberOfNotificationsFailed',
        dimensionsMap: { TopicName: this.alarmTopic.topicName },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
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
    opts: AlarmThreshold & {
      /** The words: name, severity and the whole Slack message. See alert-copy.ts. */
      copy: AlertCopy;
      treatMissingData?: cloudwatch.TreatMissingData;
      /** Defaults to alarmTopic (via the formatter). Only the formatter's own
       *  alarm overrides this, to bypass the component it is reporting on. */
      topic?: sns.Topic;
    },
  ): cloudwatch.Alarm {
    const alarm = new cloudwatch.Alarm(this, id, {
      // Unchanged from before alert-copy.ts existed: renaming an alarm makes
      // CloudFormation replace it. See the header of alert-copy.ts.
      alarmName: `${getResourceName('a-iep')} ${opts.copy.alarmName}`,
      // The description is the only field CloudWatch carries into the alarm
      // payload that we control, so everything the formatter shows travels in
      // it: environment, severity, symptom, impact, next steps and runbook.
      alarmDescription: renderAlarmDescriptionFor(this.env, opts.copy, opts),
      metric: opts.metric,
      threshold: opts.threshold,
      evaluationPeriods: opts.evaluationPeriods,
      datapointsToAlarm: opts.datapointsToAlarm,
      comparisonOperator:
        opts.comparisonOperator ?? cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: opts.treatMissingData ?? cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const target = opts.topic ?? this.alarmTopic;
    alarm.addAlarmAction(new actions.SnsAction(target));
    // Recovery is as newsworthy as the failure: without this, Slack shows an
    // outage starting and never ending.
    //
    // The OK goes through the FORMATTER even for the two alarms whose ALARM
    // action deliberately bypasses it. The asymmetry is the point. When one of
    // those fires, the formatter cannot be trusted, so the alert takes the
    // direct route and degrades to Chatbot's raw card. When it clears, the
    // formatter is by definition working, so the recovery can be formatted --
    // and, more usefully, the formatter's coming-online suppression applies.
    //
    // Without this, an alarm moving INSUFFICIENT_DATA -> OK on first deploy
    // posts a raw card reading "1 datapoint [0.0] was not greater than or
    // equal to the threshold (1.0)" under a green tick, which says nothing to
    // a reader and trains them to skim the channel. That is the same noise the
    // formatter already suppresses for every other alarm.
    alarm.addOkAction(new actions.SnsAction(this.alarmTopic));
    this.alarms.push(alarm);
    return alarm;
  }

  /**
   * Every single document failure, from the marker record_failure logs.
   *
   * Deliberately a count of one, not a rate: see
   * DOCUMENT_FAILURE_ALARM_THRESHOLD for why, and for what to change if that
   * decision needs revisiting. The rate-based reasoning this alarm used to
   * follow was sound as far as it went -- some documents legitimately fail (a
   * corrupt PDF, a scan OCR cannot read), and production has run about 5.5%
   * lifetime failures -- it just meant a single parent's failure, on its own,
   * would never be the thing that pages anyone.
   */
  private addDocumentFailureAlarm(ddbServiceFunction: lambda.Function): void {
    const metricNamespace = getMetricNamespace('Pipeline');
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

    // Every database failure in the pipeline, including the ones nothing else
    // can see.
    //
    // The DDB service REPORTS failures rather than raising them: it catches
    // everything and returns a 500 status in its result. So its Lambda Errors
    // metric stays at zero through a total database outage, and an alarm on
    // Errors cannot fire. The step lambdas check the status code; the state
    // machine, which calls this function directly for progress updates, for
    // recording failures, and for purging the redacted OCR, does not.
    //
    // That left the worst case invisible: if record_failure itself fails, a
    // parent's document is stuck at PROCESSING with no failure recorded and
    // nothing raised anywhere.
    new logs.MetricFilter(this, 'DdbServiceErrorFilter', {
      logGroup: ddbServiceFunction.logGroup,
      filterPattern: logs.FilterPattern.literal('DDB_SERVICE_ERROR'),
      metricNamespace,
      metricName: 'DdbServiceErrors',
      metricValue: '1',
      defaultValue: 0,
    });

    this.alarm('DdbServiceErrorAlarm', {
      copy: ALERT_COPY.DdbServiceErrorAlarm,
      metric: new cloudwatch.Metric({
        namespace: metricNamespace,
        metricName: 'DdbServiceErrors',
        statistic: 'Sum',
        period: cdk.Duration.minutes(15),
      }),
      // Each state-machine task retries three times, so one genuinely failing
      // write logs four times. Above that means more than one document.
      threshold: 5,
      evaluationPeriods: 1,
    });

    // A child's unredacted records surviving a failure. Separate from the
    // alarm above because the consequence is different in kind: that one is
    // an outage, this one is FERPA-protected content that should no longer
    // exist still sitting in S3.
    //
    // The purge is deliberately best-effort, since recording the failure
    // matters more than the cleanup and must not be masked by it. That makes
    // this marker the only way anyone finds out, and its old form was a plain
    // print that matched no filter at all.
    new logs.MetricFilter(this, 'UnredactedArtifactsRetainedFilter', {
      logGroup: ddbServiceFunction.logGroup,
      filterPattern: logs.FilterPattern.literal('UNREDACTED_ARTIFACTS_RETAINED'),
      metricNamespace,
      metricName: 'UnredactedArtifactsRetained',
      metricValue: '1',
      defaultValue: 0,
    });

    this.alarm('UnredactedArtifactsRetainedAlarm', {
      copy: ALERT_COPY.UnredactedArtifactsRetainedAlarm,
      metric: new cloudwatch.Metric({
        namespace: metricNamespace,
        metricName: 'UnredactedArtifactsRetained',
        statistic: 'Sum',
        period: cdk.Duration.minutes(15),
      }),
      // One is enough. Unlike a failed write there is no benign volume of
      // this: every occurrence is one child's records that should be gone.
      threshold: 1,
      evaluationPeriods: 1,
    });

    // A purge that did not happen, on either kind of OCR text.
    //
    // The pipeline's PurgeRedactedOCR task catches into a Pass state, because
    // a finished document must not be marked failed over a cleanup problem.
    // That is the right call and it is why this alarm has to exist: the run
    // ends green, and the DDB service alarm above needs five occurrences in
    // fifteen minutes while one failed purge logs exactly once.
    new logs.MetricFilter(this, 'OcrPurgeFailedFilter', {
      logGroup: ddbServiceFunction.logGroup,
      filterPattern: logs.FilterPattern.literal('OCR_PURGE_FAILED'),
      metricNamespace,
      metricName: 'OcrPurgeFailed',
      metricValue: '1',
      defaultValue: 0,
    });

    this.alarm('OcrPurgeFailedAlarm', {
      copy: ALERT_COPY.OcrPurgeFailedAlarm,
      metric: new cloudwatch.Metric({
        namespace: metricNamespace,
        metricName: 'OcrPurgeFailed',
        statistic: 'Sum',
        period: cdk.Duration.minutes(15),
      }),
      // One document is one child. No benign volume.
      threshold: 1,
      evaluationPeriods: 1,
    });

    this.alarm('DocumentsFailingAlarm', {
      copy: ALERT_COPY.DocumentsFailingAlarm,
      metric: new cloudwatch.Metric({
        namespace: metricNamespace,
        metricName,
        statistic: 'Sum',
        period: cdk.Duration.minutes(15),
      }),
      threshold: DOCUMENT_FAILURE_ALARM_THRESHOLD,
      evaluationPeriods: 1,
      // One failed document clears 15 minutes later on its own; that parent
      // still has no summary. alert-copy.ts marks this alarm countsFailures,
      // so its Slack follow-up says "no new failures", not "resolved".
    });
  }

  /**
   * A requested language left out of a finished document.
   *
   * translate_content leaves a language out when every attempt lost the
   * student placeholder, and the document still finishes in English: the app
   * offers the parent "Translate it now" for the missing language. That is
   * the right outcome for the family, and it is also invisible to every other
   * alarm here (the step succeeds, the run succeeds), so this marker is the
   * only way the team learns a family did not get the language they asked for.
   */
  private addTranslationSkippedAlarm(fns: MonitoredFunction[]): void {
    const translation = fns.find(({ label }) => label === 'translation');
    if (!translation) return;
    const metricNamespace = getMetricNamespace('Pipeline');

    new logs.MetricFilter(this, 'TranslationSkippedFilter', {
      logGroup: translation.fn.logGroup,
      // "TRANSLATION_SKIPPED lang=<code> reason=student_token". Language code
      // only, never content.
      filterPattern: logs.FilterPattern.literal('TRANSLATION_SKIPPED'),
      metricNamespace,
      metricName: 'TranslationSkipped',
      metricValue: '1',
      defaultValue: 0,
    });

    this.alarm('TranslationSkippedAlarm', {
      copy: ALERT_COPY.TranslationSkippedAlarm,
      metric: new cloudwatch.Metric({
        namespace: metricNamespace,
        metricName: 'TranslationSkipped',
        statistic: 'Sum',
        period: cdk.Duration.minutes(15),
      }),
      // One family is enough to want to know about.
      threshold: 1,
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
        copy: COMPONENT_COPY.pipelineStep(label),
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
        copy: COMPONENT_COPY.authTriggerErrors(label),
        metric: fn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 1,
      });
    }
  }

  /**
   * Cognito's fixed 5-second trigger budget, watched as a Duration alarm
   * rather than Errors. A trigger that runs past that budget fails the
   * parent's sign-in the same way a thrown error would, but the Lambda
   * invocation itself keeps running to completion with no exception, so
   * Errors -- what addAuthAlarms above watches -- stays at zero through
   * exactly this failure. See AUTH_TRIGGER_DURATION_ALARM_THRESHOLD_MS for how
   * the threshold was picked.
   *
   * CustomSmsSender is deliberately not alarmed here, for two independent
   * reasons that happen to agree. AWS invokes custom sender triggers
   * ASYNCHRONOUSLY, so the 5-second synchronous budget this alarm exists to
   * protect never applies to it. It is also excluded by construction:
   * createCustomSmsSender wires it directly to the pool and never adds it to
   * authTriggerFunctions, so it is not part of `fns` in the first place.
   */
  private addAuthDurationAlarms(fns: MonitoredFunction[]): void {
    for (const { label, fn } of fns) {
      this.alarm(`AuthTriggerDuration${label.replace(/[^A-Za-z0-9]/g, '')}`, {
        copy: COMPONENT_COPY.authTriggerDuration(label, AUTH_TRIGGER_DURATION_ALARM_THRESHOLD_MS),
        metric: fn.metricDuration({ period: cdk.Duration.minutes(5), statistic: 'Maximum' }),
        threshold: AUTH_TRIGGER_DURATION_ALARM_THRESHOLD_MS,
        evaluationPeriods: 1,
      });
    }
  }

  private addApiAlarms(fns: MonitoredFunction[], httpApi: apigwv2.IHttpApi): void {
    this.alarm('ApiServerErrorAlarm', {
      copy: ALERT_COPY.ApiServerErrorAlarm,
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
        copy: COMPONENT_COPY.apiErrors(label),
        metric: fn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        threshold: 5,
        evaluationPeriods: 1,
      });
      this.alarm(`ApiFunctionThrottles${label.replace(/[^A-Za-z0-9]/g, '')}`, {
        copy: COMPONENT_COPY.apiThrottles(label),
        metric: fn.metricThrottles({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 1,
      });
    }
  }

  /**
   * The passwordless login path: /auth/start, /auth/verify, /auth/token and
   * the dispatcher that sends the code.
   *
   * Watched through markers as well as Errors, for the same reason
   * create-auth-challenge is. Nearly every way these
   * functions turn a parent away is a deliberate 4xx that raises nothing, so
   * Lambda Errors stays flat through a total sign-in outage, and the
   * dispatcher never raises at all: it catches, records the reason on the
   * challenge row, and returns. The markers are the only signal there is.
   */
  private addAuthEndpointAlarms(fns: MonitoredFunction[]): void {
    const metricNamespace = getMetricNamespace('Auth');
    const id = (label: string) => label.replace(/[^A-Za-z0-9]/g, '');

    for (const { label, fn } of fns) {
      this.alarm(`AuthEndpointErrors${id(label)}`, {
        copy: COMPONENT_COPY.authEndpointErrors(label),
        metric: fn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 1,
      });

      // Reserved concurrency is a CAP as well as a floor. Twenty is roughly
      // three orders of magnitude above real demand, so a throttle here means
      // either a flood or a wedged function, and either way a real parent is
      // getting a 429 before any of our code runs.
      this.alarm(`AuthEndpointThrottles${id(label)}`, {
        copy: COMPONENT_COPY.authEndpointThrottles(label),
        metric: fn.metricThrottles({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 1,
      });
    }

    const markerMetric = (filterId: string, logGroup: logs.ILogGroup, marker: string, metricName: string) => {
      new logs.MetricFilter(this, filterId, {
        logGroup,
        // Marker only, and pinned by the lambdas' own unit tests: a reworded
        // log line would disarm the alarm without failing anything.
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

    const byId = (constructId: string) => fns.find(({ fn }) => fn.node.id === constructId);
    const start = byId('AuthStartFunction');
    const verify = byId('AuthVerifyFunction');
    const dispatch = byId('AuthDispatchFunction');
    if (!start || !verify || !dispatch) {
      // By construct id, not by the Slack label: a label lookup that misses
      // returns undefined and would silently create no filter at all, and
      // synth would be perfectly happy. Throwing makes that a build failure.
      throw new Error(
        'MonitoringStack: the auth endpoint list is missing AuthStartFunction, '
        + 'AuthVerifyFunction or AuthDispatchFunction, so the sign-in markers '
        + 'would go unwatched.',
      );
    }

    this.alarm('AuthStartRefusedAlarm', {
      copy: ALERT_COPY.AuthStartRefusedAlarm,
      metric: markerMetric('AuthStartRefusedFilter', start.fn.logGroup, 'AUTH_START_REFUSED', 'AuthStartRefused'),
      // Above the per-source floor of ten an hour, so one parent having a bad
      // day never reaches Slack.
      threshold: 25,
      evaluationPeriods: 1,
    });

    // The one that Lambda Errors can never see. The dispatcher catches
    // everything and records it on the challenge row, so a total SMS or email
    // outage looks like a perfectly healthy function.
    this.alarm('AuthCodeNotSentAlarm', {
      copy: ALERT_COPY.AuthCodeNotSentAlarm,
      metric: markerMetric('AuthDispatchFailedFilter', dispatch.fn.logGroup, 'AUTH_DISPATCH_FAILED', 'AuthDispatchFailed'),
      threshold: 3,
      evaluationPeriods: 1,
    });

    // The guess counter on /auth/verify fails OPEN by design, so a database
    // problem degrades it silently and everything stays green. This is the
    // only thing that says the control is switched off.
    this.alarm('AuthVerifyCounterDegradedAlarm', {
      copy: ALERT_COPY.AuthVerifyCounterDegradedAlarm,
      metric: markerMetric('AuthVerifyCounterFilter', verify.fn.logGroup, 'AUTH_VERIFY_COUNTER_UNAVAILABLE', 'AuthVerifyCounterUnavailable'),
      threshold: 5,
      evaluationPeriods: 1,
    });

    // The one that would have been silent forever. An account created without
    // its password rotated is an account whoever created it can sign into,
    // which is the exact hole the PostConfirmation trigger used to close. The
    // dispatcher is the only thing that creates accounts now, and logs
    // SIGNUP_ORPHANED when it can neither rotate nor remove one.
    this.alarm('SignupPasswordNotRotatedAlarm', {
      copy: ALERT_COPY.SignupPasswordNotRotatedAlarm,
      metric: markerMetric('AuthDispatchOrphanedFilter', dispatch.fn.logGroup, 'SIGNUP_ORPHANED', 'SignupOrphaned'),
      threshold: 1,
      evaluationPeriods: 1,
    });

    // Turnstile is configured out of band, by creating an SSM SecureString,
    // so "deployed" and "switched on" are genuinely different states and the
    // code cannot tell which one it is in. Without this alarm the difference
    // between "the bot check is protecting sign-in" and "the bot check is
    // off" is invisible from anywhere. /auth/start is where it is enforced.
    this.alarm('TurnstileNotConfiguredAlarm', {
      copy: ALERT_COPY.TurnstileNotConfiguredAlarm,
      metric: markerMetric(
        'TurnstileNotConfiguredFilter', start.fn.logGroup,
        'TURNSTILE_NOT_CONFIGURED', 'TurnstileNotConfigured'),
      threshold: 1,
      evaluationPeriods: 1,
    });
  }

  /**
   * Timeouts only. ExecutionsFailed is deliberately absent: see the class
   * docblock. A timeout is NOT caught by RecordFailure, so it is the one
   * state-machine failure that leaves a document stuck with no status change
   * and no parent-visible error.
   */
  private addStateMachineAlarms(sm: stepfunctions.StateMachine): void {
    this.alarm('PipelineTimedOutAlarm', {
      copy: ALERT_COPY.PipelineTimedOutAlarm,
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
      copy: ALERT_COPY.SweepHeartbeatAlarm,
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
      copy: ALERT_COPY.SweepFailingAlarm,
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
   * - SMS spend. Alarmed on velocity and near the ceiling, in production
   *   only, by addSmsSpendAlarms.
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
    const metricNamespace = getMetricNamespace('Auth');

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
      copy: ALERT_COPY.SmsDestinationRefusedAlarm,
      metric: markerMetric('SmsRefusedDestinationFilter', 'SMS_REFUSED_DESTINATION', 'SmsRefusedDestination'),
      // A real parent mistyping a country code is possible but rare, and one
      // refusal should not page. A run produces these in bulk.
      threshold: 10,
      evaluationPeriods: 1,
    });

    this.alarm('SmsBudgetExhaustedAlarm', {
      copy: ALERT_COPY.SmsBudgetExhaustedAlarm,
      metric: markerMetric('SmsBudgetExhaustedFilter', 'SMS_BUDGET_EXHAUSTED', 'SmsBudgetExhausted'),
      // Any occurrence matters: this one only fires when a parent was refused.
      threshold: 1,
      evaluationPeriods: 1,
    });

    this.alarm('SmsSendFailedAlarm', {
      copy: ALERT_COPY.SmsSendFailedAlarm,
      metric: markerMetric('SmsSendFailedFilter', 'SMS_SEND_FAILED', 'SmsSendFailed'),
      threshold: 1,
      evaluationPeriods: 1,
    });

    // The provider-side failure alarm lives in addSmsDeliveryFailureAlarm,
    // not here: it reads an account-level log group and is created once, in
    // production only.
  }

  /**
   * SMS the provider accepted and then did not deliver. Two independent
   * signals, deliberately.
   *
   * The original alarm here watched AWS/SNS NumberOfNotificationsFailed with
   * NO dimensions and sat in OK through the whole 2026-09-09 outage. It was
   * replaced on the reasoning that SNS does not emit that metric for a direct
   * publish dropped at the spend cap.
   *
   * **That reasoning was wrong, and the account's own data says so.** SNS
   * recorded 390 failures in the 19:00 hour on 2026-09-09 and 392 across the
   * day. The metric moved exactly when it should have. What was broken was
   * the dimension: NumberOfNotificationsFailed exists as
   * PhoneNumber=PhoneNumberDirect for SMS-to-a-number, and the zero-dimension
   * series the alarm queried has never had a single datapoint. The right fix
   * was one dimension, not a rewrite, and the metric alarm is restored below
   * with it.
   *
   * Both are kept because they fail in different directions. The metric is
   * account-level and needs no ops step, so it works everywhere and survives
   * someone switching delivery-status logging off. The log filter carries the
   * REASON for each failure and distinguishes a spend cap from a bad number,
   * but exists only where that logging is enabled. Neither one subsumes the
   * other, and this is the alarm that has already been wrong twice.
   *
   * The log group only exists once delivery status logging is switched on,
   * which is an account-level SNS setting and a deliberate ops step. It is
   * shared by both environments (and anything else in the account that
   * texts), which decides the scope of each signal below.
   *
   * `$.delivery.providerResponse` separates a spend cap from a phone that
   * did not answer, and only one of those is worth waking someone.
   *
   * "No quota left for account" is the spend cap: account-wide by
   * definition, so every parent in both environments is locked out at once
   * and the account-level scope is exactly right. It stays a metric filter,
   * in production only (one account-level group, one filter; two would
   * double-count), at threshold 1: the 2026-09-09 outage would have tripped
   * it on its first dropped code. Deliberately NOT attributed to an
   * environment. Once the cap is hit it does not matter whose code hit it,
   * and a cap outage is hundreds of records an hour, which would spend the
   * account's FilterLogEvents rate on lookups whose answer changes nothing.
   *
   * Everything else ("Unknown error attempting to reach phone") is one
   * destination the carrier took and dropped: a landline, a disconnected
   * handset, or an abuse signup on an unroutable number (+1 997... has no
   * such area code). That is per-environment, and until this change it was
   * counted account-wide by a production filter, so a staging test number
   * or another project's SMS could page production and staging never saw
   * its own. It now goes through addSmsFailureClassifier, which attributes
   * each record to the environment that sent it.
   *
   * Both paths exclude COGNITO_SMS_VALIDATION_NUMBER. See its comment: the
   * old single filter paged critical on every deploy that re-applied the
   * pool's SMS settings, which is how it announced itself.
   */
  private addSmsDeliveryFailureAlarm(
    smsSenders: lambda.Function[],
    kmsKey: kms.IKey,
  ): lambda.Function {
    const stack = cdk.Stack.of(this);
    const logGroup = logs.LogGroup.fromLogGroupName(
      this,
      'SmsDeliveryFailureLogGroup',
      `sns/${stack.region}/${stack.account}/DirectPublishToPhoneNumber/Failure`,
    );
    // SNS writes one JSON record per attempt; only FAILURE counts, since
    // successes land in the sibling group at the configured sampling rate.
    const failed = logs.FilterPattern.stringValue('$.status', '=', 'FAILURE');
    const notValidation = logs.FilterPattern.stringValue(
      '$.delivery.destination', '!=', COGNITO_SMS_VALIDATION_NUMBER,
    );
    const quota = `${SMS_QUOTA_PROVIDER_RESPONSE}*`;

    // Per environment: each stack attributes and alarms on its own codes.
    const classifier = this.addSmsFailureClassifier(smsSenders, kmsKey, logGroup,
      logs.FilterPattern.all(
        failed,
        notValidation,
        logs.FilterPattern.stringValue('$.delivery.providerResponse', '!=', quota),
      ));

    // Everything below is account-level, so it exists once, in production.
    // A staging copy watches the same account series, fires at the same
    // moment, and put the same problem in both daily briefs.
    if (this.env !== 'prod') {
      return classifier;
    }

    this.alarm('SmsNotificationsFailedAlarm', {
      copy: ALERT_COPY.SmsNotificationsFailedAlarm,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SNS',
        metricName: 'NumberOfNotificationsFailed',
        // Load-bearing. Without it this queries a series that does not exist.
        dimensionsMap: { PhoneNumber: 'PhoneNumberDirect' },
        statistic: 'Sum',
        period: cdk.Duration.minutes(15),
      }),
      threshold: 1,
      evaluationPeriods: 1,
    });

    new logs.MetricFilter(this, 'SmsQuotaExhaustedFilter', {
      logGroup,
      filterPattern: logs.FilterPattern.all(
        failed,
        notValidation,
        logs.FilterPattern.stringValue('$.delivery.providerResponse', '=', quota),
      ),
      metricNamespace: getMetricNamespace('Auth'),
      metricName: 'SmsQuotaExhausted',
      metricValue: '1',
      defaultValue: 0,
    });

    this.alarm('SmsQuotaExhaustedAlarm', {
      copy: ALERT_COPY.SmsQuotaExhaustedAlarm,
      metric: new cloudwatch.Metric({
        namespace: getMetricNamespace('Auth'),
        metricName: 'SmsQuotaExhausted',
        statistic: 'Sum',
        period: cdk.Duration.minutes(15),
      }),
      // One is enough: the cap is account-wide, so the first parent to hit it
      // means every other parent is already locked out too.
      threshold: 1,
      evaluationPeriods: 1,
      // Quiet for 15 minutes can just mean nobody tried to sign in. The cap
      // is only lifted by raising the limit or by the month rolling over, so
      // alert-copy.ts marks this alarm countsFailures.
    });

    this.addSmsSpendAlarms();
    return classifier;
  }

  /**
   * Which environment sent each undelivered code, so each one alarms on its
   * own.
   *
   *   Failure log group -> subscription filter -> this lambda -> metric
   *
   * The delivery log carries `notification.messageId` and no sender. Both of
   * this service's senders (create-auth-challenge, and staging's
   * custom-sms-sender) log the MessageId SNS returned, so the lambda looks
   * each failed id up in THIS stack's sender log groups and counts only the
   * ones it finds. Staging gets a real twin alarm on its own codes, and
   * production stops paging for a staging test number or another project's
   * SMS in this shared account.
   *
   * One per stack rather than one production classifier attributing both.
   * The sender log groups have CloudFormation-generated names, so production
   * cannot name staging's without a cross-stack lookup, and it would need
   * read access to staging's logs to do it. Per stack, each lambda can read
   * only its own environment's sender logs.
   *
   * **This uses both of the log group's subscription filter slots.** AWS
   * allows two per log group, and the account had none before this
   * (checked 2026-09-28). Anything else in the account that wants to
   * subscribe to this group, or a third environment in this account, will
   * fail to deploy until one of these moves to a shared destination.
   */
  private addSmsFailureClassifier(
    smsSenders: lambda.Function[],
    kmsKey: kms.IKey,
    failureLogGroup: logs.ILogGroup,
    filterPattern: logs.IFilterPattern,
  ): lambda.Function {
    const classifier = new lambda.Function(this, 'SmsFailureClassifierFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(
        path.join(__dirname, '../functions/sms-failure-classifier'),
        { assetHashType: cdk.AssetHashType.SOURCE, exclude: ['__pycache__'] },
      ),
      // A cap outage delivers hundreds of records an hour. Lookups are
      // batched, but FilterLogEvents is rate-limited account-wide and the
      // client backs off, so give it room rather than time out mid-batch.
      timeout: cdk.Duration.minutes(1),
      // Caps how hard both stacks together can hit that shared rate limit.
      // A throttled asynchronous invoke is retried by Lambda, not dropped.
      reservedConcurrentExecutions: 2,
      environment: {
        ENVIRONMENT: this.env,
        SENDER_LOG_GROUPS: smsSenders.map((fn) => fn.logGroup.logGroupName).join(','),
        METRIC_NAMESPACE: getMetricNamespace('Auth'),
        COGNITO_SMS_VALIDATION_NUMBER,
        SMS_QUOTA_PROVIDER_RESPONSE,
      },
      description: 'Attributes undelivered SMS to the environment that sent them',
      logRetention: logs.RetentionDays.ONE_MONTH,
      environmentEncryption: kmsKey,
    });
    tagResource(classifier, { Resource: 'Lambda', Function: 'SmsFailureClassifier' });

    // Read on this environment's senders only: never the other stack's
    // logs, and never a wildcard over /aws/lambda.
    for (const sender of smsSenders) {
      sender.logGroup.grant(classifier, 'logs:FilterLogEvents');
    }
    classifier.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:PutMetricData'],
      // PutMetricData has no resource-level scoping; the namespace condition
      // is the only narrowing IAM offers.
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': getMetricNamespace('Auth') } },
    }));

    // The pattern drops the cap and the validation number before the lambda
    // is ever invoked, so it only runs for records it could count.
    new logs.SubscriptionFilter(this, 'SmsFailureClassifierSubscription', {
      logGroup: failureLogGroup,
      destination: new logsDestinations.LambdaDestination(classifier),
      filterPattern,
    });

    this.alarm('SmsDeliveryFailedAlarm', {
      copy: ALERT_COPY.SmsDeliveryFailedAlarm,
      metric: new cloudwatch.Metric({
        namespace: getMetricNamespace('Auth'),
        metricName: 'SmsDeliveryFailed',
        // The dimension IS the attribution. Without it this would read a
        // series nothing writes.
        dimensionsMap: { Environment: this.env },
        statistic: 'Sum',
        period: cdk.Duration.minutes(15),
      }),
      // Measured on 30 days of the real log: non-quota failures arrive in
      // bursts of at most 2 in a quarter hour, and they are one parent
      // retrying the same dead handset. 4 is the first count that cannot be
      // one person having a bad afternoon. That was measured across both
      // environments, so per environment it is, if anything, generous.
      threshold: 4,
      evaluationPeriods: 1,
    });

    // It catches lookup failures and counts the record anyway (see the
    // handler), so Errors here means it could not publish the count at all:
    // undelivered codes are going uncounted and the alarm above is blind.
    this.alarm('SmsFailureClassifierFailingAlarm', {
      copy: ALERT_COPY.SmsFailureClassifierFailingAlarm,
      metric: classifier.metricErrors({ period: cdk.Duration.minutes(15), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
    });

    return classifier;
  }

  /**
   * SMS spend, watched two ways. Production only: SMSMonthToDateSpentUSD is
   * an account metric with no dimensions, so a staging copy is the same
   * alarm twice.
   *
   * Neither alarms on a fixed dollar figure below the cap. The series is
   * month-cumulative, so a fixed threshold can fire at most once a month and
   * then stays red until the 1st whatever happens next. The $25 alarm this
   * replaces went red on 2026-09-10 and would have stayed there until
   * 2026-10-01, a permanent "1 problem" in both briefs that trained everyone
   * to read past it.
   *
   * - Velocity catches an abuse run while it is happening, and clears on its
   *   own once spend stops climbing.
   * - Near-cap catches everything slower than that, while there is still
   *   room to raise the limit before anyone is locked out.
   */
  private addSmsSpendAlarms(): void {
    // SNS publishes this every five minutes. Maximum, because within a
    // period it only ever goes up (except across the month boundary).
    const spend = (period: cdk.Duration) => new cloudwatch.Metric({
      namespace: 'AWS/SNS',
      metricName: 'SMSMonthToDateSpentUSD',
      statistic: 'Maximum',
      period,
    });

    this.alarm('SmsSpendVelocityAlarm', {
      copy: ALERT_COPY.SmsSpendVelocityAlarm,
      metric: new cloudwatch.MathExpression({
        // RATE is the change between consecutive datapoints divided by the
        // seconds between them, so a gap in the series stretches the divisor
        // rather than inventing a spike. At the month reset spend drops to
        // zero, RATE goes negative, and a greater-than alarm cannot trip on
        // it.
        expression: 'RATE(spend) * 3600',
        usingMetrics: { spend: spend(cdk.Duration.minutes(5)) },
        // Five minutes, not an hour: the 2026-09-09 attack spent $49 inside
        // a single five-minute datapoint, and an hourly period would report
        // it after the hour closed.
        period: cdk.Duration.minutes(5),
        label: 'SMS spend, dollars per hour',
      }),
      threshold: SMS_SPEND_VELOCITY_ALARM_USD_PER_HOUR,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      // Any one breaching point in the last 15 minutes holds it in ALARM, so
      // it clears after a quarter hour of normal spend rather than flapping
      // between the bursts of one run.
      evaluationPeriods: 3,
      datapointsToAlarm: 1,
    });

    const nearCapUsd = SMS_MONTHLY_LIMIT_USD * SMS_NEAR_CAP_FRACTION;
    this.alarm('SmsSpendNearCapAlarm', {
      copy: smsSpendNearCap(Math.round(SMS_NEAR_CAP_FRACTION * 100)),
      metric: spend(cdk.Duration.minutes(15)),
      threshold: nearCapUsd,
      evaluationPeriods: 1,
    });
  }

  /**
   * A parent asked us to delete their records and we only partly did.
   *
   * Watched through a marker rather than Errors, for the usual reason: these
   * handlers catch and return an HTTP status, so Errors stays flat. It used to
   * be worse than flat. Every deletion step was wrapped in its own try/except
   * that printed and continued, and the handler returned 200 'successfully
   * deleted' regardless, so a failed S3 purge or a failed row delete told the
   * parent their child's records were gone when they were still there.
   *
   * Split by essential/non-essential because the two need different
   * responses. An essential survivor means FERPA-protected content still
   * exists after someone asked for it to go, and needs a person. A
   * non-essential one (a cached mp3, a referral row) is worth knowing and is
   * not worth waking anyone.
   */
  private addDeletionAlarms(
    apiFunctions: MonitoredFunction[],
    ddbServiceFunction: lambda.Function,
  ): void {
    const metricNamespace = getMetricNamespace('Pipeline');
    // The DDB service is the third emitter: after a re-upload finishes it
    // deletes the child's older documents (purge_replaced_documents) and logs
    // the same marker, scope=replaced-document, when any of that survived. The
    // new document is already complete by then, so the log line is the only
    // way anyone learns an old IEP is still in the bucket.
    const watched: Array<{ label: string; fn: lambda.Function }> = [
      ...apiFunctions.filter((f) =>
        f.label === 'user profile' || f.label === 'document delete'),
      { label: 'replaced documents', fn: ddbServiceFunction },
    ];

    for (const { label, fn } of watched) {
      new logs.MetricFilter(this, `DeletionIncompleteFilter${label.replace(/[^A-Za-z0-9]/g, '')}`, {
        logGroup: fn.logGroup,
        // Both halves must match: the marker AND essential=yes. A metric
        // filter on the marker alone would page for an orphaned mp3.
        filterPattern: logs.FilterPattern.allTerms('DELETION_INCOMPLETE', 'essential=yes'),
        metricNamespace,
        metricName: 'DeletionIncompleteEssential',
        metricValue: '1',
        defaultValue: 0,
      });
    }

    this.alarm('DeletionIncompleteAlarm', {
      copy: ALERT_COPY.DeletionIncompleteAlarm,
      metric: new cloudwatch.Metric({
        namespace: metricNamespace,
        metricName: 'DeletionIncompleteEssential',
        statistic: 'Sum',
        period: cdk.Duration.minutes(15),
      }),
      // One is enough: there is no benign volume of a deletion that did not
      // happen.
      threshold: 1,
      evaluationPeriods: 1,
    });
  }

  /**
   * The on-demand translation machine, and the account's KMS call volume.
   *
   * Translation is foreground work: a parent taps "translate it now" and
   * waits, so a failure here is felt immediately rather than discovered on a
   * later visit. It had no alarm at all until now, despite being the flow
   * most likely to strand someone mid-task.
   */
  private addTranslationAndUsageAlarms(translationStateMachine: stepfunctions.StateMachine): void {
    this.alarm('TranslationRunsFailingAlarm', {
      copy: ALERT_COPY.TranslationRunsFailingAlarm,
      metric: translationStateMachine.metricFailed({
        period: cdk.Duration.minutes(15),
        statistic: 'Sum',
      }),
      threshold: 3,
      evaluationPeriods: 1,
    });

    // Not an application signal. Between 2026-09-08 and 2026-09-10 a
    // monitoring agent swept lambda:ListFunctions on a timer, and because
    // that call decrypts every function's environment variables it produced
    // roughly 22,000 KMS Decrypts an hour for a day and a half before anyone
    // noticed. Harmless, but it is the shape a runaway loop makes, and it
    // cost more to find than it did to run.
    this.alarm('KmsCallVolumeAlarm', {
      copy: ALERT_COPY.KmsCallVolumeAlarm,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Usage',
        metricName: 'CallCount',
        dimensionsMap: {
          Type: 'API',
          // NOT 'Decrypt'. AWS/Usage has no per-operation Resource for KMS
          // data-plane calls: it buckets every symmetric encrypt/decrypt/
          // generate-data-key into this one name. Resource=Decrypt matches no
          // series at all, so the first version of this alarm queried an
          // empty metric and sat green through the exact runaway it was
          // written for -- 32,101 calls in the 16:00 hour on 2026-09-08
          // against a threshold of 10,000. Verified with list-metrics: the
          // only KMS API Resource values in this account are
          // CryptographicOperationsSymmetric, CreateGrant, RetireGrant,
          // DescribeKey, GetKeyPolicy, GetKeyRotationStatus, ListAliases,
          // ListKeys and ListResourceTags.
          Resource: 'CryptographicOperationsSymmetric',
          Service: 'KMS',
          Class: 'None',
        },
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      // Measured on the real series, not guessed. With the sweeping agent
      // switched off (06:00 UTC on 2026-09-10) this account runs 50-800 an
      // hour; the sweep itself ran 22,000-32,000. 10,000 sits an order of
      // magnitude above normal and well below the thing it has to catch.
      threshold: 10000,
      evaluationPeriods: 1,
    });
  }

  private addAbuseAlarms(authTriggers: MonitoredFunction[]): void {
    const preSignUp = authTriggers.find((f) => f.label.startsWith('PreSignUp'));
    if (preSignUp) {
      // Attempts on a destination someone could receive a message on. A
      // fictional destination (pre-sign-up.js, destination.js) reaches no one
      // and costs nothing, so counting it paged a "flood" of 32 test accounts
      // on 2026-10-20 with not one text sent.
      const metricNamespace = getMetricNamespace('Auth');
      new logs.MetricFilter(this, 'SignupAttemptReachableFilter', {
        logGroup: preSignUp.fn.logGroup,
        // Marker only, pinned by pre-sign-up.test.js on the lambda side.
        filterPattern: logs.FilterPattern.allTerms('SIGNUP_ATTEMPT', 'destination=reachable'),
        metricNamespace,
        metricName: 'SignupAttemptsReachable',
        metricValue: '1',
        defaultValue: 0,
      });
      this.alarm('SignupSurgeAlarm', {
        copy: ALERT_COPY.SignupSurgeAlarm,
        metric: new cloudwatch.Metric({
          namespace: metricNamespace,
          metricName: 'SignupAttemptsReachable',
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
        threshold: 20,
        evaluationPeriods: 1,
      });

      // The backstop for what the alarm above leaves out: every attempt,
      // fictional destinations included. Above a full E2E run (32 in 5
      // minutes), so only a flood of them pages.
      this.alarm('SignupVolumeBackstopAlarm', {
        copy: ALERT_COPY.SignupVolumeBackstopAlarm,
        metric: preSignUp.fn.metricInvocations({
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 150,
        evaluationPeriods: 1,
      });
    }

    // SMS spend is alarmed in addSmsSpendAlarms: it is an account metric, so
    // it is created once, in production only.
  }

  private addTableThrottleAlarms(
    tables: { readonly label: string; readonly table: dynamodb.ITable }[],
  ): void {
    for (const { label, table } of tables) {
      this.alarm(`TableThrottle${label.replace(/[^A-Za-z0-9]/g, '')}`, {
        copy: COMPONENT_COPY.tableThrottle(label),
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
