import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from "constructs";
import { createBucketPolicy } from './bucket-policy';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { getEnvironment } from '../../tags';
import { createIepDataDenyStatement } from '../security';

export interface S3BucketStackProps extends cdk.StackProps {
  encryptionKey?: kms.IKey;
}

export class S3BucketStack extends cdk.Stack {
  public readonly knowledgeBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: S3BucketStackProps) {
    super(scope, id, props);

    // Create a new S3 bucket with explicit name to support cross-environment usage.
    //
    // DO NOT CHANGE THIS NAME, and do not change how `environment` is spelled.
    // The 2026-06/07 data-loss incident: e1df452 (2025-09-15) made this name
    // interpolate getEnvironment(), then edc7d2d (2026-06-22), a tag cleanup,
    // redefined Environment from 'production'|'staging' to 'prod'|'dev'. That
    // renamed both buckets (-production -> -prod, -staging -> -dev). S3 names
    // are immutable, so CloudFormation REPLACED the bucket, and because it was
    // declared DESTROY + autoDeleteObjects it deleted the old bucket and every
    // object in it: 50 of 102 production and 10 of 44 staging IEP documents
    // lost their stored content. The deploy reported success.
    // test/infra/gen-ai-mvp-stack.test.ts pins both the literal name per
    // environment and the retention policy below.
    const environment = getEnvironment();
    const bucketName = `ai-iep-knowledge-source-${environment}`;

    this.knowledgeBucket = new s3.Bucket(scope, 'KnowledgeSourceBucket', {
      bucketName: bucketName,
      versioned: true,
      // RETAIN, and no autoDeleteObjects: this bucket is families' IEP
      // documents. Any future rename/replacement must strand the old bucket
      // instead of emptying it, and a `cdk destroy` must never take the data
      // with it. (CDK also throws at synth if autoDeleteObjects is set without
      // removalPolicy DESTROY, so the two must stay removed together.)
      // Deliberately not "cleaned up" to DESTROY: see the incident note above.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: props?.encryptionKey ? s3.BucketEncryption.KMS : s3.BucketEncryption.S3_MANAGED,
      encryptionKey: props?.encryptionKey,
      cors: [{
        allowedMethods: [s3.HttpMethods.GET,s3.HttpMethods.POST,s3.HttpMethods.PUT,s3.HttpMethods.DELETE],
        allowedOrigins: ['*'],
        allowedHeaders: ["*"]
      }],
      lifecycleRules: [
        {
          // Retention: the bucket is versioned, so deletes (original PDFs,
          // raw OCR) only add delete markers — the data survives as
          // noncurrent versions. Expire those quickly so deleted sensitive
          // documents are actually gone.
          id: 'ExpireNoncurrentVersions',
          noncurrentVersionExpiration: cdk.Duration.days(1),
        },
        {
          // Clean up delete markers whose versions have all expired
          id: 'CleanupExpiredDeleteMarkers',
          expiredObjectDeleteMarker: true,
        }
      ]
    });

    // Apply restrictive bucket policy to the knowledge bucket (which contains IEP documents)
    // Use dynamic account ID to support multiple AWS accounts for prod/staging
    const accountId = this.account;
    const allowedUsers = [
      `arn:aws:iam::${accountId}:user/dhruv`, 
      `arn:aws:iam::${accountId}:root`,       
    ];

    // Create and apply the bucket policy
    createBucketPolicy(this, 'KnowledgeBucketPolicy', {
      bucket: this.knowledgeBucket,
      allowedUsers: allowedUsers
    });
    
    // Add direct permissions for the project owner. Lambda functions access
    // the bucket through their execution roles (granted in functions.ts);
    // no service-principal allows are needed.
    this.knowledgeBucket.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [
        new iam.ArnPrincipal(`arn:aws:iam::${accountId}:user/dhruv`),
        new iam.ArnPrincipal(`arn:aws:iam::${accountId}:root`)
      ],
      actions: [
        's3:GetObject',
        's3:PutObject',
        's3:DeleteObject',
        's3:ListBucket',
        's3:GetBucketLocation'
      ],
      resources: [
        this.knowledgeBucket.bucketArn,
        `${this.knowledgeBucket.bucketArn}/*`
      ]
    }));

    // This account is shared with other projects/users: explicitly deny any
    // principal outside the IEP-data allowlist, regardless of their IAM
    // identity policies. AWS service principals stay exempt.
    this.knowledgeBucket.addToResourcePolicy(createIepDataDenyStatement(
      accountId,
      ['s3:*'],
      [
        this.knowledgeBucket.bucketArn,
        `${this.knowledgeBucket.bucketArn}/*`
      ]
    ));


    // Add back the deny statement for non-HTTPS requests
    this.knowledgeBucket.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:*'],
      resources: [
        this.knowledgeBucket.bucketArn,
        `${this.knowledgeBucket.bucketArn}/*`
      ],
      conditions: {
        'Bool': {
          'aws:SecureTransport': 'false'
        }
      }
    }));
  }
}
