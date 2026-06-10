import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { cognitoDomainName } from '../constants' 
import { UserPool, UserPoolIdentityProviderOidc, UserPoolClient, UserPoolClientIdentityProvider, ProviderAttribute } from 'aws-cdk-lib/aws-cognito';
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';
import { getTagProps, tagResource } from '../tags';
import * as iam from 'aws-cdk-lib/aws-iam';
import { CfnUserPool } from 'aws-cdk-lib/aws-cognito';
import { Logger } from '../chatbot-api/logging/logger';

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

    // Use the shared Logger for consistent logging
    const logger = Logger.getInstance();

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
    
    logger.logEvent({
      eventType: 'AUTHZ_STACK',
      action: 'Created CognitoSmsRole',
      resourceType: 'COGNITO',
      resourceId: cognitoSmsRole.roleArn,
      details: { roleArn: cognitoSmsRole.roleArn, externalId: this.node.addr },
    });

    // 4. Attach the SMS role to the user pool
    cfnUserPool.smsConfiguration = {
      externalId: this.node.addr,
      snsCallerArn: cognitoSmsRole.roleArn,
    };
    cfnUserPool.smsAuthenticationMessage = 'Your login code for The GovLab AIEP is: {####}. Do not share this code.';
    cfnUserPool.smsVerificationMessage = 'Your OTP from The GovLab AIEP is: {####}. Do not share this code. Msg & data rates may apply.';
    
    logger.logEvent({
      eventType: 'AUTHZ_STACK',
      action: 'Configured Cognito SMS settings',
      resourceType: 'COGNITO',
      resourceId: userPool.userPoolId,
      details: { userPoolId: userPool.userPoolId },
    });

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

    // Create Auth Challenge Function
    const createAuthChallengeFunction = new lambda.Function(this, 'CreateAuthChallengeFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(path.join(__dirname, '../chatbot-api/functions/phone-otp-auth')),
      handler: 'create-auth-challenge.handler',
      environment: {
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

    // Allow reading user profiles to localize the OTP SMS
    if (userProfilesTable) {
      createAuthChallengeFunction.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:GetItem'],
        resources: [userProfilesTable.tableArn]
      }));
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
      customMessageFunction.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:GetItem'],
        resources: [userProfilesTable.tableArn]
      }));
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

    // Add DynamoDB permissions for user profile creation (if table provided)
    if (userProfilesTable) {
      verifyAuthChallengeFunction.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem'
        ],
        resources: [userProfilesTable.tableArn]
      }));
    }

    // Allow Cognito to invoke the Lambda functions
    [defineAuthChallengeFunction, createAuthChallengeFunction, verifyAuthChallengeFunction, customMessageFunction].forEach(func => {
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

    console.log('Phone OTP Lambda triggers configured successfully');
  }
} 