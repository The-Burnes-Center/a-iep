import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as path from 'path';
import { getEnvironment, getResourceName, tagResource } from '../../tags';
import { createIepDataDenyStatement } from '../security';
import type { Severity } from '../monitoring/monitoring';

/**
 * Everything needed to send an email safely, before anything sends one.
 *
 * A-IEP is moving login from password to a six-digit code on either a phone
 * or an email address. The SMS half of that already exists. This is the
 * email half's abuse protection, and it ships BEFORE the feature because
 * email fails worse than SMS did.
 *
 * The 2026-09-09 SMS-pumping run burned a $50 monthly cap in thirteen
 * minutes and took login down for both environments. That cap self-heals:
 * the calendar month rolls over and sending resumes with nobody involved.
 * The email equivalent does not. Spraying signups at addresses an attacker
 * invents produces bounces; spraying at addresses they own produces
 * complaints; and at a bad enough rate AWS puts the account under review and
 * can pause sending. Getting that reversed is an appeal, not a wait.
 *
 * Two facts about this account make it worse, and both were checked against
 * the live account rather than assumed:
 *
 *  1. `a-iep.org` is verified and can send today (production access granted,
 *     50,000/day, 14/second). Nothing in A-IEP uses SES yet, so the first
 *     email this service sends will be an OTP.
 *  2. **The account is shared.** Other projects have identities verified in
 *     the same account and region, and SES reputation and enforcement are
 *     per-ACCOUNT, not per-identity. So sending problems here can affect
 *     their mail, and theirs can affect this service's login. Both
 *     directions are alarmed below.
 *
 * ## What this construct owns
 *
 *  - A configuration set, so every OTP is sent through one place that
 *    publishes events and can be reasoned about.
 *  - Event destinations for Bounce, Complaint, Reject and DeliveryDelay:
 *    to SNS (so the suppression list is maintained) and to CloudWatch (so
 *    counts are alarmable, dimensioned by configuration set, which is how we
 *    tell A-IEP's mail apart from the rest of the account's).
 *  - A suppression list in DynamoDB, and the handler that maintains it.
 *  - The reputation alarms.
 *
 * ## What it deliberately does NOT own
 *
 * **The identity.** `a-iep.org` was verified out of band and is shared with
 * other projects in this account. Declaring an `ses.EmailIdentity` here would
 * hand a live, shared, already-verified identity to CloudFormation, which
 * would then own its deletion. That is the same shape as the 2026-06-22
 * bucket rename. The identity is referenced by ARN, for IAM only.
 *
 * **A default configuration set on the identity.** It would be the stronger
 * control (SES would apply the configuration set even to a send that forgot
 * to name it) but staging and production share ONE domain identity and would
 * each want their own configuration set on it. Two stacks fighting over one
 * account-level setting, flipping it on every deploy, is worse than the gap.
 *
 * Be clear about how big that gap is, because it is easy to read as smaller
 * than it is. The alternative to naming our configuration set is NOT plain
 * SES. `a-iep.org` already carries a default configuration set,
 * `my-first-configuration-set`, which belongs to another project in this
 * account and has zero event destinations. So a send that omits
 * `ConfigurationSetName` does not fail and does not degrade: it succeeds, it
 * counts against the shared account's reputation, and its bounces and
 * complaints are routed nowhere and discarded. Nothing would ever reach the
 * suppression list, and nothing would say so.
 *
 * That makes the unit test pinning `ConfigurationSetName` on every SendEmail
 * call the control itself rather than a nicety. It is mutation-checked.
 *
 * ## Why our own suppression list, when SES already has one
 *
 * The account-level SES suppression list is on for BOUNCE and COMPLAINT
 * today. It is not enough, for three reasons:
 *
 *  1. It is account-level, so it is shared with the other two projects, and
 *     any of them can change or clear it without us knowing.
 *  2. It suppresses INSIDE SES. The `SendEmail` call succeeds, SES counts a
 *     Send, and drops the message. The parent is told a code is on its way
 *     and none arrives -- exactly the failure mode the SMS outage had, where
 *     the provider accepted messages and dropped them. Our list refuses
 *     BEFORE the API call, so the app can say something true.
 *  3. It cannot be tested. This one has unit tests, including that it fails
 *     closed.
 */

