import * as cdk from "aws-cdk-lib";
import { AuditTrail, SmsDeliveryStatusRole } from './audit/audit-trail';

import { RestBackendAPI } from "./gateway/rest-api"
import { LambdaFunctionStack } from "./functions/functions"
import { TableStack } from "./tables/tables"
import { S3BucketStack } from "./buckets/buckets"
import { LoggingStack } from "./logging/logging"
import { MonitoringStack } from "./monitoring/monitoring"

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
  /** Outage alerting. Subscribe AWS Chatbot to monitoring.alarmTopic. */
  public monitoring!: MonitoringStack;
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

    // Data-event audit logging for the FERPA stores. See AuditTrail: the
    // organisation trail is management-events only, so object and item reads
    // are currently unrecorded everywhere.
    // Production only: the SNS setting this serves is account-level, so one
    // role exists for the whole account. See SmsDeliveryStatusRole.
    if (getEnvironment() === 'prod') {
      new SmsDeliveryStatusRole(this, 'SmsDeliveryStatusRole');
    }

    new AuditTrail(this, 'AuditTrail', {
      documentBucket: this.buckets.knowledgeBucket,
      tables: [
        this.tables.userProfilesTable,
        this.tables.iepDocumentsTable,
        this.tables.referralsTable,
      ],
    });
    
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
    // Signup. The ONE unauthenticated route, necessarily: there is no token
    // to authorize with before an account exists. Everything that would
    // normally be an authorizer's job (anti-abuse, rate limiting, destination
    // policy) happens inside the handler instead, in that order.
    //
    // This route only becomes a control because the pool refuses self-service
    // signup. Before that, Cognito's public SignUp API was reachable from
    // anywhere and is exactly what the 2026-09-09 run used.
    const signupIntegration = new HttpLambdaIntegration(
      'SignupAPIIntegration', authentication.signupFunction);
    this.httpAPI.restAPI.addRoutes({
      path: "/auth/signup",
      methods: [apigwv2.HttpMethod.POST],
      integration: signupIntegration,
      authorizer: new apigwv2.HttpNoneAuthorizer(),
    })

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

    // Outage alerting. Created last so every lambda, table and rule it
    // watches already exists.
    this.monitoring = new MonitoringStack(this, "Monitoring", {
      pipelineFunctions: [
        { label: 'Mistral OCR', fn: this.lambdaFunctions.mistralOCRFunction, purpose: 'reads the text out of an uploaded IEP; runs once per upload' },
        { label: 'PII redaction', fn: this.lambdaFunctions.redactOCRFunction, purpose: 'strips personal details before anything reaches an LLM; runs once per upload' },
        { label: 'delete original', fn: this.lambdaFunctions.deleteOriginalFunction, purpose: 'deletes the unredacted upload once text is extracted; runs once per upload' },
        { label: 'parsing agent', fn: this.lambdaFunctions.parsingAgentFunction, purpose: 'writes the plain-language summary and sections; runs once per upload' },
        { label: 'language prefs', fn: this.lambdaFunctions.checkLanguagePrefsFunction, purpose: 'decides which languages a summary is translated into' },
        { label: 'translation', fn: this.lambdaFunctions.translateContentFunction, purpose: 'translates the summary into the languages a family asked for' },
        { label: 'finalize results', fn: this.lambdaFunctions.finalizeResultsFunction, purpose: 'assembles the finished summary and marks the document ready' },
        { label: 'orchestrator', fn: this.lambdaFunctions.orchestratorFunction, purpose: 'starts the pipeline when a document lands' },
      ],
      authTriggerFunctions: [
        ...authentication.authTriggerFunctions,
        // PostConfirmation. It rotates a phone signup's client-chosen
        // password, which is the only thing making auto-confirm safe, and on
        // failure it disables the account instead. Either way a failure here
        // costs a parent their account, so it belongs with the auth triggers
        // rather than in the API list.
        { label: 'PostConfirmation (secures a new account)', fn: this.lambdaFunctions.cognitoTriggerFunction,
          purpose: 'secures a newly created account; runs once per signup' },
      ],
      // Its own field, not one of the lists: this is the only way to create
      // an account, so its alarms say "signup broken" rather than "an API
      // handler is failing", and most of its failures are 4xx refusals that
      // no Errors or 5xx metric can see.
      signupFunction: {
        label: 'signup', fn: authentication.signupFunction,
        purpose: 'the only way to create an account; runs once per new family',
      },
      apiFunctions: [
        { label: 'user profile', fn: this.lambdaFunctions.userProfileFunction, purpose: 'the account screen: name, child, languages, and account deletion' },
        { label: 'upload', fn: this.lambdaFunctions.uploadS3KnowledgeFunction, purpose: 'accepts an IEP upload from a parent' },
        { label: 'referrals', fn: this.lambdaFunctions.referralFunction, purpose: 'invite links and the referral admin console' },
        { label: 'TTS', fn: this.lambdaFunctions.ttsFunction, purpose: 'reads a summary aloud; runs when a parent taps play' },
        { label: 'PDF download', fn: this.lambdaFunctions.pdfGeneratorFunction, purpose: 'renders a summary as a PDF; runs when a parent downloads one' },
        // Silent failure here shows a parent an empty document list, or a
        // delete that appears to work and does not.
        { label: 'documents list', fn: this.lambdaFunctions.getS3KnowledgeFunction, purpose: 'lists the documents on an account; runs on every visit to that page' },
        { label: 'document delete', fn: this.lambdaFunctions.deleteS3Function, purpose: 'deletes a document at a parent request' },
        // The "translate it now" request path.
        { label: 'translation request', fn: this.lambdaFunctions.translationRequestFunction, purpose: 'handles "translate it now"; runs only when a parent asks' },
        // Writes every pipeline progress and failure record.
        { label: 'pipeline database writes', fn: this.lambdaFunctions.ddbServiceFunction, purpose: 'records pipeline progress and failures for every document' },
      ],
      ddbServiceFunction: this.lambdaFunctions.ddbServiceFunction,
      iepProcessingStateMachine: this.lambdaFunctions.iepProcessingStateMachine,
      translationStateMachine: this.lambdaFunctions.singleLanguageTranslationStateMachine,
      pendingUploadSweepRule: this.lambdaFunctions.pendingUploadSweepRule,
      tables: [
        { label: 'IEP documents', table: this.tables.iepDocumentsTable },
        { label: 'user profiles', table: this.tables.userProfilesTable },
        { label: 'referrals', table: this.tables.referralsTable },
        // Throttling here now stops login outright, because the service-wide
        // SMS budget fails closed on a DynamoDB error.
        { label: 'login rate limiting', table: authentication.otpRateLimitTable },
      ],
      httpApi: this.httpAPI.restAPI,
      kmsKey: appKmsKey,
    });

    // Prints out the AppSync GraphQL API key to the terminal
    new cdk.CfnOutput(this, "HTTP-API - apiEndpoint", {
      value: this.httpAPI.restAPI.apiEndpoint || "",
    });
  }
}