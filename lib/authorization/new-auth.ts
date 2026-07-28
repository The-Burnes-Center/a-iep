import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { cognitoDomainName } from '../constants' 
import { UserPool, UserPoolIdentityProviderOidc, UserPoolClient, UserPoolClientIdentityProvider, ProviderAttribute } from 'aws-cdk-lib/aws-cognito';
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as path from 'path';
import { getEnvironment, getTagProps, tagResource } from '../tags';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { CfnUserPool } from 'aws-cdk-lib/aws-cognito';

// ── Staging-only E2E test backdoor: the shared allowlist ─────────────────
// The Playwright suite signs in as real Cognito users whose numbers are drawn
// from the NANP-fictional 555-01XX block (+1 555 555-01XX can never be
// assigned to a real handset). For allowlisted numbers the OTP is written to
// SSM Parameter Store at TEST_OTP_PARAM_PREFIX/<phone without '+'> instead of
// being texted, and the E2E runner reads the parameter to continue. Two
// lambdas implement that, over the two different code mints:
//
//   - create-auth-challenge.js  — the codes OUR custom-auth flow generates
//     (sign-in OTP);
//   - custom-sms-sender/index.js — the codes COGNITO generates (sign-up and
//     attribute verification), which are otherwise unreachable from CI.
//
// Both lambdas double-guard the gate: a number must BOTH be in
// TEST_PHONE_NUMBERS AND match a hard-coded fictional-block regex, so even a
// misconfigured allowlist can never divert a real user's code.
//
// +15555550101 / +15555550102 are the permanent SMOKE-test users and are
// deliberately NOT in this allowlist: the smoke checks assert the real,
// non-backdoored contract.
//
// Allowlist roles: 0111 = stable E2E login user, 0112 = lockout-journey user,
// 0113 = profile-journey user, 0114 = documents-journey user,
// 0120-0129 = throwaway pool for the delete/re-signup journey.
const TEST_PHONE_NUMBERS = [
  '+15555550111',
  '+15555550112',
  '+15555550113',
  '+15555550114',
  // 0123 is deliberately absent: scripts/smoke-test.sh claims it as the
  // guaranteed-unknown-number probe, so it must never gain a user (and
  // keeping it out of the allowlist removes the foot-gun entirely).
  '+15555550120', '+15555550121', '+15555550122', '+15555550124',
  '+15555550125', '+15555550126', '+15555550127', '+15555550128', '+15555550129',
];

// Where the backdoored codes land. Both lambdas read this from the
// TEST_OTP_PARAM_PREFIX env var; both IAM grants below scope
// ssm:PutParameter to exactly this subtree.
const TEST_OTP_PARAM_PREFIX = '/a-iep/staging/test-otp';

/**
 * Props for NewAuthorizationStack
 */
export interface NewAuthorizationStackProps extends cdk.StackProps {
  userProfilesTable?: any; // DynamoDB table for user profiles
}

/**
 * CDK Construct for Cognito User Pool and SMS configuration for AI-IEP authentication.
 *
 * - Creates a Cognito User Pool with self sign-up, email/phone support, and optional SMS-MFA.
 * - Configures an IAM Role for Cognito SMS with trust policy conditions.
 * - Adds a CfnUserPoolSmsConfiguration for custom SMS messages.
 * - Sets up Lambda triggers for Phone OTP authentication.
 * - Applies standard tags and outputs resource ARNs/IDs.
 */
export class NewAuthorizationStack extends Construct {
  public readonly userPool: UserPool;
  public readonly userPoolClient: UserPoolClient;