/** The verified domain. Verified out of band; see the class docblock. */
const MAIL_DOMAIN = 'a-iep.org';

/** Envelope sender. A mailbox nobody reads, which is what a login code is. */
const DEFAULT_FROM_ADDRESS = `no-reply@${MAIL_DOMAIN}`;

// ── Bounce and complaint thresholds ─────────────────────────────────────
//
// AWS's own enforcement thresholds, which are what a suspension is measured
// against:
//
//   bounce rate     >= 5%    account under review
//                   >= 10%   sending may be paused
//   complaint rate  >= 0.1%  account under review
//                   >= 0.5%  sending may be paused
//
// Three things make "alarm just under AWS's number" the wrong answer here.
//
// **Our volume is tiny, so the rate is quantised.** A-IEP sends one code per
// sign-in, on the order of a few dozen a day. At 20 messages in the trailing
// window a SINGLE bounce is a 5% rate, already AWS's review threshold, and a
// single complaint is 5%, fifty times it. A rate alarm set at "40% of AWS's
// number" therefore fires on one parent's typo, and an alarm that fires on
// one typo is an alarm everybody learns to skim past.
//
// **The rate is a lagging signal exactly when it matters.** During a spray
// run of thousands of messages the count moves in seconds and the trailing
// rate crawls up behind it. By the time the rate says 2%, the damage that
// decides the suspension is already done.
//
// **Recovery is not automatic.** The SMS cap resets on the 1st. A paused SES
// account is an appeal to AWS, so the alarm has to fire while there is still
// headroom to act rather than at the boundary.
//
// So: rate alarms for the slow burn, calibrated as a fraction of AWS's
// thresholds with the review tier at roughly 40-50% and the critical tier at
// 70-80% (leaving a fifth to a third of the budget to act in), AND absolute
// count alarms for the fast case, which are the ones an attack will trip.
// Neither subsumes the other, in the same way the two SMS delivery-failure
// signals in monitoring.ts do not.
const BOUNCE_RATE_REVIEW = 0.02; // 2%: 40% of AWS's 5%
const BOUNCE_RATE_CRITICAL = 0.035; // 3.5%: 70% of AWS's 5%
const COMPLAINT_RATE_REVIEW = 0.0005; // 0.05%: 50% of AWS's 0.1%
const COMPLAINT_RATE_CRITICAL = 0.0008; // 0.08%: 80% of AWS's 0.1%

// Absolute counts, scoped to A-IEP's configuration set.
//
// A parent gets ONE code per sign-in attempt, to an address that already has
// an account. Five bounces inside fifteen minutes is not a run of typos; it
// is somebody feeding us addresses. At real volume this fires at five, and
// during a spray it fires almost immediately, long before any rate moves.
const BOUNCE_COUNT_BURST = 5;

// A transactional login code has no honest complaint volume. One complaint
// means we mailed a code to somebody who did not ask for one, which is the
// signal that matters most and the one that costs the most per event
// (AWS's complaint budget is fifty times tighter than its bounce budget).
const COMPLAINT_COUNT_ANY = 1;

// SES refusing to send at all: it accepted the call and then declined the
// message, which for transactional mail means something is wrong with what
// we are sending, not with who we are sending it to.
const REJECT_COUNT_ANY = 1;

// A receiving server deferring us. Three rather than one because a single
// delay is one provider having a bad minute, while three in a quarter hour is
// a provider throttling us, which is the polite first stage of a reputation
// problem. It is also the only email failure mode invisible from the bounce
// and complaint series: the code usually still arrives, just late enough that
// a parent has given up and asked for another.
const DELIVERY_DELAY_COUNT = 3;

/**
 * A hard bounce is permanent, so its suppression row is permanent. A
 * transient one (full mailbox, a receiving server having a bad day) is not,
 * and suppressing on the first would lock a parent out of their own account
 * because their inbox was full on a Tuesday. Three inside the retention
 * window is a pattern rather than a bad day.
 *
 * Kept in the CDK so it is visible next to the alarms it interacts with, and
 * passed to the handler as an environment variable rather than compiled in.
 */
const TRANSIENT_BOUNCES_BEFORE_SUPPRESSION = 3;

/** How long an unsuppressed transient-bounce tally survives. */
const TRANSIENT_BOUNCE_TTL_DAYS = 30;

