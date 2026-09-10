import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { getResourceName, tagResource } from '../../tags';

export interface AuditTrailProps {
  /** The IEP document store. Object-level reads are the point of this trail. */
  readonly documentBucket: s3.Bucket;
  /** FERPA-bearing tables. */
  readonly tables: dynamodb.ITable[];
}

/**
 * Object- and item-level audit logging for the stores that hold student data.
 *
 * The organisation trail records management events only, so the question "was
 * any IEP document read" has had no answer available: not "no", but
 * unknowable. For records of children with disabilities that is the wrong
 * answer to be unable to give, and it is only fixable forwards, because a
 * trail cannot log what already happened.
 *
 * Read events are included deliberately. A write shows up in the data itself;
 * an exfiltration is invisible everywhere else, and reads are exactly the
 * events this exists to answer for.
 *
 * The OTP rate-limit table is deliberately absent: it holds hashes and
 * counters, no personal data, and several writes per login would be most of
 * the volume for none of the value.
 */
export class AuditTrail extends Construct {
  public readonly trail: cloudtrail.Trail;
  public readonly logBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: AuditTrailProps) {
    super(scope, id);

    // RETAIN, for the same reason as every other durable store here: an audit
    // log a stack teardown deletes is not an audit log, and it is the only
    // copy of the evidence for anything already recorded.
    this.logBucket = new s3.Bucket(this, 'AuditLogBucket', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      lifecycleRules: [
        {
          // Long enough to investigate an incident discovered late, short
          // enough that storage does not grow without bound.
          id: 'expire-after-400-days',
          expiration: cdk.Duration.days(400),
        },
      ],
    });

    this.trail = new cloudtrail.Trail(this, 'Trail', {
      trailName: getResourceName('a-iep-data-events'),
      bucket: this.logBucket,
      // Management events are already covered by the organisation trail, so
      // repeating them here would double the cost for no extra answer.
      managementEvents: cloudtrail.ReadWriteType.NONE,
      includeGlobalServiceEvents: false,
      isMultiRegionTrail: false,
      // Tamper-evidence: without it a log file can be altered afterwards and
      // nothing detects it, which defeats the point of keeping one.
      enableFileValidation: true,
    });

    // S3 through the L2, which also validates that a trail with management
    // events off has at least one selector.
    this.trail.addS3EventSelector([{ bucket: props.documentBucket }], {
      readWriteType: cloudtrail.ReadWriteType.ALL,
      includeManagementEvents: false,
    });

    // DynamoDB has no L2 constant in this aws-cdk-lib: DataResourceType is
    // S3_OBJECT and LAMBDA_FUNCTION only, though CloudTrail accepts
    // AWS::DynamoDB::Table perfectly well. The tables are the half holding
    // summaries and profile data, so they are worth an escape hatch.
    //
    // Index 0 is the selector added immediately above, and index 1 is the
    // slot after the S3 data resource it created. Both are safe only because
    // this construct adds exactly one selector and never more; adding another
    // above this line would silently write into the wrong place, which is
    // what the infra test pins against.
    if (props.tables.length > 0) {
      const cfnTrail = this.trail.node.defaultChild as cloudtrail.CfnTrail;
      cfnTrail.addPropertyOverride('EventSelectors.0.DataResources.1', {
        Type: 'AWS::DynamoDB::Table',
        Values: props.tables.map((t) => t.tableArn),
      });
    }

    tagResource(this.logBucket, { Resource: 'AuditLogBucket', Module: 'Audit' });
    tagResource(this.trail, { Resource: 'AuditTrail', Module: 'Audit' });
  }
}

/**
 * The IAM role SNS assumes to write SMS delivery outcomes to CloudWatch Logs.
 *
 * Without delivery status logging, a message the provider accepts and then
 * fails to deliver is invisible: the publish call succeeds, a message id comes
 * back, and nothing anywhere records that it never arrived. That is precisely
 * the shape of the 2026-09-09 outage, where the trigger logged successful
 * sends for hours while no code reached anyone.
 *
 * Created in PRODUCTION ONLY, because the setting it serves is account-level
 * and there is exactly one of it. A copy per environment models it as though
 * each had its own, which is false and actively misleading: whichever role
 * the account setting happens to name is the one in use, so a teardown of the
 * other environment silently ends delivery logging for both, and nothing in
 * either stack hints at that. One account-level thing, one role.
 *
 * Switching delivery status logging ON is still a deliberate ops step rather
 * than something a deploy does. Two stacks writing the same account attribute
 * would fight, and the call also carries MonthlySpendLimit, which is the last
 * line of defence on spend and must not be clobbered by a deploy.
 */
export class SmsDeliveryStatusRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.role = new iam.Role(this, 'Role', {
      roleName: getResourceName('a-iep-sms-delivery-status'),
      assumedBy: new iam.ServicePrincipal('sns.amazonaws.com'),
      description: 'Lets SNS write SMS delivery outcomes to CloudWatch Logs',
    });

    // Exactly what SNS needs to write the delivery logs, and nothing else.
    this.role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'logs:PutMetricFilter',
        'logs:PutRetentionPolicy',
      ],
      resources: ['*'],
    }));

    new cdk.CfnOutput(this, 'SmsDeliveryStatusRoleArn', {
      value: this.role.roleArn,
      description: 'Pass to sns set-sms-attributes DeliveryStatusIAMRole to enable delivery logging',
    });

    tagResource(this.role, { Resource: 'SmsDeliveryStatusRole', Module: 'Audit' });
  }
}
