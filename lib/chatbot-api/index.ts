import * as cdk from "aws-cdk-lib";

import { RestBackendAPI } from "./gateway/rest-api"
import { LambdaFunctionStack } from "./functions/functions"
import { TableStack } from "./tables/tables"
import { S3BucketStack } from "./buckets/buckets"
import { LoggingStack } from "./logging/logging"

import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { aws_apigatewayv2 as apigwv2 } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NewAuthorizationStack } from "../authorization/new-auth";
import * as kms from 'aws-cdk-lib/aws-kms';
import { getEnvironment } from '../tags';


export interface ChatBotApiProps {
  readonly authentication?: NewAuthorizationStack;
}

export class ChatBotApi extends Construct {
  public readonly httpAPI: RestBackendAPI;
  public readonly logging: LoggingStack;
  public readonly userProfilesTable: any;
  private lambdaFunctions: LambdaFunctionStack;
  private tables: TableStack;
  private buckets: S3BucketStack;
  public readonly kmsKey: kms.IKey;

  constructor(scope: Construct, id: string, props: ChatBotApiProps) {
    super(scope, id);

    // Create a single customer-managed KMS key for application encryption
    const appKmsKey = new kms.Key(this, 'AppKmsKey', {
      enableKeyRotation: true,
      description: 'Customer-managed CMK for S3, DynamoDB, Lambda env vars, and logs',
      // Explicit RETAIN (also the CDK default for kms.Key, stated here so it
      // survives a future refactor). This key encrypts the IEP documents in
      // S3 and the profile/document tables at rest: schedule it for deletion
      // and the data that outlives it becomes permanently unreadable, which is
      // data loss by another route than the 2026-06-22 bucket rename that
      // deleted 50 of 102 production documents. Pinned by
      // test/infra/gen-ai-mvp-stack.test.ts.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const environment = getEnvironment();
    const kmsAliasName = environment === 'dev' ? 'alias/aiep/app' : 'alias/aiep/app-prod';
    const appKmsAlias = new kms.Alias(this, 'AppKmsAlias', {
      aliasName: kmsAliasName,
      targetKey: appKmsKey,
    });

    // Initialize logging (encrypted with CMK)
    this.logging = new LoggingStack(this, "Logging", { kmsKey: appKmsKey });
    this.logging.node.addDependency(appKmsAlias);

    this.tables = new TableStack(this, "TableStack", { kmsKey: appKmsKey });
    this.buckets = new S3BucketStack(this, "BucketStack", { encryptionKey: appKmsKey });
    this.kmsKey = appKmsKey;
    
    // Expose user profiles table
    this.userProfilesTable = this.tables.userProfilesTable;
    
    const restBackend = new RestBackendAPI(this, "RestBackend", {})
    this.httpAPI = restBackend;

    // If authentication is provided, set up the full API
    if (props.authentication) {
      this.setupApiWithAuthentication(props.authentication, appKmsKey);
    }
  }

  /**
   * Set authentication and set up the API routes
   */
  public setAuthentication(authentication: NewAuthorizationStack) {
    this.setupApiWithAuthentication(authentication, this.kmsKey);
  }

  /**
   * Set up API routes with authentication
   */
  private setupApiWithAuthentication(authentication: NewAuthorizationStack, appKmsKey: kms.IKey) {
    this.lambdaFunctions = new LambdaFunctionStack(this, "LambdaFunctions",
      {
        knowledgeBucket: this.buckets.knowledgeBucket,
        userProfilesTable: this.tables.userProfilesTable,
        iepDocumentsTable: this.tables.iepDocumentsTable,
        referralsTable: this.tables.referralsTable,
        userPool: authentication.userPool,
        logGroup: this.logging.logGroup,
        logRole: this.logging.logRole,
        kmsKey: appKmsKey,
      })

    const httpAuthorizer = new HttpJwtAuthorizer('HTTPAuthorizer', authentication.userPool.userPoolProviderUrl,{
      jwtAudience: [authentication.userPoolClient.userPoolClientId],
    });

    const s3GetKnowledgeAPIIntegration = new HttpLambdaIntegration('S3GetKnowledgeAPIIntegration', this.lambdaFunctions.getS3KnowledgeFunction);
    this.httpAPI.restAPI.addRoutes({
      path: "/s3-knowledge-bucket-data",
      methods: [apigwv2.HttpMethod.POST],
      integration: s3GetKnowledgeAPIIntegration,
      authorizer: httpAuthorizer,
    })

    const s3DeleteAPIIntegration = new HttpLambdaIntegration('S3DeleteAPIIntegration', this.lambdaFunctions.deleteS3Function);
    this.httpAPI.restAPI.addRoutes({
      path: "/delete-s3-file",
      methods: [apigwv2.HttpMethod.POST],
      integration: s3DeleteAPIIntegration,
      authorizer: httpAuthorizer,
    })

    const s3UploadKnowledgeAPIIntegration = new HttpLambdaIntegration('S3UploadKnowledgeAPIIntegration', this.lambdaFunctions.uploadS3KnowledgeFunction);
    this.httpAPI.restAPI.addRoutes({
      path: "/signed-url-knowledge",
      methods: [apigwv2.HttpMethod.POST],
      integration: s3UploadKnowledgeAPIIntegration,
      authorizer: httpAuthorizer,
    })

    const userProfileAPIIntegration = new HttpLambdaIntegration(
      'UserProfileAPIIntegration', 
      this.lambdaFunctions.userProfileFunction
    );

    // Add routes for user profile management
    this.httpAPI.restAPI.addRoutes({
      path: "/profile",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE],
      integration: userProfileAPIIntegration,
      authorizer: httpAuthorizer,
    });

    this.httpAPI.restAPI.addRoutes({
      path: "/profile/children",
      methods: [apigwv2.HttpMethod.POST],
      integration: userProfileAPIIntegration,
      authorizer: httpAuthorizer,
    });

    this.httpAPI.restAPI.addRoutes({
      path: "/profile/children/{childId}/documents",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.DELETE],
      integration: userProfileAPIIntegration,
      authorizer: httpAuthorizer,
    });

    this.httpAPI.restAPI.addRoutes({
      path: "/documents/{iepId}/status",
      methods: [apigwv2.HttpMethod.GET],
      integration: userProfileAPIIntegration,
      authorizer: httpAuthorizer,
    });

    this.httpAPI.restAPI.addRoutes({
      path: "/summary",
      methods: [apigwv2.HttpMethod.POST],
      integration: userProfileAPIIntegration,
      authorizer: httpAuthorizer,
    });

    // On-demand translation of an already-processed document into one more
    // language. Its own lambda rather than the profile handler's: it is the
    // only route that starts a Step Functions execution and spends OpenAI
    // money, so it carries states:StartExecution and nothing else does.
    const translationRequestAPIIntegration = new HttpLambdaIntegration(
      'TranslationRequestAPIIntegration',
      this.lambdaFunctions.translationRequestFunction
    );
    this.httpAPI.restAPI.addRoutes({
      path: "/profile/children/{childId}/documents/{iepId}/translations",
      methods: [apigwv2.HttpMethod.POST],
      integration: translationRequestAPIIntegration,
      authorizer: httpAuthorizer,
    });

    const pdfGeneratorAPIIntegration = new HttpLambdaIntegration('PDFGeneratorAPIIntegration', this.lambdaFunctions.pdfGeneratorFunction);
    this.httpAPI.restAPI.addRoutes({
      path: "/generate-pdf",
      methods: [apigwv2.HttpMethod.POST],
      integration: pdfGeneratorAPIIntegration,
      authorizer: httpAuthorizer,
    });

    const ttsAPIIntegration = new HttpLambdaIntegration('TTSAPIIntegration', this.lambdaFunctions.ttsFunction);
    this.httpAPI.restAPI.addRoutes({
      path: "/documents/{iepId}/audio",
      methods: [apigwv2.HttpMethod.POST],
      integration: ttsAPIIntegration,
      authorizer: httpAuthorizer,
    });

    const referralAPIIntegration = new HttpLambdaIntegration('ReferralAPIIntegration', this.lambdaFunctions.referralFunction);

    // Click beacon is deliberately unauthenticated: visitors are not signed
    // in yet. It only increments counters for known active codes and stores
    // no PII, so exposure is limited to counter noise.
    this.httpAPI.restAPI.addRoutes({
      path: "/referral/click",
      methods: [apigwv2.HttpMethod.POST],
      integration: referralAPIIntegration,
    });

    this.httpAPI.restAPI.addRoutes({
      path: "/referral/me",
      methods: [apigwv2.HttpMethod.GET],
      integration: referralAPIIntegration,
      authorizer: httpAuthorizer,
    });

    this.httpAPI.restAPI.addRoutes({
      path: "/referral/attribute",
      methods: [apigwv2.HttpMethod.POST],
      integration: referralAPIIntegration,
      authorizer: httpAuthorizer,
    });

    // Admin routes: JWT here, membership in the Cognito 'admin' group is
    // enforced inside the Lambda (cognito:groups claim).
    this.httpAPI.restAPI.addRoutes({
      path: "/referral/admin/links",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: referralAPIIntegration,
      authorizer: httpAuthorizer,
    });

    this.httpAPI.restAPI.addRoutes({
      path: "/referral/admin/links/{code}",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT],
      integration: referralAPIIntegration,
      authorizer: httpAuthorizer,
    });

    this.httpAPI.restAPI.addRoutes({
      path: "/referral/admin/admins",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: referralAPIIntegration,
      authorizer: httpAuthorizer,
    });

    this.httpAPI.restAPI.addRoutes({
      path: "/referral/admin/admins/{username}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration: referralAPIIntegration,
      authorizer: httpAuthorizer,
    });

    // Prints out the AppSync GraphQL API key to the terminal
    new cdk.CfnOutput(this, "HTTP-API - apiEndpoint", {
      value: this.httpAPI.restAPI.apiEndpoint || "",
    });
  }
}