export interface EmailIdentityProps {
  /**
   * Where alarms go. Deliberately the RAW alarm topic, so these travel the
   * same alarms -> formatter -> alerts -> Slack path as everything else and
   * arrive with an impact line rather than as a metric dump.
   */
  readonly alarmTopic: sns.ITopic;
  /**
   * The application CMK. Encrypts the suppression table and the handler's
   * environment; test/infra pins every ChatbotAPI lambda to it.
   */
  readonly kmsKey: kms.IKey;
  /** Overridable for tests. @default no-reply@a-iep.org */
  readonly fromAddress?: string;
}

export class EmailIdentityStack extends Construct {
  /** Named explicitly by every send. See the class docblock. */
  public readonly configurationSet: ses.ConfigurationSet;
  public readonly configurationSetName: string;
  /** Addresses we have promised never to mail again. Read before every send. */
  public readonly suppressionTable: dynamodb.Table;
  /** Maintains the list from SES bounce and complaint events. */
  public readonly bounceHandler: lambda.Function;
  /** SES publishes bounce/complaint/reject/delay events here. */
  public readonly eventTopic: sns.Topic;
  public readonly fromAddress: string;
  /** Every alarm created, so test/infra can assert the set. */
  public readonly alarms: cloudwatch.Alarm[] = [];

  private readonly identityArn: string;
  private readonly configurationSetArn: string;
  /** Held so wireSender can alarm on the sender's own log markers. */
  private readonly alarmTopic: sns.ITopic;

