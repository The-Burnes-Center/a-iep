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
import { CfnUserPool } from 'aws-cdk-lib/aws-cognito';

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

    // 1. Create the Cognito User Pool with self sign-up and email/phone support
    const userPool = new UserPool(this, 'NewUserPool', {      
      removalPolicy: cdk.RemovalPolicy.DESTROY,
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
    // The Playwright suite signs in as real Cognito users whose numbers are
    // drawn from the NANP-fictional 555-01XX block (+1 555 555-01XX can
    // never be assigned to a real handset). For allowlisted numbers,
    // create-auth-challenge writes the OTP to SSM Parameter Store at
    // TEST_OTP_PARAM_PREFIX/<phone> instead of texting it, and the E2E
    // runner reads the parameter to complete login. The lambda double-guards
    // the gate: a number must BOTH be in TEST_PHONE_NUMBERS AND match its
    // hard-coded fictional-block regex, so even a misconfigured allowlist
    // can never divert a real user's code.
    //
    // +15555550101 / +15555550102 are the permanent SMOKE-test users and are
    // deliberately NOT in this allowlist: the smoke checks assert the real,
    // non-backdoored contract.
    //
    // Allowlist roles: 0111 = stable E2E login user, 0112 = lockout-journey
    // user, 0120-0129 = throwaway pool for the delete/re-signup journey.
    //
    // getEnvironment() distinguishes the stacks the same way resource naming
    // does (ENVIRONMENT=production => AIEPStack => 'prod'); production gets
    // none of this — no env vars, no ssm:PutParameter. The infra suite pins
    // both sides (test/infra/gen-ai-mvp-stack.test.ts).
    if (getEnvironment() !== 'prod') {
      const testPhoneNumbers = [
        '+15555550111',
        '+15555550112',
        // 0123 is deliberately absent: scripts/smoke-test.sh claims it as the
        // guaranteed-unknown-number probe, so it must never gain a user (and
        // keeping it out of the allowlist removes the foot-gun entirely).
        '+15555550120', '+15555550121', '+15555550122', '+15555550124',
        '+15555550125', '+15555550126', '+15555550127', '+15555550128', '+15555550129',
      ];
      createAuthChallengeFunction.addEnvironment('TEST_PHONE_NUMBERS', testPhoneNumbers.join(','));
      createAuthChallengeFunction.addEnvironment('TEST_OTP_PARAM_PREFIX', '/a-iep/staging/test-otp');
      createAuthChallengeFunction.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:PutParameter'],
        resources: [
          `arn:aws:ssm:us-east-1:${cdk.Aws.ACCOUNT_ID}:parameter/a-iep/staging/test-otp/*`
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
} 