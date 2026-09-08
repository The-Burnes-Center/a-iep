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
import { getEnvironment, getResourceName, tagResource } from '../../tags';

/**
 * Outage alerting: CloudWatch alarms -> SNS -> AWS Chatbot -> Slack #a-iep-dev.
 *
 * Before this, nothing in AWS noticed an outage. The only automated signals
 * were two nightly GitHub Actions digests, so a prod failure at 02:00 waited
 * for a parent to report it.
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
 * 2. **The alarm description is the Slack message.** AWS Chatbot renders
 *    alarmDescription in its card, and nothing else here carries context. So
 *    each description says what broke, who it affects, and what to look at,
 *    rather than restating the metric.
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
}

export class MonitoringStack extends Construct {
  /** Subscribe AWS Chatbot to this to land alarms in Slack. */
  public readonly alarmTopic: sns.Topic;
  /** Every alarm created, so test/infra can assert the set. */
  public readonly alarms: cloudwatch.Alarm[] = [];

  private readonly env: string;

  constructor(scope: Construct, id: string, props: MonitoringProps) {
    super(scope, id);
    this.env = getEnvironment();

    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: getResourceName('a-iep-alarms'),
      displayName: `A-IEP ${this.env} alarms`,
    });
    tagResource(this.alarmTopic, { Resource: 'SNSTopic', Function: 'AlarmTopic' });

    this.addDocumentFailureAlarm(props.ddbServiceFunction);
    this.addPipelineStepAlarms(props.pipelineFunctions);
    this.addAuthAlarms(props.authTriggerFunctions);
    this.addApiAlarms(props.apiFunctions, props.httpApi);
    this.addStateMachineAlarms(props.iepProcessingStateMachine);
    this.addSweepHeartbeatAlarm(props.pendingUploadSweepRule);
    this.addTableThrottleAlarms(props.tables);

    new cdk.CfnOutput(this, 'AlarmTopicArn', { value: this.alarmTopic.topicArn });
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
    alarm.addAlarmAction(new actions.SnsAction(this.alarmTopic));
    // Recovery is as newsworthy as the failure: without this, Slack shows an
    // outage starting and never ending.
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

    this.alarm('DocumentsFailingAlarm', {
      name: 'document pipeline failing',
      description:
        'Three or more IEP documents failed processing within fifteen minutes. ' +
        'Parents see an error screen and a re-upload button. ' +
        'To triage: the RECORD_FAILURE lines in the ddb-service log group name ' +
        'the failing stage (step=), and the sanitized event dump above each one ' +
        'gives the exception class. A ValidationError points at our own schema, ' +
        'an API or timeout error at a third party (Mistral OCR, OpenAI, ' +
        'Comprehend), which is the usual cause. The full error text is not in ' +
        'the logs by design; it is on the document row in DynamoDB. If a ' +
        'per-step alarm also fired, that stage crashed outright.',
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
          `The ${label} step of the document pipeline threw more than one ` +
          "document's worth of errors. Every document reaching this stage is " +
          'likely failing, and each one shows its parent an error. Look at this ' +
          'stage first, and at its upstream third party if it calls one. A ' +
          'single unreadable PDF does NOT reach this threshold; if only one ' +
          'parent is affected, the document-pipeline alarm is the one to watch.',
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
          `The ${label} Cognito trigger threw. Depending on the trigger this ` +
          'blocks login, blocks signup, or stops the SMS code being sent, so ' +
          'treat it as families being locked out rather than as a background ' +
          'error. Check the trigger log group, and SNS SMS delivery if it is ' +
          'CreateAuthChallenge.',
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
        'The HTTP API returned five or more server errors in five minutes. ' +
        'Parents cannot load summaries, save a profile or start an upload. ' +
        'Check the request-path lambda alarms and the API access logs.',
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
          `The ${label} lambda threw on the request path. Whatever part of the ` +
          'app calls it is broken for every parent using it right now.',
        metric: fn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        threshold: 5,
        evaluationPeriods: 1,
      });
      this.alarm(`ApiFunctionThrottles${label.replace(/[^A-Za-z0-9]/g, '')}`, {
        name: `API handler throttled: ${label}`,
        description:
          `The ${label} lambda is being throttled, so requests are failing for ` +
          'capacity reasons rather than bugs. Check concurrency limits.',
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
        'A document pipeline execution hit its six-hour timeout. Unlike every ' +
        'other pipeline failure this is NOT caught into RecordFailure, so the ' +
        'document keeps whatever status it had and the parent is left on the ' +
        'processing screen indefinitely. Find the execution, then fail the row ' +
        'closed by hand.',
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
        'The 10-minute pending-upload sweep has not run for 30 minutes. While ' +
        'it is down, an upload that never reaches S3 is never failed closed, so ' +
        'the parent sits on "we are processing your document" indefinitely with ' +
        'no error and no way to retry. Check the EventBridge rule is enabled ' +
        'and the ddb-service lambda is healthy.',
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
        'EventBridge could not invoke the pending-upload sweep. Same parent ' +
        'impact as the sweep stopping: stalled uploads are never failed closed. ' +
        'Usually an IAM or permission change on the ddb-service lambda.',
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

  private addTableThrottleAlarms(
    tables: { readonly label: string; readonly table: dynamodb.ITable }[],
  ): void {
    for (const { label, table } of tables) {
      this.alarm(`TableThrottle${label.replace(/[^A-Za-z0-9]/g, '')}`, {
        name: `DynamoDB throttling: ${label}`,
        description:
          `The ${label} table is throttling requests. Reads and writes are ` +
          'failing intermittently, which surfaces to parents as random errors ' +
          'rather than a clean outage, so it is easy to misdiagnose.',
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