  constructor(scope: Construct, id: string, props?: NewAuthorizationStackProps) {
    super(scope, id);

    // 0. Staging-only key for the CustomSMSSender trigger.
    //
    // Cognito — not our custom-auth lambda — mints and texts the SIGN-UP
    // verification code, so the SSM backdoor in create-auth-challenge can't
    // reach it and an E2E run can start a signup but never confirm one. A
    // CustomSMSSender trigger is the only supported interception point, and
    // Cognito always hands that trigger the code encrypted (AWS Encryption
    // SDK) under a customer-managed KMS key. Hence a key that exists purely
    // to move a fictional test number's code out of SMS and into SSM.
    //
    // The key must be known at UserPool CONSTRUCTION time: customSenderKmsKey
    // is a props-only field, and addTrigger(CUSTOM_SMS_SENDER, ...) throws
    // unless the pool already carries a key id. That's why it is computed
    // here and spread into the props below rather than attached later.
    //
    // DESTROY is right: nothing durable is encrypted with it (codes live for
    // minutes), so a torn-down staging stack should not leave a key behind.
    // The deploying principal also needs kms:CreateGrant on this key —
    // Cognito's one-time grant is created by whoever updates the pool — which
    // the CDK default key policy (account root) plus the CFN execution role
    // already covers.
    const customSenderKey = getEnvironment() !== 'prod'
      ? new kms.Key(this, 'CustomSenderKey', {
          alias: 'a-iep-staging-custom-sender',
          description: 'Encrypts Cognito codes handed to the staging CustomSMSSender trigger',
          enableKeyRotation: true,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        })
      : undefined;

    // 1. Create the Cognito User Pool with self sign-up and email/phone support
    const userPool = new UserPool(this, 'NewUserPool', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      // Staging only; production keeps Cognito's native SMS delivery, so it
      // registers no key and no custom sender (pinned by the infra suite).
      ...(customSenderKey ? { customSenderKmsKey: customSenderKey } : {}),
      selfSignUpEnabled: true,
      mfa: cognito.Mfa.OPTIONAL,
      autoVerify: { email: true, phone: true },
      signInAliases: {
        email: true,
        phone: true,
      },
      passwordPolicy: {
        minLength: 8,
        requireDigits: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_AND_PHONE_WITHOUT_MFA,
      customAttributes: {
        'role': new cognito.StringAttribute({ minLen: 0, maxLen: 30, mutable: true })
      },
    });
    this.userPool = userPool;

    // Internal admin group: gates the referral admin API and console.
    // Existing admins manage membership from /admin/referrals (self-removal
    // is blocked); it can also be edited via the Cognito console or CLI.
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'admin',
      description: 'A-IEP internal admins (referral console access)',
    });

    // 2. Create the IAM Role for Cognito SMS via SNS
    const cognitoSmsRole = new iam.Role(this, 'CognitoSmsRole', {
      assumedBy: new iam.ServicePrincipal('cognito-idp.amazonaws.com'),
      inlinePolicies: {
        'AllowSnsPublish': new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['sns:Publish'],
              resources: ['*'], // For production, restrict to your SNS topic(s)
            }),
          ],
        }),
      },
    });

    // 3. Add the trust policy override referencing the User Pool logical ID
    const cfnRole = cognitoSmsRole.node.defaultChild as iam.CfnRole;
    const cfnUserPool = userPool.node.defaultChild as CfnUserPool;
    cfnRole.addPropertyOverride('AssumeRolePolicyDocument.Statement.0.Condition', {
      'StringEquals': { 'sts:ExternalId': this.node.addr }
    });

    // 4. Attach the SMS role to the user pool
    cfnUserPool.smsConfiguration = {
      externalId: this.node.addr,
      snsCallerArn: cognitoSmsRole.roleArn,
    };
    cfnUserPool.smsAuthenticationMessage = 'Your login code for The GovLab AIEP is: {####}. Do not share this code.';
    cfnUserPool.smsVerificationMessage = 'Your OTP from The GovLab AIEP is: {####}. Do not share this code. Msg & data rates may apply.';

    // 5. Create Lambda functions for Phone OTP authentication
    this.createPhoneOtpLambdaTriggers(userPool, props?.userProfilesTable);

    // 5b. Staging only: take over the pool's own SMS delivery so the E2E
    // suite can read Cognito-generated signup codes. Guarded by the same
    // getEnvironment() check that produced customSenderKey above.
    if (customSenderKey) {
      this.createCustomSmsSender(userPool, customSenderKey);
    }

    // Apply standard tags to the User Pool
    tagResource(userPool, {
      'Resource': 'NewUserPool',
      'Module': 'Authentication'
    });

    // Create a unique domain prefix for the new user pool
    userPool.addDomain('NewCognitoDomain', {
      cognitoDomain: {
        domainPrefix: cognitoDomainName + '-new',
      },
    });
    
    const userPoolClient = new UserPoolClient(this, 'NewUserPoolClient', {
      userPool,
      authFlows: {
        userPassword: true,
        userSrp: true,
        custom: true,  // Enable CUSTOM_AUTH flow for Phone OTP
      },
      // The whole custom-auth flow (language handshake + OTP rounds) must
      // finish inside this window. Align it with the 5-minute validity the
      // OTP SMS promises; create/verify-auth-challenge enforce the same
      // bound per code via privateChallengeParameters.issuedAt.
      authSessionValidity: cdk.Duration.minutes(5),
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.PROFILE,
          cognito.OAuthScope.COGNITO_ADMIN
        ],
        callbackUrls: [
          'http://localhost:3000',
          'https://localhost:3000',
          'http://localhost:5173',
          'https://localhost:5173',
        ],
        logoutUrls: [
          'http://localhost:3000',
          'https://localhost:3000',
          'http://localhost:5173',
          'https://localhost:5173',
        ],
      },
      supportedIdentityProviders: [
        UserPoolClientIdentityProvider.COGNITO
      ],
      preventUserExistenceErrors: true,
    });

    this.userPoolClient = userPoolClient;
    
    new cdk.CfnOutput(this, "New UserPool ID", {
      value: userPool.userPoolId || "",
    });

    new cdk.CfnOutput(this, "New UserPool Client ID", {
      value: userPoolClient.userPoolClientId || "",
    });
    
    new cdk.CfnOutput(this, "New Cognito Domain", {
      value: `https://${cognitoDomainName}-new.auth.${cdk.Aws.REGION}.amazoncognito.com` || "",
    });
    
    new cdk.CfnOutput(this, "New Cognito Console URL", {
      value: `https://${cdk.Aws.REGION}.console.aws.amazon.com/cognito/v2/idp/user-pools/${userPool.userPoolId}/users` || "",
    });

    new cdk.CfnOutput(this, "CognitoSmsRoleArn", {
      value: cognitoSmsRole.roleArn,
    });
  }

  /**
   * Create and configure Lambda triggers for Phone OTP authentication
   */
  private createPhoneOtpLambdaTriggers(userPool: UserPool, userProfilesTable?: any) {
    // Define Auth Challenge Function
    const defineAuthChallengeFunction = new lambda.Function(this, 'DefineAuthChallengeFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(path.join(__dirname, '../chatbot-api/functions/phone-otp-auth')),
      handler: 'define-auth-challenge.handler',
      timeout: cdk.Duration.seconds(30),
      logRetention: cdk.aws_logs.RetentionDays.ONE_YEAR,
      description: 'Define Auth Challenge for Phone OTP authentication'
    });

    // Hourly per-phone SMS budget for the OTP flow. The counter must live
    // outside the auth session (Cognito resets the session on every
    // InitiateAuth, so in-session state can never rate-limit SMS sends).
    // Keys are sha256(phone) + hour bucket, so no raw phone numbers are
    // stored, and rows expire via TTL, keeping the table tiny.
    const otpRateLimitTable = new dynamodb.Table(this, 'OtpRateLimitTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    tagResource(otpRateLimitTable, {
      'Resource': 'OtpRateLimitTable',
      'Module': 'Authentication'
    });

    // Create Auth Challenge Function
    const createAuthChallengeFunction = new lambda.Function(this, 'CreateAuthChallengeFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(path.join(__dirname, '../chatbot-api/functions/phone-otp-auth')),
      handler: 'create-auth-challenge.handler',
      environment: {
        OTP_RATE_LIMIT_TABLE: otpRateLimitTable.tableName,
        ...(userProfilesTable && { USER_PROFILES_TABLE: userProfilesTable.tableName })
      },
      timeout: cdk.Duration.seconds(30),
      logRetention: cdk.aws_logs.RetentionDays.ONE_YEAR,
      description: 'Create Auth Challenge for Phone OTP authentication'
    });

    // Add SNS permissions for sending SMS
    createAuthChallengeFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'sns:Publish'
      ],
      resources: ['*'] // SNS publish requires * for phone numbers
    }));

    // ── Staging-only E2E OTP backdoor ────────────────────────────────────
    // create-auth-challenge's half of the backdoor described at the top of
    // this file: for an allowlisted number it writes the sign-in OTP to SSM
    // instead of texting it. (Cognito's own signup codes are handled by the
    // custom SMS sender in createCustomSmsSender below.)
    //
    // getEnvironment() distinguishes the stacks the same way resource naming
    // does (ENVIRONMENT=production => AIEPStack => 'prod'); production gets
    // none of this — no env vars, no ssm:PutParameter. The infra suite pins
    // both sides (test/infra/gen-ai-mvp-stack.test.ts).
    if (getEnvironment() !== 'prod') {
      createAuthChallengeFunction.addEnvironment('TEST_PHONE_NUMBERS', TEST_PHONE_NUMBERS.join(','));
      createAuthChallengeFunction.addEnvironment('TEST_OTP_PARAM_PREFIX', TEST_OTP_PARAM_PREFIX);
      createAuthChallengeFunction.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:PutParameter'],
        resources: [
          `arn:aws:ssm:us-east-1:${cdk.Aws.ACCOUNT_ID}:parameter${TEST_OTP_PARAM_PREFIX}/*`
        ]
      }));
    }

    // UpdateItem on the SMS rate-limit counter
    otpRateLimitTable.grantWriteData(createAuthChallengeFunction);

    // Allow reading user profiles to localize the OTP SMS. grantReadData
    // (rather than a manual GetItem policy) also grants kms:Decrypt on the
    // table's customer-managed encryption key — without it the profile
    // lookup fails with AccessDeniedException and falls back to English.
    if (userProfilesTable) {
      userProfilesTable.grantReadData(createAuthChallengeFunction);
    }

    // Custom Message Function - localizes Cognito's verification / forgot
    // password / MFA messages (SMS and email) to the user's language
    const customMessageFunction = new lambda.Function(this, 'CustomMessageFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(path.join(__dirname, '../chatbot-api/functions/phone-otp-auth')),
      handler: 'custom-message.handler',
      environment: {
        ...(userProfilesTable && { USER_PROFILES_TABLE: userProfilesTable.tableName })
      },
      timeout: cdk.Duration.seconds(30),
      logRetention: cdk.aws_logs.RetentionDays.ONE_YEAR,
      description: 'Localize Cognito SMS and email messages'
    });

    if (userProfilesTable) {
      // Includes kms:Decrypt for the table's customer-managed key
      userProfilesTable.grantReadData(customMessageFunction);
    }

    // Pre Authentication Function - stamps the sign-in screen's UI language
    // onto the user profile so create-auth-challenge can localize the OTP
    // SMS. Cognito forwards InitiateAuth clientMetadata to this trigger (as
    // validationData) but NOT to create-auth-challenge, so this is the only
    // path from the login screen's language picker to the SMS.
    const preAuthenticationFunction = new lambda.Function(this, 'PreAuthenticationFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(path.join(__dirname, '../chatbot-api/functions/phone-otp-auth')),
      handler: 'pre-authentication.handler',
      environment: {
        ...(userProfilesTable && { USER_PROFILES_TABLE: userProfilesTable.tableName })
      },
      timeout: cdk.Duration.seconds(30),
      logRetention: cdk.aws_logs.RetentionDays.ONE_YEAR,
      description: 'Stamp sign-in UI language for OTP SMS localization'
    });

    // grantReadWriteData (not a manual UpdateItem policy) also covers the
    // KMS permissions for the table's customer-managed encryption key
    if (userProfilesTable) {
      userProfilesTable.grantReadWriteData(preAuthenticationFunction);
    }

    // Verify Auth Challenge Function
    const verifyAuthChallengeFunction = new lambda.Function(this, 'VerifyAuthChallengeFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(path.join(__dirname, '../chatbot-api/functions/phone-otp-auth')),
      handler: 'verify-auth-challenge.handler',
      environment: {
        ...(userProfilesTable && { USER_PROFILES_TABLE: userProfilesTable.tableName })
      },
      timeout: cdk.Duration.seconds(30),
      logRetention: cdk.aws_logs.RetentionDays.ONE_YEAR,
      description: 'Verify Auth Challenge for Phone OTP authentication'
    });

    // Add DynamoDB permissions for user profile creation (if table provided).
    // grantReadWriteData also covers the KMS encrypt/decrypt permissions for
    // the table's customer-managed key; with the previous manual GetItem/
    // PutItem policy, profile creation for new phone users failed silently
    // with a KMS AccessDeniedException.
    if (userProfilesTable) {
      userProfilesTable.grantReadWriteData(verifyAuthChallengeFunction);
    }

    // Allow Cognito to invoke the Lambda functions
    [defineAuthChallengeFunction, createAuthChallengeFunction, verifyAuthChallengeFunction, customMessageFunction, preAuthenticationFunction].forEach(func => {
      func.addPermission('CognitoInvocation', {
        principal: new iam.ServicePrincipal('cognito-idp.amazonaws.com'),
        action: 'lambda:InvokeFunction',
        sourceArn: userPool.userPoolArn
      });
    });

    // Add the Lambda triggers to Cognito User Pool
    userPool.addTrigger(
      cognito.UserPoolOperation.DEFINE_AUTH_CHALLENGE,
      defineAuthChallengeFunction
    );

    userPool.addTrigger(
      cognito.UserPoolOperation.CREATE_AUTH_CHALLENGE,
      createAuthChallengeFunction
    );

    userPool.addTrigger(
      cognito.UserPoolOperation.VERIFY_AUTH_CHALLENGE_RESPONSE,
      verifyAuthChallengeFunction
    );

    userPool.addTrigger(
      cognito.UserPoolOperation.CUSTOM_MESSAGE,
      customMessageFunction
    );

    userPool.addTrigger(
      cognito.UserPoolOperation.PRE_AUTHENTICATION,
      preAuthenticationFunction
    );

    console.log('Phone OTP Lambda triggers configured successfully');
  }

  /**
   * STAGING ONLY. Assign a CustomSMSSender trigger so the E2E suite can read
   * the codes COGNITO generates (signup / attribute verification), which the
   * create-auth-challenge backdoor cannot reach.
   *
   * Assigning this trigger switches OFF Cognito's built-in SMS delivery for
   * the entire pool: every message the pool would have texted is handed to
   * this lambda instead, which either stashes it in SSM (allowlisted
   * fictional numbers) or publishes it to SNS itself. That is why the
   * function is only wired on staging and why its real-number path duplicates
   * the pool's own message templates — see the comment on those constants in
   * lib/chatbot-api/functions/custom-sms-sender/index.js.
   *
   * The custom-auth sign-in OTP is unaffected either way: create-auth-challenge
   * publishes to SNS directly and never routes through Cognito's SMS delivery.
   */
  private createCustomSmsSender(userPool: UserPool, customSenderKey: kms.IKey) {
    const customSmsSenderFunction = new lambda.Function(this, 'CustomSmsSenderFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      // The AWS Encryption SDK (@aws-crypto/client-node) is not in the Lambda
      // runtime, so this asset is bundled with `npm ci` at deploy time, the
      // same way pdf-generator is. node_modules stays out of the SOURCE hash
      // so a laptop deploy and a clean CI checkout produce the same asset.
      code: lambda.Code.fromAsset(path.join(__dirname, '../chatbot-api/functions/custom-sms-sender'), {
        assetHashType: cdk.AssetHashType.SOURCE,
        exclude: ['node_modules'],
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: [
            'bash', '-c',
            'npm --cache /tmp/.npm ci && cp -au . /asset-output'
          ],
        },
      }),
      handler: 'index.handler',
      environment: {
        // The keyring the lambda builds to decrypt event.request.code; it must
        // be the same key the pool encrypts with (customSenderKmsKey above).
        KMS_KEY_ARN: customSenderKey.keyArn,
        // Same double gate as create-auth-challenge, same list.
        TEST_PHONE_NUMBERS: TEST_PHONE_NUMBERS.join(','),
        TEST_OTP_PARAM_PREFIX: TEST_OTP_PARAM_PREFIX,
      },
      timeout: cdk.Duration.seconds(30),
      logRetention: cdk.aws_logs.RetentionDays.ONE_YEAR,
      description: 'Staging-only Cognito custom SMS sender: stashes E2E codes in SSM, texts everything else'
    });

    // Decrypt only. The lambda never encrypts (Cognito does that), so a
    // grantDecrypt is the whole of its key access.
    customSenderKey.grantDecrypt(customSmsSenderFunction);

    // Same prefix-scoped write as create-auth-challenge: a widened resource
    // would let this lambda scribble over real config parameters.
    customSmsSenderFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:PutParameter'],
      resources: [
        `arn:aws:ssm:us-east-1:${cdk.Aws.ACCOUNT_ID}:parameter${TEST_OTP_PARAM_PREFIX}/*`
      ]
    }));

    customSmsSenderFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['sns:Publish'],
      resources: ['*'] // SNS publish requires * for phone numbers
    }));

    // addTrigger also adds the cognito-idp.amazonaws.com invoke permission and
    // stamps LambdaVersion V1_0 (the only version custom senders support).
    userPool.addTrigger(
      cognito.UserPoolOperation.CUSTOM_SMS_SENDER,
      customSmsSenderFunction
    );

    console.log('Staging custom SMS sender trigger configured successfully');
  }
} 