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
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
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

/**
 * How urgent this alarm is, which is the only thing that decides its colour
 * in Slack.
 *
 * - `critical`: families cannot use the service right now. Red.
 * - `medium`:   something is degraded, or is heading for critical if left.
 *               Yellow.
 * - `low`:      worth knowing, nothing is broken. Green.
 *
 * Assigned per alarm rather than derived, because urgency is a judgement
 * about what a parent experiences and no metric carries it. It is required,
 * so a new alarm cannot quietly default into the wrong tier.
 *
 * It reaches the formatter as a prefix on the alarm description, which is the
 * only field CloudWatch carries into the SNS payload that we control. The
 * formatter strips it, so no reader ever sees the marker. Splitting the tiers
 * across separate SNS topics would be tidier and is the upgrade path if these
 * ever need to reach different Slack channels; it is not worth three topics
 * while they all land in one.
 */
export type Severity = 'critical' | 'medium' | 'low';

const PIPELINE_STEP_RETRY_INVOCATIONS = 4;
const PIPELINE_STEP_ERROR_THRESHOLD = PIPELINE_STEP_RETRY_INVOCATIONS + 1;

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
   * The signup endpoint. Separate from the lists above because it is the ONLY
   * way to create an account: Cognito's public SignUp API is closed
   * (AllowAdminCreateUserOnly), so if this is down, nobody can join at all.
   *
   * It had no alarms of any kind for its first day of life, which is how the
   * front door ends up being the least-watched thing in the system: it was
   * built during an incident, wired into the API, and never added to a list.
   */
  readonly signupFunction: MonitoredFunction;
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
    this.addSmsDeliveryFailureAlarm();
    this.addSignupPathAlarms(props.signupFunction);
    this.addTranslationAndUsageAlarms(props.translationStateMachine);
    this.addDailyBrief(props.kmsKey, [
      ...props.pipelineFunctions,
      ...props.authTriggerFunctions,
      ...props.apiFunctions,
      props.signupFunction,
    ].map(({ label, fn, purpose }) => ({
      label,
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
      severity: 'low',
      name: 'the daily health brief has stopped running',
      description:
        'The once-a-day summary did not go out, so "no news" no longer means ' +
        'anything. Nothing is broken for families.',
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
      severity: 'medium',
      name: 'the daily health brief is failing',
      description:
        'The once-a-day summary ran but could not be sent, so "no news" no ' +
        'longer means anything. Nothing is broken for families.',
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
    this.alarmTopic.addSubscription(new subscriptions.LambdaSubscription(formatter));

    this.alarm('AlertFormatterFailingAlarm', {
      severity: 'critical',
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

    // The alarm above only covers a formatter that runs and raises. It says
    // nothing about a formatter that is never CALLED: if this subscription is
    // deleted, the invoke permission is lost, or SNS gives up retrying, then
    // Errors stays at zero forever and every alarm in this file is silently
    // dropped on the way to Slack. The channel goes quiet and quiet is
    // exactly what it means when nothing is wrong.
    //
    // Also straight to alertTopic, for the same reason as above.
    this.alarm('AlertDeliveryFailingAlarm', {
      severity: 'critical',
      name: 'alerts are not reaching the formatter',
      description:
        'Alarms fired but could not be delivered for formatting, so they ' +
        'never reached Slack. The channel looks quiet while something may be ' +
        'wrong. Check CloudWatch alarms directly until this is fixed.',
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
    opts: {
      name: string;
      description: string;
      severity: Severity;
      metric: cloudwatch.IMetric;
      threshold: number;
      evaluationPeriods: number;
      comparisonOperator?: cloudwatch.ComparisonOperator;
      /** Defaults to evaluationPeriods (all of them must breach). */
      datapointsToAlarm?: number;
      treatMissingData?: cloudwatch.TreatMissingData;
      /** Defaults to alarmTopic (via the formatter). Only the formatter's own
       *  alarm overrides this, to bypass the component it is reporting on. */
      topic?: sns.Topic;
    },
  ): cloudwatch.Alarm {
    const alarm = new cloudwatch.Alarm(this, id, {
      // Named for a human reading Slack at 2am, not for the metric.
      alarmName: `${getResourceName('a-iep')} ${opts.name}`,
      // The marker the formatter reads and strips; see Severity.
      alarmDescription: `[${opts.severity}] ${opts.description}`,
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
      severity: 'medium',
      name: 'the pipeline cannot write to its database',
      description:
        'Document progress, failures or cleanup are not being recorded. A ' +
        'parent may see a progress bar that never moves, or an upload that ' +
        'never reports what went wrong.',
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
      severity: 'critical',
      name: 'a failed document kept its unredacted copy',
      description:
        'A document failed and the original upload or raw OCR could not be ' +
        'deleted, so unredacted student information is still stored. It ' +
        'needs removing by hand.',
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

    this.alarm('DocumentsFailingAlarm', {
      severity: 'medium',
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
        severity: 'medium',
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
        severity: 'critical',
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
      severity: 'critical',
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
        severity: 'medium',
        name: `API handler failing: ${label}`,
        description:
          `The ${label} part of the app is broken for everyone using it now.`,
        metric: fn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        threshold: 5,
        evaluationPeriods: 1,
      });
      this.alarm(`ApiFunctionThrottles${label.replace(/[^A-Za-z0-9]/g, '')}`, {
        severity: 'medium',
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
      severity: 'medium',
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
      severity: 'medium',
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
      severity: 'medium',
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
      severity: 'medium',
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
      severity: 'critical',
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
      severity: 'critical',
      name: 'login codes are not being delivered',
      description:
        'Sending a login code is failing outright, so no parent can sign in. ' +
        'This is the alarm the trigger error alarms cannot raise, because a ' +
        'failed send is reported to the app rather than thrown.',
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
   * created in production only, for the same reason as the role: one
   * account-level log group, one filter. Two would double-count every
   * failure, since staging and production share it.
   *
   * Threshold is 1. A document may fail for benign reasons and a rate makes
   * sense there; an undelivered login code has no benign volume, because
   * every one of them is a parent who cannot get in.
   */
  private addSmsDeliveryFailureAlarm(): void {
    // The metric alarm is account-level but harmless to duplicate: unlike the
    // log filter it creates no shared resource, and both environments benefit
    // from seeing it. Staging alarms are informational by design.
    this.alarm('SmsNotificationsFailedAlarm', {
      severity: 'critical',
      name: 'the SMS provider is rejecting login codes',
      description:
        'SNS is failing to send login codes, so parents are told a code is ' +
        'coming and none arrives. Usually the monthly SMS spend cap, which ' +
        'stops delivery for everyone until it is raised.',
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

    if (this.env !== 'prod') {
      return;
    }
    const stack = cdk.Stack.of(this);
    const metricNamespace = 'AI-IEP/Auth';
    const metricName = 'SmsDeliveryFailed';

    new logs.MetricFilter(this, 'SmsDeliveryFailureFilter', {
      logGroup: logs.LogGroup.fromLogGroupName(
        this,
        'SmsDeliveryFailureLogGroup',
        `sns/${stack.region}/${stack.account}/DirectPublishToPhoneNumber/Failure`,
      ),
      // SNS writes one JSON record per attempt; only FAILURE counts, since
      // successes land in the sibling group at the configured sampling rate.
      filterPattern: logs.FilterPattern.stringValue('$.status', '=', 'FAILURE'),
      metricNamespace,
      metricName,
      metricValue: '1',
      defaultValue: 0,
    });

    this.alarm('SmsDeliveryFailedAlarm', {
      severity: 'critical',
      name: 'login codes are being accepted and then not delivered',
      description:
        'The SMS provider took the message and dropped it, so a parent is ' +
        'told a code is coming and none arrives. Usually the monthly SMS ' +
        'spend cap, which stops delivery for everyone until it is raised.',
      metric: new cloudwatch.Metric({
        namespace: metricNamespace,
        metricName,
        statistic: 'Sum',
        period: cdk.Duration.minutes(15),
      }),
      threshold: 1,
      evaluationPeriods: 1,
    });
  }

  /**
   * The signup endpoint: the only way to create an account.
   *
   * Watched through markers as well as Errors, for the same reason
   * create-auth-challenge is. Nearly every way this function turns a family
   * away is a deliberate, correct REFUSAL that returns 4xx and raises
   * nothing, so Lambda Errors stays flat through a total signup outage. A
   * Turnstile outage in particular refuses every signup as a 403, which is
   * not counted by the API's 5xx alarm either.
   *
   * Refusals are also the leading indicator of abuse, and they arrive while
   * an attack is happening rather than after the money is gone. The
   * pre-existing signup alarm counts PreSignUp invocations, i.e. signups that
   * SUCCEEDED, so it can only see an attack that got through.
   */
  private addSignupPathAlarms(signup: MonitoredFunction): void {
    const metricNamespace = 'AI-IEP/Auth';

    this.alarm('SignupEndpointErrorsAlarm', {
      severity: 'critical',
      name: 'signup broken: nobody can create an account',
      description:
        'The signup endpoint is failing. Cognito\'s own signup is closed, so ' +
        'this is the only way to join: no new family can create an account.',
      metric: signup.fn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
    });

    this.alarm('SignupEndpointThrottledAlarm', {
      severity: 'critical',
      name: 'signup throttled: nobody can create an account',
      description:
        'The signup endpoint is being throttled, so new families are turned ' +
        'away. Failing on capacity, not on a bug.',
      metric: signup.fn.metricThrottles({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
    });

    const markerMetric = (id: string, marker: string, metricName: string) => {
      new logs.MetricFilter(this, id, {
        logGroup: signup.fn.logGroup,
        // Marker only, and pinned by the lambda's own unit tests: a reworded
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

    this.alarm('SignupRefusedAlarm', {
      severity: 'medium',
      name: 'sign-ups are being refused in bulk',
      description:
        'Sign-ups are being turned away by the rate limits or the bot check. ' +
        'Either an abuse run is under way and the limits are holding, or the ' +
        'limits are too tight and real families cannot join.',
      metric: markerMetric('SignupRefusedFilter', 'SIGNUP_REFUSED', 'SignupRefused'),
      // Deliberately above the per-source floor of 3/hour, so one family
      // mistyping their number twice never reaches Slack.
      threshold: 10,
      evaluationPeriods: 1,
    });

    this.alarm('SignupFailedAlarm', {
      severity: 'critical',
      name: 'signup broken: accounts are not being created',
      description:
        'Sign-ups are reaching Cognito and failing there. Families are ' +
        'filling in the form and being told it did not work.',
      metric: markerMetric('SignupFailedFilter', 'SIGNUP_FAILED', 'SignupFailed'),
      threshold: 3,
      evaluationPeriods: 1,
    });

    // The one that would have been silent forever. An account created without
    // its password rotated is an account whoever created it can sign into,
    // which is the exact hole the PostConfirmation trigger used to close.
    this.alarm('SignupPasswordNotRotatedAlarm', {
      severity: 'critical',
      name: 'new accounts may be reachable by whoever created them',
      description:
        'An account was created but could not be secured afterwards, and ' +
        'removing it also failed. Until this is cleared, treat accounts ' +
        'created now as untrusted.',
      metric: markerMetric('SignupOrphanedFilter', 'SIGNUP_ORPHANED', 'SignupOrphaned'),
      threshold: 1,
      evaluationPeriods: 1,
    });

    // Turnstile is configured out of band, by creating an SSM SecureString,
    // so "deployed" and "switched on" are genuinely different states and the
    // code cannot tell which one it is in. Without this alarm the difference
    // between "the bot check is protecting signup" and "the bot check is off"
    // is invisible from anywhere.
    this.alarm('TurnstileNotConfiguredAlarm', {
      severity: 'medium',
      name: 'the signup bot check is switched off',
      description:
        'Sign-ups are being accepted without the bot check, because its ' +
        'secret is missing. The rate limits still apply; the defence that ' +
        'stops a script does not.',
      metric: markerMetric(
        'TurnstileNotConfiguredFilter', 'TURNSTILE_NOT_CONFIGURED', 'TurnstileNotConfigured'),
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
      severity: 'medium',
      name: 'on-demand translations are failing',
      description:
        'A parent asked for a translation and it errored. They are left on ' +
        'the page waiting for something that will not arrive.',
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
      severity: 'low',
      name: 'unusual AWS API volume',
      description:
        'Something is calling AWS far more than this service normally does. ' +
        'Nothing is broken for families; this is usually a script or an ' +
        'agent left running.',
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
      this.alarm('SignupSurgeAlarm', {
        severity: 'critical',
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
      severity: 'medium',
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
        severity: 'critical',
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
