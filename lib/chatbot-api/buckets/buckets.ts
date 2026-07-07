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

    // Create a new S3 bucket with explicit name to support cross-environment usage
    const environment = getEnvironment();
    const bucketName = `ai-iep-knowledge-source-${environment}`;
    
    this.knowledgeBucket = new s3.Bucket(scope, 'KnowledgeSourceBucket', {      
      bucketName: bucketName,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: props?.encryptionKey ? s3.BucketEncryption.KMS : s3.BucketEncryption.S3_MANAGED,
      encryptionKey: props?.encryptionKey,
      cors: [{
        allowedMethods: [s3.HttpMethods.GET,s3.HttpMethods.POST,s3.HttpMethods.PUT,s3.HttpMethods.DELETE],
        allowedOrigins: ['*'],      
        allowedHeaders: ["*"]
      }]
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
