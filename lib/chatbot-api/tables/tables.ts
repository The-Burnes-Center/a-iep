import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Attribute, AttributeType, Table, ProjectionType } from 'aws-cdk-lib/aws-dynamodb';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { getTagProps, tagResource } from '../../tags';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import { createIepDataDenyStatement } from '../security';

export interface TableStackProps extends StackProps {
  kmsKey?: kms.IKey;
}

export class TableStack extends Stack {
  public readonly userProfilesTable: dynamodb.Table;
  public readonly iepDocumentsTable: dynamodb.Table;
  public readonly referralsTable: dynamodb.Table;
  constructor(scope: Construct, id: string, props?: TableStackProps) {
    super(scope, id, props);

    // Helper function to tag tables with standard tags plus table-specific tags
    const tagTable = (table: dynamodb.Table, tableName: string) => {
      tagResource(table, {
        'Resource': 'DynamoDB',
        'TableName': tableName,
        'Purpose': 'ApplicationData'
      });
    };

    // RETENTION, not a style choice. On 2026-06-22 a tag-standardization
    // commit (edc7d2d) changed the Environment label from 'production'/'staging'
    // to 'prod'/'dev'. That silently renamed the knowledge S3 bucket, and
    // because it was declared DESTROY + autoDeleteObjects, CloudFormation
    // replaced it and deleted every object: 50 of 102 production IEP documents
    // were lost and the deploy still reported success. These tables (child
    // profiles, IEP document records, referral attribution) are the same class
    // of irreplaceable user data, so every one of them is RETAIN: a rename, a
    // logical-ID change, or a `cdk destroy` must strand the table rather than
    // delete it. Do not "clean this up" to DESTROY. Pinned by
    // test/infra/gen-ai-mvp-stack.test.ts.
    const USER_DATA_REMOVAL_POLICY = cdk.RemovalPolicy.RETAIN;

    // Both tables hold FERPA-protected data in a shared AWS account: attach a
    // resource policy that explicitly denies every principal outside the
    // IEP-data allowlist (identity-based IAM policies cannot override it).
    // '*' scopes the deny to the table the policy is attached to (and its
    // indexes), avoiding a circular reference on the auto-generated ARN.
    const iepDataResourcePolicy = () => new iam.PolicyDocument({
      statements: [createIepDataDenyStatement(this.account, ['dynamodb:*'], ['*'])]
    });

    // Create User Profiles Table
    this.userProfilesTable = new dynamodb.Table(scope, 'UserProfilesTable', {
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: USER_DATA_REMOVAL_POLICY,
      timeToLiveAttribute: 'ttl',
      encryption: props?.kmsKey ? dynamodb.TableEncryption.CUSTOMER_MANAGED : dynamodb.TableEncryption.AWS_MANAGED,
      ...(props?.kmsKey ? { encryptionKey: props.kmsKey } : {}),
      resourcePolicy: iepDataResourcePolicy(),
    });
    tagTable(this.userProfilesTable, 'UserProfilesTable');

    // Create IEP Documents Table
    this.iepDocumentsTable = new dynamodb.Table(scope, 'IepDocumentsTable', {
      partitionKey: { name: 'iepId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'childId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: USER_DATA_REMOVAL_POLICY,
      timeToLiveAttribute: 'ttl',
      encryption: props?.kmsKey ? dynamodb.TableEncryption.CUSTOMER_MANAGED : dynamodb.TableEncryption.AWS_MANAGED,
      ...(props?.kmsKey ? { encryptionKey: props.kmsKey } : {}),
      resourcePolicy: iepDataResourcePolicy(),
    });
    tagTable(this.iepDocumentsTable, 'IepDocumentsTable');

    // Add GSI for querying documents by userId
    this.iepDocumentsTable.addGlobalSecondaryIndex({
      indexName: 'byUserId',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.NUMBER },
    });

    // GSI for querying documents by childId
    this.iepDocumentsTable.addGlobalSecondaryIndex({
      indexName: 'byChildId',
      partitionKey: { name: 'childId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.NUMBER },
    });

    // Referral links and attribution events. One item collection per code:
    // sk 'META' holds the link (type, owner, counters), 'EVT#...' items hold
    // click/signup events (clicks carry a ttl; signups are kept). Not IEP
    // content, but it references userIds in the same shared account, so it
    // carries the same deny-outside-allowlist resource policy.
    this.referralsTable = new dynamodb.Table(scope, 'ReferralsTable', {
      partitionKey: { name: 'code', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: USER_DATA_REMOVAL_POLICY,
      timeToLiveAttribute: 'ttl',
      encryption: props?.kmsKey ? dynamodb.TableEncryption.CUSTOMER_MANAGED : dynamodb.TableEncryption.AWS_MANAGED,
      ...(props?.kmsKey ? { encryptionKey: props.kmsKey } : {}),
      resourcePolicy: iepDataResourcePolicy(),
    });
    tagTable(this.referralsTable, 'ReferralsTable');

    // GSI to find a user's personal code without scanning
    this.referralsTable.addGlobalSecondaryIndex({
      indexName: 'byOwner',
      partitionKey: { name: 'ownerUserId', type: dynamodb.AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });
  }
}