  constructor(scope: Construct, id: string, props: EmailIdentityProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    this.alarmTopic = props.alarmTopic;
    this.fromAddress = props.fromAddress ?? DEFAULT_FROM_ADDRESS;
    this.identityArn = `arn:${cdk.Aws.PARTITION}:ses:${stack.region}:${stack.account}:identity/${MAIL_DOMAIN}`;

    // ── The suppression list ────────────────────────────────────────────
    //
    // Keyed by sha256 of the normalized address, never the address: this is
    // a list of parents' email addresses in an account shared with other
    // projects, and the send path only ever needs to ask "is THIS address on
    // it", which a hash answers. An operator answering "why can this person
    // not get a code" hashes the address they were given and does one
    // GetItem.
    //
    // RETAIN, like every other durable store here. It is not irreplaceable
    // user data, but losing it means every address that has ever complained
    // becomes mailable again, silently, and the next complaint is one we
    // were told about and forgot. That is a reputation risk with no way to
    // rebuild the list: SES will not hand back the history.
    this.suppressionTable = new dynamodb.Table(this, 'EmailSuppressionTable', {
      partitionKey: { name: 'addressHash', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // Only ever set on an unsuppressed transient tally; a suppression row
      // carries no expiry and is removed by hand or not at all.
      timeToLiveAttribute: 'expiresAt',
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.kmsKey,
      // Same shared-account reasoning as the referrals table: no IEP content,
      // but it is derived from families' contact details, so it carries the
      // same explicit deny for principals outside the allowlist.
      resourcePolicy: new iam.PolicyDocument({
        statements: [createIepDataDenyStatement(stack.account, ['dynamodb:*'], ['*'])],
      }),
    });
    tagResource(this.suppressionTable, {
      Resource: 'DynamoDB',
      TableName: 'EmailSuppressionTable',
      Purpose: 'ApplicationData',
    });

    // ── Where SES reports what happened to each message ─────────────────
    //
    // Left on SNS's default encryption, deliberately, and this is the
    // sentence the encryption doc asks for: the payload is a recipient
    // address in transit for seconds, SNS encrypts it at rest under an
    // AWS-owned key either way, and putting the application CMK here would
    // require key-policy grants for both ses.amazonaws.com and
    // sns.amazonaws.com. Get one of those wrong and SES silently cannot
    // publish, which does not leak anything -- it stops the suppression list
    // being maintained at all. Trading a working abuse control for a marginal
    // at-rest improvement on a seconds-long hop is the wrong trade.
    this.eventTopic = new sns.Topic(this, 'EmailEventTopic', {
      topicName: getResourceName('a-iep-email-events'),
      displayName: `A-IEP ${getEnvironment()} email delivery events`,
    });
    tagResource(this.eventTopic, { Resource: 'SNSTopic', Function: 'EmailEventTopic' });

    // ── The configuration set ───────────────────────────────────────────
    this.configurationSet = new ses.ConfigurationSet(this, 'AuthConfigurationSet', {
      configurationSetName: getResourceName('a-iep-auth'),
      // A login code is not worth sending in the clear. REQUIRE means SES
      // drops a message rather than deliver it over an unencrypted
      // connection; for a six-digit code with a five-minute life, a failed
      // delivery the parent can retry beats a readable one.
      tlsPolicy: ses.ConfigurationSetTlsPolicy.REQUIRE,
      // Load-bearing: without this SES publishes no per-configuration-set
      // Reputation.* series, and the two rate alarms below have nothing to
      // read. Set explicitly rather than left on the L2 default, because the
      // alarms depend on it and a default can change under us.
      reputationMetrics: true,
      sendingEnabled: true,
      // Belt to our own list's braces. Ours refuses before the API call and
      // tells the parent the truth; this one is SES refusing after the call,
      // and is what still applies if our check is ever bypassed. Set
      // explicitly rather than inherited from the account, because the
      // account setting is shared with two other projects.
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
    });
    this.configurationSetName = this.configurationSet.configurationSetName;
    this.configurationSetArn = `arn:${cdk.Aws.PARTITION}:ses:${stack.region}:${stack.account}:configuration-set/${this.configurationSetName}`;

    // The four events that mean something went wrong. Deliberately NOT
    // `send`, `delivery`, `open` or `click`: this destination feeds a lambda
    // that writes to a suppression list, and every event it does not need is
    // an invocation, a log line and a recipient address we had no reason to
    // handle. Open and click tracking would also rewrite links in the mail,
    // which is not something to do to a parent reading a login code.
    const failureEvents = [
      ses.EmailSendingEvent.BOUNCE,
      ses.EmailSendingEvent.COMPLAINT,
      ses.EmailSendingEvent.REJECT,
      ses.EmailSendingEvent.DELIVERY_DELAY,
    ];

    new ses.ConfigurationSetEventDestination(this, 'FailureEventsToSns', {
      configurationSet: this.configurationSet,
      configurationSetEventDestinationName: getResourceName('a-iep-email-failures'),
      destination: ses.EventDestination.snsTopic(this.eventTopic),
      events: failureEvents,
    });

    // The same events again, as CloudWatch counts. Two destinations rather
    // than one because they answer different questions: SNS drives the
    // suppression list, CloudWatch makes "how many, in the last fifteen
    // minutes" alarmable without deriving a metric from a lambda's logs.
    //
    // The dimension is SES's own configuration-set auto-tag, which is the
    // only thing separating A-IEP's mail from the rest of this shared
    // account's in the AWS/SES namespace.
    new ses.ConfigurationSetEventDestination(this, 'FailureEventsToCloudWatch', {
      configurationSet: this.configurationSet,
      configurationSetEventDestinationName: getResourceName('a-iep-email-metrics'),
      destination: ses.EventDestination.cloudWatchDimensions([
        {
          source: ses.CloudWatchDimensionSource.MESSAGE_TAG,
          name: 'ses:configuration-set',
          defaultValue: this.configurationSetName,
        },
      ]),
      events: failureEvents,
    });

    this.bounceHandler = this.addBounceHandler(props.kmsKey);
    this.addReputationAlarms(props.alarmTopic);
    this.addHandlerAlarms(props.alarmTopic);

    new cdk.CfnOutput(this, 'EmailConfigurationSetName', { value: this.configurationSetName });
    new cdk.CfnOutput(this, 'EmailSuppressionTableName', { value: this.suppressionTable.tableName });
  }

  /**
   * Give a function everything it needs to send an OTP email, and nothing
   * else.
   *
   * Called for create-auth-challenge, whose email branch is the other half of
   * this change. Kept here rather than spread across the auth construct so
   * that the grant, the environment and the code that reads them stay in one
   * reviewable place: the send path is only safe if the suppression table is
   * readable, and a function that has ses:SendEmail without it would fail
   * open by omission.
   */
  public wireSender(fn: lambda.Function): void {
    fn.addEnvironment('SES_CONFIGURATION_SET', this.configurationSetName);
    fn.addEnvironment('SES_FROM_ADDRESS', this.fromAddress);
    fn.addEnvironment('EMAIL_SUPPRESSION_TABLE', this.suppressionTable.tableName);

    // Read-only on the suppression table. The send path must never be able to
    // remove an address from it: taking somebody off this list is a decision
    // a person makes, not something a code path can do by accident.
    this.suppressionTable.grantReadData(fn);

    // Scoped to the one identity and the one configuration set. Without the
    // configuration-set resource the call fails, which is the cheap version
    // of forcing every send through the place that publishes events.
    fn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ses:SendEmail'],
      resources: [this.identityArn, this.configurationSetArn],
      conditions: {
        StringEquals: { 'ses:FromAddress': this.fromAddress },
      },
    }));

    // No ssm:GetParameter, and no /a-iep/<env>/email-policy subtree.
    //
    // An earlier draft of this construct mirrored the SMS path, which reads
    // its ceilings from Parameter Store with compiled floors behind them.
    // Neither /a-iep/dev/sms-policy/* nor /a-iep/prod/sms-policy/* was ever
    // created, so those floors have been the policy since the day they
    // shipped and the grant reads nothing. Adding a second never-populated
    // subtree would buy a second grant and the same illusion of
    // configurability. The email ceilings are compiled into
    // phone-otp-auth/email-suppression.js and that file says why they are
    // safe to publish.

    this.addSendPathAlarms(fn);
  }

  /**
   * The send path, watched through the markers it logs.
   *
   * Lambda Errors cannot see any of this, and that is not an oversight in the
   * trigger: create-auth-challenge reports a failed send through the
   * challenge parameter rather than raising, so its error count stays at zero
   * through a total delivery outage and every "login broken" alarm stays
   * green. The markers are the only signal there is. Exactly the arrangement
   * monitoring.ts already makes for the SMS half.
   *
   * These filters live here, on the SENDER's log group, rather than in
   * MonitoringStack, because the marker, the filter, the alarm and the IAM
   * grant that makes the send possible at all then sit in one reviewable
   * place. That is the reason wireSender exists.
   */
  private addSendPathAlarms(fn: lambda.Function): void {
    const metricNamespace = 'AI-IEP/Email';

    const markerMetric = (id: string, marker: string, metricName: string) => {
      new logs.MetricFilter(this, id, {
        logGroup: fn.logGroup,
        // Marker only. Pinned by the lambda's own unit tests and by
        // test/infra/email-identity.test.ts, because a reworded log line
        // would disarm the alarm without failing anything.
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

    this.alarm(this.alarmTopic, 'EmailSuppressionCheckUnavailableAlarm', {
      severity: 'critical',
      name: 'email sign-in is refusing everyone: the do-not-email check is down',
      description:
        'The do-not-email list cannot be read, so every email login code is ' +
        'being refused rather than risk mailing a bad address. Parents using ' +
        'email cannot sign in until this clears.',
      // One occurrence, because the control is binary: either the check runs
      // or email sign-in is down. Five minutes rather than fifteen for the
      // same reason.
      metric: markerMetric(
        'EmailSuppressionUnavailableFilter', 'EMAIL_SUPPRESSION_UNAVAILABLE',
        'EmailSuppressionUnavailable',
      ),
      threshold: 1,
      evaluationPeriods: 1,
    });

    this.alarm(this.alarmTopic, 'EmailSuppressedDestinationAlarm', {
      severity: 'medium',
      name: 'login codes being requested for addresses we may not email',
      description:
        'Sign-in is being attempted with addresses already on the ' +
        'do-not-email list. The codes are refused, so nothing is sent, but ' +
        'this is what an abuse run replaying old addresses looks like.',
      // Same shape as the SMS destination alarm: one parent whose old address
      // bounced must not page anyone, and a run produces these in bulk.
      metric: markerMetric(
        'EmailSuppressedDestinationFilter', 'EMAIL_SUPPRESSED_DESTINATION',
        'EmailSuppressedDestination',
      ),
      threshold: 10,
      evaluationPeriods: 1,
    });

    this.alarm(this.alarmTopic, 'EmailBudgetExhaustedAlarm', {
      severity: 'critical',
      name: 'email login codes are being refused: the sending limit is reached',
      description:
        'The service-wide limit on emailed login codes has been hit, so ' +
        'parents are being turned away at sign-in. Either an abuse run is ' +
        'under way or real demand has outgrown the limit.',
      // Any occurrence: by the time this fires a real parent was refused.
      metric: markerMetric(
        'EmailBudgetExhaustedFilter', 'EMAIL_BUDGET_EXHAUSTED', 'EmailBudgetExhausted',
      ),
      threshold: 1,
      evaluationPeriods: 1,
    });

    this.alarm(this.alarmTopic, 'EmailSendFailedAlarm', {
      severity: 'critical',
      name: 'email login codes are not being delivered',
      description:
        'Emailing a login code is failing outright, so no parent can sign in ' +
        'with an email address. This is the alarm the trigger error alarms ' +
        'cannot raise, because a failed send is reported, not thrown.',
      metric: markerMetric(
        'EmailSendFailedFilter', 'EMAIL_SEND_FAILED', 'EmailSendFailed',
      ),
      threshold: 1,
      evaluationPeriods: 1,
    });
  }

  /**
   * The lambda that keeps the suppression list current.
   *
   * SNS-triggered rather than polled, because the window between "this
   * address complained" and "we mail it again" is the whole risk.
   */
  private addBounceHandler(kmsKey: kms.IKey): lambda.Function {
    const fn = new lambda.Function(this, 'SesBounceHandlerFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(path.join(__dirname, '../functions/ses-suppression')),
      handler: 'bounce-handler.handler',
      environment: {
        EMAIL_SUPPRESSION_TABLE: this.suppressionTable.tableName,
        TRANSIENT_BOUNCES_BEFORE_SUPPRESSION: String(TRANSIENT_BOUNCES_BEFORE_SUPPRESSION),
        TRANSIENT_BOUNCE_TTL_DAYS: String(TRANSIENT_BOUNCE_TTL_DAYS),
      },
      timeout: cdk.Duration.seconds(30),
      logRetention: logs.RetentionDays.ONE_YEAR,
      environmentEncryption: kmsKey,
      description: 'Records SES bounces and complaints so a bad address is never mailed again',
    });

    // UpdateItem and nothing else, hand-rolled rather than grantWriteData().
    //
    // grantWriteData() would be the idiomatic call and it grants PutItem,
    // BatchWriteItem and DeleteItem alongside it. DeleteItem is the problem:
    // this is the only function that writes the do-not-email list, so it
    // would also be the only function that could empty it, and an address
    // removed from this list is one we start mailing again with nothing
    // saying so. Taking somebody off is a decision a person makes.
    //
    // Every write here is an UpdateItem (the suppression and the tally are
    // both updates so they can share a row without clobbering each other),
    // so this is not a narrowing of what the handler can do -- only of what
    // a bug in it could do. The key grant is the same one grantWriteData
    // would have added; without it every write fails on the CMK.
    this.suppressionTable.grant(fn, 'dynamodb:UpdateItem');
    kmsKey.grant(fn, 'kms:Decrypt', 'kms:DescribeKey', 'kms:Encrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*');
    this.eventTopic.addSubscription(new subscriptions.LambdaSubscription(fn));
    tagResource(fn, { Resource: 'Lambda', Function: 'SesBounceHandler' });
    return fn;
  }

  // Two absences here are deliberate, and both read as oversights.
  //
  // **No dead-letter queue.** SNS retries a failed invocation and then
  // discards the event. Nothing in this repo sets deadLetterQueue, onFailure
  // or reservedConcurrentExecutions, and adding one here alone would be a
  // house convention of one. SesBounceHandlerErrorAlarm is what catches a
  // handler that is not recovering.
  //
  // **Not in MonitoringProps.apiFunctions.** MonitoringStack is created last
  // on purpose, so everything it watches already exists, and this construct
  // has to be created after it because it needs the alarm topic. The house
  // Errors/Throttles loop therefore never sees the bounce handler. That is
  // fine only because SesBounceHandlerErrorAlarm below covers the same
  // ground; adding it to that list would produce two alarms for one failure.

  /**
   * The two rates AWS suspends accounts over.
   *
   * Read at the ACCOUNT level, with no dimensions, on purpose. The
   * configuration-set series would say "is it A-IEP's mail", which is the
   * second question; the account series is the number AWS acts on, and in
   * this shared account it moves for reasons that have nothing to do with
   * A-IEP and stop A-IEP's login all the same. The count alarms below are
   * dimensioned, and answer the first question.
   *
   * Both environments create these, and both watch the same account-level
   * series, so a breach alerts twice. That is the same trade monitoring.ts
   * already makes for the SNS delivery-failure metric: an account-level
   * metric alarm creates no shared resource, and staging alarms are
   * informational by design.
   */
  private addReputationAlarms(alarmTopic: sns.ITopic): void {
    const reputation = (metricName: string) => new cloudwatch.Metric({
      namespace: 'AWS/SES',
      metricName,
      statistic: 'Maximum',
      // SES republishes the trailing rate every fifteen minutes or so. An
      // hour of it smooths the single-datapoint jitter that low volume
      // produces without meaningfully delaying a response: nothing about a
      // reputation problem is fixed in under an hour anyway.
      period: cdk.Duration.hours(1),
    });

    this.alarm(alarmTopic, 'EmailBounceRateReviewAlarm', {
      severity: 'medium',
      name: 'email bounce rate is climbing',
      description:
        'Login codes are bouncing often enough to be worth looking at. AWS ' +
        'puts an account under review at 5%; this fires at 2%, while there ' +
        'is still room to act.',
      metric: reputation('Reputation.BounceRate'),
      threshold: BOUNCE_RATE_REVIEW,
      evaluationPeriods: 1,
    });

    this.alarm(alarmTopic, 'EmailBounceRateCriticalAlarm', {
      severity: 'critical',
      name: 'email bounce rate near the limit AWS suspends accounts over',
      description:
        'Bounces are close to the level where AWS stops this account sending ' +
        'email. That would end email sign-in for every family, and getting it ' +
        'back is an appeal to AWS, not a wait.',
      metric: reputation('Reputation.BounceRate'),
      threshold: BOUNCE_RATE_CRITICAL,
      evaluationPeriods: 1,
    });

    this.alarm(alarmTopic, 'EmailComplaintRateReviewAlarm', {
      severity: 'medium',
      name: 'email complaint rate is climbing',
      description:
        'People are marking A-IEP login codes as spam. AWS puts an account ' +
        'under review at 0.1%; this fires at 0.05%. Someone is being sent ' +
        'codes they did not ask for.',
      metric: reputation('Reputation.ComplaintRate'),
      threshold: COMPLAINT_RATE_REVIEW,
      evaluationPeriods: 1,
    });

    this.alarm(alarmTopic, 'EmailComplaintRateCriticalAlarm', {
      severity: 'critical',
      name: 'email complaint rate near the limit AWS suspends accounts over',
      description:
        'Spam complaints are close to the level where AWS stops this account ' +
        'sending email, which would end email sign-in for every family. This ' +
        'is the tighter of the two limits by fifty times.',
      metric: reputation('Reputation.ComplaintRate'),
      threshold: COMPLAINT_RATE_CRITICAL,
      evaluationPeriods: 1,
    });

    // The fast signals. Dimensioned to A-IEP's configuration set, so these
    // fire for our mail and not for another project's campaign.
    const count = (metricName: string) => new cloudwatch.Metric({
      namespace: 'AWS/SES',
      metricName,
      dimensionsMap: { 'ses:configuration-set': this.configurationSetName },
      statistic: 'Sum',
      period: cdk.Duration.minutes(15),
    });

    this.alarm(alarmTopic, 'EmailBounceBurstAlarm', {
      severity: 'critical',
      name: 'login codes are being emailed to addresses that do not exist',
      description:
        'A burst of undeliverable login codes, which is what someone feeding ' +
        'the sign-in form invented addresses looks like. Left alone this ends ' +
        'in AWS suspending email for the whole account.',
      metric: count('Bounce'),
      threshold: BOUNCE_COUNT_BURST,
      evaluationPeriods: 1,
    });

    this.alarm(alarmTopic, 'EmailComplaintAlarm', {
      severity: 'medium',
      name: 'someone marked an A-IEP login code as spam',
      description:
        'A login code reached somebody who did not ask for one. One is worth ' +
        'reading about: AWS allows one complaint per thousand messages before ' +
        'putting an account under review.',
      metric: count('Complaint'),
      threshold: COMPLAINT_COUNT_ANY,
      evaluationPeriods: 1,
    });

    this.alarm(alarmTopic, 'EmailRejectAlarm', {
      severity: 'medium',
      name: 'AWS is refusing to send A-IEP login emails',
      description:
        'SES accepted a login code and then declined to send it. Transactional ' +
        'mail should never be rejected, so this is about what is being sent, ' +
        'not who it is going to.',
      metric: count('Reject'),
      threshold: REJECT_COUNT_ANY,
      evaluationPeriods: 1,
    });

    this.alarm(alarmTopic, 'EmailDeliveryDelayAlarm', {
      severity: 'low',
      name: 'email login codes are arriving late',
      description:
        'Login codes are being held up on the way to parents, who will be ' +
        'staring at an empty inbox and asking for another one. The code ' +
        'usually still arrives, so this is worth reading, not waking for.',
      metric: count('DeliveryDelay'),
      threshold: DELIVERY_DELAY_COUNT,
      evaluationPeriods: 1,
    });
  }

  /**
   * The suppression list watching itself.
   *
   * Neither of these is an outage today, and neither is one a parent would
   * notice. Both are the list quietly stopping being maintained, which is
   * only discovered later, as a suspension.
   */
  private addHandlerAlarms(alarmTopic: sns.ITopic): void {
    const metricNamespace = 'AI-IEP/Email';

    // Marker, not prose. A metric filter reads this exact string, so
    // rewording the log line disarms the alarm without failing anything;
    // the handler's unit tests pin the marker for that reason. Same contract
    // as SMS_REFUSED_DESTINATION and RECORD_FAILURE.
    new logs.MetricFilter(this, 'SesSuppressionWriteFailedFilter', {
      logGroup: this.bounceHandler.logGroup,
      filterPattern: logs.FilterPattern.literal('SES_SUPPRESSION_WRITE_FAILED'),
      metricNamespace,
      metricName: 'SesSuppressionWriteFailed',
      metricValue: '1',
      defaultValue: 0,
    });

    this.alarm(alarmTopic, 'SesSuppressionWriteFailedAlarm', {
      severity: 'medium',
      name: 'a bounced or complained address was not recorded',
      description:
        'A bounce or spam complaint could not be written to the do-not-email ' +
        'list, so that address will be emailed again. Nothing is broken for ' +
        'families yet; this is how an email suspension starts.',
      metric: new cloudwatch.Metric({
        namespace: metricNamespace,
        metricName: 'SesSuppressionWriteFailed',
        statistic: 'Sum',
        period: cdk.Duration.minutes(15),
      }),
      threshold: 1,
      evaluationPeriods: 1,
    });

    this.alarm(alarmTopic, 'SesBounceHandlerErrorAlarm', {
      severity: 'medium',
      name: 'the do-not-email list is not being maintained',
      description:
        'The handler that records bounces and spam complaints is failing. ' +
        'Addresses that should never be emailed again will be, and the ' +
        'account is heading towards an AWS review.',
      metric: this.bounceHandler.metricErrors({ period: cdk.Duration.minutes(15) }),
      // SNS retries a failed Lambda delivery, so one transient blip records
      // several errors and still succeeds. Three means it is not transient.
      threshold: 3,
      evaluationPeriods: 1,
    });
  }

  /**
   * One alarm, on the shared alerting path.
   *
   * Deliberately the same shape as MonitoringStack's private helper: the
   * `[severity]` prefix is the only field CloudWatch carries into SNS that
   * we control, and the alert formatter reads and strips it. An alarm
   * created without it arrives in Slack uncoloured and with the marker
   * showing.
   */
  private alarm(
    alarmTopic: sns.ITopic,
    id: string,
    opts: {
      name: string;
      description: string;
      severity: Severity;
      metric: cloudwatch.IMetric;
      threshold: number;
      evaluationPeriods: number;
    },
  ): cloudwatch.Alarm {
    const alarm = new cloudwatch.Alarm(this, id, {
      alarmName: `${getResourceName('a-iep')} ${opts.name}`,
      alarmDescription: `[${opts.severity}] ${opts.description}`,
      metric: opts.metric,
      threshold: opts.threshold,
      evaluationPeriods: opts.evaluationPeriods,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      // No data means no email was sent, which for every metric here is
      // genuinely not a problem. Nothing in this construct is a heartbeat.
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(new actions.SnsAction(alarmTopic));
    alarm.addOkAction(new actions.SnsAction(alarmTopic));
    this.alarms.push(alarm);
    return alarm;
  }
}
