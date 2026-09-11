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
import { createIepDataDenyStatement } from '../chatbot-api/security';

// Allowed OTP destinations, as E.164 dialling prefixes. A-IEP serves families
// in the United States, so +1 covers every real user, and refusing anything
// else is a load-bearing abuse control. The fictional test numbers below are
// NANP and so are already covered by +1.
//
// Deliberately still in source: an allowlist of countries a public-interest
// service will text is worth being publicly auditable, and knowing it is +1
// helps nobody attack it. The numeric ceilings are the opposite case and are
// NOT here; see SMS_POLICY_PARAM_PREFIX.
const SMS_ALLOWED_COUNTRY_CODES = ['+1'];

// Where the operational SMS ceilings live. The parameters under this prefix
// are created OUT OF BAND, never by CDK: a value set in this repo would be a
// value published in it, which is the whole thing this avoids. The lambda
// falls back to compiled floors that are tighter than the real numbers, so a
// missing or unreadable parameter narrows the service instead of widening it.
//
//   <prefix>/allowed-country-codes   e.g. "+1"
//   <prefix>/max-per-hour-global     positive integer
//   <prefix>/max-per-day-global      positive integer
const SMS_POLICY_PARAM_PREFIX = `/a-iep/${getEnvironment()}/sms-policy`;

// Where the Cloudflare Turnstile secret lives. Created OUT OF BAND as a
// SecureString, never by CDK: a secret written here would be a secret
// published in a public repo.
//
// Enforcement switches on the moment the parameter exists, with no deploy.
// CDK passes the NAME and the trigger reads the VALUE, so until someone
// creates it, pre-sign-up treats signups as unverified and says so in the
// logs. That is the only safe rollout order, because failing closed on a
// parameter nobody has created yet would break every signup.
const TURNSTILE_SECRET_PARAM = `/a-iep/${getEnvironment()}/turnstile/secret`;

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

// The email half of the same allowlist, for the /auth/start and /auth/verify
// journeys. `a-iep.invalid` is reserved by RFC 2606 and can never be
// delegated, which makes it the email equivalent of the NANP 555-01XX block:
// a leaked bypass token cannot be pointed at an address a real person could
// receive mail at. create-auth-challenge and destination.js both re-check the
// domain against a hard-coded expression regardless of this list.
const TEST_EMAIL_ADDRESSES = [
  'e2e-login@a-iep.invalid',
  'e2e-lockout@a-iep.invalid',
  'e2e-signup@a-iep.invalid',
];

// Where the backdoored codes land. Both lambdas read this from the
// TEST_OTP_PARAM_PREFIX env var; both IAM grants below scope
// ssm:PutParameter to exactly this subtree.
const TEST_OTP_PARAM_PREFIX = '/a-iep/staging/test-otp';

// ── Reserved concurrency on the auth path ────────────────────────────────
//
// Nothing in this repo reserved concurrency on anything before this. That cut
// both ways and both of them matter once every sign-in funnels through these
// functions: a document-pipeline burst can starve login, and a login flood can
// starve the pipeline.
//
// TWENTY, and the number is chosen rather than copied. Reserved concurrency is
// a hard CAP as well as a floor: past it Lambda returns 429 at invoke time,
// before the handler runs, and on this path the thing it sheds is a parent's
// sign-in. So the cap has to sit far above any real peak.
//
// Real demand is a few dozen sign-ins a day. A sign-in holds a container for
// roughly a second, so twenty concurrent executions is on the order of twenty
// sign-ins a second, or 72,000 an hour -- about three orders of magnitude
// above anything this service has seen. The service-wide SMS and email
// budgets (50 an hour) bind thousands of times sooner, so in practice this cap
// can only ever be reached by traffic that is already being refused upstream.
//
// The account has 1,000 concurrent executions with 940 unreserved, so four
// functions at twenty costs 80 and leaves 860 for everything else.
const AUTH_RESERVED_CONCURRENCY = 20;

// Staging-only bypass for the signup bot check, same gate and same reasoning
// as the OTP backdoor above. Turnstile refuses automated browsers by design,
// so the real widget and an automated signup cannot both work; staging keeps
// the real widget for anyone testing by hand, and only the E2E runner holds
// this. The endpoint additionally requires one of TEST_PHONE_NUMBERS, so a
// leaked token cannot create an account on a number a person could receive a
// text on. Created out of band, like every other credential here.
const E2E_TURNSTILE_BYPASS_PARAM = '/a-iep/staging/e2e-turnstile-bypass';

/**
 * Props for NewAuthorizationStack
 */
export interface NewAuthorizationStackProps extends cdk.StackProps {
  userProfilesTable?: any; // DynamoDB table for user profiles
  /** The application CMK. The session table holds live Cognito refresh tokens
   *  for every signed-in family, so it is encrypted with the same key as the
   *  IEP documents rather than an AWS-managed one. */
  kmsKey?: kms.IKey;
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
  /** The custom-auth triggers, so MonitoringStack can alarm on each one:
   *  an error in any of these locks families out. Label is the name a
   *  human reads in Slack. */
  public readonly authTriggerFunctions: { label: string; fn: lambda.Function; purpose: string }[] = [];
  public readonly userPool: UserPool;
  /** Exposed so monitoring can alarm on throttling: the service-wide SMS
   *  budget fails closed on a DynamoDB error, so throttling here stops
   *  login outright rather than just slowing it. */
  public otpRateLimitTable!: dynamodb.Table;
  /** The only way to create an account, once the pool refuses self-service
   *  signup. Exposed so ChatbotAPI can put an unauthenticated route on it:
   *  there is no token to authorize with before an account exists. */
  public signupFunction!: lambda.Function;
  /** The client the BROWSER holds. Still carries ALLOW_CUSTOM_AUTH; see the
   *  rollout note beside it. */
  public readonly userPoolClient: UserPoolClient;
  /** The client only this backend holds, with a client secret. Its id is an
   *  extra audience on the API's JWT authorizer, because tokens minted through
   *  it carry it as `aud` / `client_id` and would otherwise be rejected by
   *  every route the moment a parent signed in the new way. */
  public readonly backendAuthClient!: UserPoolClient;
  /** Server-side sessions: the in-flight challenge, and the Cognito tokens
   *  that never reach the browser. */
  public authSessionTable!: dynamodb.Table;
  /** The /auth/* handlers, exposed so ChatbotAPI can route to them and
   *  MonitoringStack can alarm on them. */
  public authStartFunction!: lambda.Function;
  public authVerifyFunction!: lambda.Function;
  public authSessionFunction!: lambda.Function;
  /** Off the request path: does the work /auth/start deliberately defers. */
  public authDispatchFunction!: lambda.Function;

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
      // RETAIN: this pool IS every family's login. Cognito cannot export or
      // re-import password/phone credentials, so a replaced or destroyed pool
      // locks every parent out permanently, with no restore path. It was
      // DESTROY until 2026-07-29, in the same audit that found the knowledge
      // bucket's DESTROY + autoDeleteObjects had let a 2026-06-22 rename
      // (edc7d2d) delete 50 of 102 production IEP documents. Do not flip this
      // back; pinned by test/infra/gen-ai-mvp-stack.test.ts.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // Cognito's OWN guard, and a different failure mode than the RETAIN
      // above. removalPolicy only stops CloudFormation from deleting or
      // replacing this resource; it does nothing against a direct
      // DeleteUserPool API call, which never goes through CloudFormation at
      // all. deletionProtection is Cognito's server-side switch for exactly
      // that call (renders as DeletionProtection: 'ACTIVE'; verified
      // 2026-09-10 that both pools -- us-east-1_Lhz0SBaFU staging/30 users,
      // us-east-1_xhit0fN1J prod/296 users -- were sitting on 'INACTIVE').
      // Same consequence as losing RETAIN: credentials cannot be exported, so
      // a deleted pool locks every family out permanently. Pinned by
      // test/infra/gen-ai-mvp-stack.test.ts in both environments.
      deletionProtection: true,
      // Staging only; production keeps Cognito's native SMS delivery, so it
      // registers no key and no custom sender (pinned by the infra suite).
      ...(customSenderKey ? { customSenderKmsKey: customSenderKey } : {}),
      // FALSE, and this is the change that actually closes the hole.
      //
      // Cognito's SignUp API is public: any caller with the app client id,
      // which necessarily ships in the browser bundle, can create accounts.
      // On 2026-09-09 that is precisely what happened, without the attacker
      // ever loading the site. Everything we can enforce in our own code is
      // downstream of that, so while this stayed true the front door was open
      // no matter what we put behind it.
      //
      // With it false, AdminCreateUser is the only route in, and only the
      // signup endpoint holds that permission. The cost is that neither
      // PreSignUp_SignUp nor PostConfirmation_ConfirmSignUp fires any more,
      // so auto-confirm and the password rotation both move into that
      // endpoint. See signup-endpoint.js.
      selfSignUpEnabled: false,
      // Pinned, not chosen. Both live pools are already ESSENTIALS, put there
      // OUT OF BAND, and CDK set neither this nor the sign-in policy below --
      // so the repo did not know its own pools allowed SMS_OTP as a native
      // first auth factor, and a deploy could have silently changed the tier
      // (and the bill, and which features exist) with nothing to review it
      // against. Declaring the value that is already live changes nothing
      // today and makes the next change to it visible.
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
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

    // 4b. The sign-in policy, which aws-cdk-lib 2.177's L2 UserPool cannot
    // express (no `signInPolicy` prop yet), so it drops to the L1 the same way
    // smsConfiguration above does. addPropertyOverride MERGES, which matters:
    // Policies already carries the PasswordPolicy from the L2 props and
    // assigning cfnUserPool.policies wholesale would silently drop it.
    //
    // PASSWORD and nothing else. Both live pools currently read
    // ['PASSWORD', 'SMS_OTP'], set out of band, which means Cognito's native
    // passwordless SMS flow is ENABLED at the pool and unreachable only
    // because no app client requests ALLOW_USER_AUTH. That is one
    // ExplicitAuthFlows edit away from being an OTP send path with no
    // Turnstile, no suppression check, no per-parent language and none of the
    // alarms in front of it -- and nobody reviewing that edit would think to
    // check it against a document. Removing SMS_OTP here takes nothing away:
    // no client can reach it today, and SMS MFA is a different setting
    // (MfaConfiguration / EnabledMfas) that this does not touch.
    //
    // AllowedFirstAuthFactors must include PASSWORD when it is set at all.
    cfnUserPool.addPropertyOverride('Policies.SignInPolicy.AllowedFirstAuthFactors', ['PASSWORD']);

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
    
    // ── The client the BROWSER holds ──────────────────────────────────────
    //
    // TODO(rollout step 2a): REMOVE `custom: true` from this client once the
    // frontend posts to /auth/start and /auth/verify instead of calling
    // InitiateAuth itself.
    //
    // That removal is the change that actually closes the hole. The app client
    // id necessarily ships in the browser bundle and InitiateAuth is a public,
    // unauthenticated API, so while ALLOW_CUSTOM_AUTH is on this client anyone
    // who knows a registered number can loop it and A-IEP will text that
    // number, with no bot check anywhere in the path. Closing self-service
    // SignUp stopped an attacker CREATING accounts; it does nothing about
    // making us SEND to the 221 that already exist.
    //
    // It is deliberately NOT removed in the same change that adds the new
    // endpoints. The deployed frontend calls InitiateAuth directly, so taking
    // it away now would break sign-in for every parent the moment it landed.
    // Both paths run side by side until the frontend has switched.
    // test/infra/gen-ai-mvp-stack.test.ts pins the current state and names
    // this as the follow-up.
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

    // ── The client only the BACKEND holds ────────────────────────────────
    //
    // A confidential client, with a secret. This is what makes "there is one
    // door" true rather than nearly true: once the browser's client loses
    // ALLOW_CUSTOM_AUTH, InitiateAuth from a browser fails at Cognito no
    // matter what the caller knows, and Turnstile is genuinely in front of
    // every code A-IEP sends rather than in front of account creation only.
    //
    // The secret is NEVER read by CDK. Referencing
    // `client.userPoolClientSecret` would make CDK add an AwsCustomResource
    // that calls DescribeUserPoolClient, and CloudFormation stores that
    // custom resource's response -- so the live client secret would end up in
    // stack state and in the custom resource's logs. The lambdas call
    // DescribeUserPoolClient themselves at runtime instead (secret-hash.js),
    // which keeps it in exactly two places: Cognito, and the memory of a
    // function that already holds every token it protects. test/infra asserts
    // no ClientSecret appears in the template.
    //
    // No oAuth block and no callback URLs: nothing human ever signs in
    // through this client, so a hosted-UI surface on it would be a door with
    // no building behind it.
    const backendAuthClient = new UserPoolClient(this, 'BackendAuthClient', {
      userPool,
      userPoolClientName: 'a-iep-backend-auth',
      generateSecret: true,
      authFlows: {
        // CUSTOM_AUTH for the OTP rounds, and refresh (always on) for
        // /auth/token. Deliberately no userPassword and no userSrp: this
        // client must never be able to accept a password, so a stolen client
        // secret cannot be turned into a password-guessing oracle.
        custom: true,
      },
      // The whole handshake plus OTP round has to fit the five minutes the
      // message promises, same as the browser's client.
      authSessionValidity: cdk.Duration.minutes(5),
      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
    });
    (this as { backendAuthClient: UserPoolClient }).backendAuthClient = backendAuthClient;

    // ── The /auth/* endpoints ────────────────────────────────────────────
    this.createAuthEndpoints(userPool, backendAuthClient, props?.kmsKey);

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
   * POST /auth/start, /auth/verify, /auth/token, /auth/logout, and the
   * dispatcher that does the work /auth/start deliberately defers.
   *
   * Four functions rather than one, because they have different inputs,
   * different limits and different failure modes, and a single route with a
   * mode field would pay every set of validation on every call and produce a
   * log line that cannot say which thing failed.
   */
  private createAuthEndpoints(userPool: UserPool, backendClient: UserPoolClient, kmsKey?: kms.IKey) {
    const stack = cdk.Stack.of(this);
    const assetPath = path.join(__dirname, '../chatbot-api/functions/phone-otp-auth');

    // ── The session store ────────────────────────────────────────────────
    //
    // RETAIN, PITR and deletion protection, matching the treatment
    // tables.ts gives the profile/document/referral tables, and for the same
    // reason rather than by imitation. The rows here are short-lived -- a
    // challenge lives five minutes, a session thirty days -- so this is NOT
    // about restoring old data. It is about the 2026-06-22 failure mode: a
    // rename, a logical-ID change or a construct move must STRAND this table,
    // never replace it, because a replacement is an empty table and an empty
    // table signs every currently-signed-in family out at once with no way to
    // tell them why. Deletion protection blocks the same thing from the
    // console, where CloudFormation is not involved at all.
    //
    // CMK-encrypted because it holds live Cognito refresh tokens for every
    // signed-in parent -- the single most sensitive thing in this stack after
    // the documents themselves, and the reason those tokens are here instead
    // of in a browser.
    this.authSessionTable = new dynamodb.Table(this, 'AuthSessionTable', {
      // sha256(handle), never the handle: a read of this table yields the hash
      // of a credential rather than a credential.
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
      deletionProtection: true,
      encryption: kmsKey
        ? dynamodb.TableEncryption.CUSTOMER_MANAGED
        : dynamodb.TableEncryption.AWS_MANAGED,
      ...(kmsKey ? { encryptionKey: kmsKey } : {}),
      // Same shared-account reasoning as the referrals and email-suppression
      // tables: no IEP content, but a row here IS a signed-in family, so every
      // principal outside the IEP-data allowlist is denied explicitly. An
      // identity-based policy cannot override this.
      resourcePolicy: new iam.PolicyDocument({
        statements: [createIepDataDenyStatement(stack.account, ['dynamodb:*'], ['*'])],
      }),
    });
    tagResource(this.authSessionTable, {
      Resource: 'DynamoDB',
      TableName: 'AuthSessionTable',
      Purpose: 'ApplicationData',
    });

    const clientId = backendClient.userPoolClientId;
    const sharedEnvironment = {
      USER_POOL_ID: userPool.userPoolId,
      AUTH_CLIENT_ID: clientId,
      AUTH_SESSION_TABLE: this.authSessionTable.tableName,
    };

    // No environmentEncryption on any of these, deliberately and unlike the
    // ChatbotAPI lambdas: every variable below is a table name, a client id, a
    // function name or a parameter NAME. The one genuinely secret value, the
    // confidential client's secret, is not an environment variable at all --
    // it is read from Cognito at runtime precisely so that it never lands in a
    // template, a stack parameter or a console page.

    // Only this one can call Cognito's admin APIs for account creation, and
    // it is not reachable from the internet.
    this.authDispatchFunction = new lambda.Function(this, 'AuthDispatchFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(assetPath),
      handler: 'auth-dispatch.handler',
      environment: sharedEnvironment,
      // Creating an account is three Cognito calls and sending the code is two
      // more, all of them on the far side of a network. 30s is the same
      // ceiling every other lambda here uses.
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: AUTH_RESERVED_CONCURRENCY,
      logRetention: cdk.aws_logs.RetentionDays.ONE_YEAR,
      description: 'Creates the account and sends the login code, off the request path',
    });
    tagResource(this.authDispatchFunction, { Resource: 'Lambda', Function: 'AuthDispatch' });

    // Exactly these actions, on exactly this pool. AdminCreateUser without
    // AdminSetUserPassword would leave every new account holding a password
    // its creator was handed, and AdminDeleteUser is the rollback for the gap
    // between the two. Pinned as an exact list in test/infra: an exact-match
    // IAM assertion is the only kind that catches a permission creeping in.
    this.authDispatchFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminDeleteUser',
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminInitiateAuth',
        'cognito-idp:AdminRespondToAuthChallenge',
        'cognito-idp:AdminSetUserPassword',
        'cognito-idp:DescribeUserPoolClient',
      ],
      resources: [userPool.userPoolArn],
    }));
    this.authSessionTable.grantWriteData(this.authDispatchFunction);

    // ── /auth/start ──────────────────────────────────────────────────────
    this.authStartFunction = new lambda.Function(this, 'AuthStartFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(assetPath),
      handler: 'auth-start.handler',
      environment: {
        OTP_RATE_LIMIT_TABLE: this.otpRateLimitTable.tableName,
        AUTH_SESSION_TABLE: this.authSessionTable.tableName,
        AUTH_ALLOWED_COUNTRY_CODES: SMS_ALLOWED_COUNTRY_CODES.join(','),
        TURNSTILE_SECRET_PARAM,
        AUTH_DISPATCH_FUNCTION: this.authDispatchFunction.functionName,
        // Staging only, and only because the E2E suite signs in repeatedly
        // from one CI address, which no rule can tell apart from abuse.
        ...(getEnvironment() !== 'prod'
          ? { MAX_AUTH_STARTS_PER_IP_HOUR: '60', MAX_AUTH_STARTS_PER_HOUR: '200' }
          : {}),
      },
      // One outbound call to Cloudflare, bounded at 5s inside the handler.
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: AUTH_RESERVED_CONCURRENCY,
      logRetention: cdk.aws_logs.RetentionDays.ONE_YEAR,
      description: 'Starts a sign-in: bot check, limits, then one code',
    });
    tagResource(this.authStartFunction, { Resource: 'Lambda', Function: 'AuthStart' });

    this.otpRateLimitTable.grantWriteData(this.authStartFunction);
    this.authSessionTable.grantWriteData(this.authStartFunction);
    this.authDispatchFunction.grantInvoke(this.authStartFunction);
    this.authStartFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${stack.region}:${stack.account}:parameter${TURNSTILE_SECRET_PARAM}`,
      ],
    }));

    // ── /auth/verify ─────────────────────────────────────────────────────
    this.authVerifyFunction = new lambda.Function(this, 'AuthVerifyFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(assetPath),
      handler: 'auth-verify.handler',
      environment: {
        ...sharedEnvironment,
        OTP_RATE_LIMIT_TABLE: this.otpRateLimitTable.tableName,
      },
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: AUTH_RESERVED_CONCURRENCY,
      logRetention: cdk.aws_logs.RetentionDays.ONE_YEAR,
      description: 'Checks the code a parent typed and issues a session handle',
    });
    tagResource(this.authVerifyFunction, { Resource: 'Lambda', Function: 'AuthVerify' });

    // No AdminCreateUser, no AdminSetUserPassword, no AdminDeleteUser. This
    // function answers an unauthenticated route with a caller-supplied code;
    // it must not be able to mint or remove an account even if it is wrong.
    // AdminUpdateUserAttributes is here for one purpose: setting
    // email_verified once a code has actually arrived at an address, which is
    // what possession means and is the only thing that will ever fix the 8
    // production accounts sitting on email_verified: false.
    this.authVerifyFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cognito-idp:AdminRespondToAuthChallenge',
        'cognito-idp:AdminUpdateUserAttributes',
        'cognito-idp:DescribeUserPoolClient',
      ],
      resources: [userPool.userPoolArn],
    }));
    this.authSessionTable.grantReadWriteData(this.authVerifyFunction);
    this.otpRateLimitTable.grantReadWriteData(this.authVerifyFunction);

    // ── /auth/token and /auth/logout ─────────────────────────────────────
    this.authSessionFunction = new lambda.Function(this, 'AuthSessionFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(assetPath),
      handler: 'auth-session.handler',
      environment: sharedEnvironment,
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: AUTH_RESERVED_CONCURRENCY,
      logRetention: cdk.aws_logs.RetentionDays.ONE_YEAR,
      description: 'Exchanges a session handle for short-lived tokens, and revokes it',
    });
    tagResource(this.authSessionFunction, { Resource: 'Lambda', Function: 'AuthSession' });

    // AdminInitiateAuth here is REFRESH_TOKEN_AUTH only in practice, but IAM
    // cannot express "only that flow", so the narrowing that IS available is
    // used instead: this client carries no password flow at all, so the worst
    // this permission reaches is a refresh with a token it already holds.
    this.authSessionFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cognito-idp:AdminInitiateAuth',
        'cognito-idp:AdminUserGlobalSignOut',
        'cognito-idp:DescribeUserPoolClient',
      ],
      resources: [userPool.userPoolArn],
    }));
    this.authSessionTable.grantReadWriteData(this.authSessionFunction);

    // Production gets no env var and no grant, so the bypass branch in
    // auth-start is unreachable there rather than merely unused. Pinned on
    // both sides in test/infra/gen-ai-mvp-stack.test.ts.
    if (getEnvironment() !== 'prod') {
      this.authStartFunction.addEnvironment('E2E_BYPASS_PARAM', E2E_TURNSTILE_BYPASS_PARAM);
      this.authStartFunction.addEnvironment('TEST_PHONE_NUMBERS', TEST_PHONE_NUMBERS.join(','));
      this.authStartFunction.addEnvironment('TEST_EMAIL_ADDRESSES', TEST_EMAIL_ADDRESSES.join(','));
      this.authStartFunction.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${stack.region}:${stack.account}:parameter${E2E_TURNSTILE_BYPASS_PARAM}`,
        ],
      }));
    }
  }

  /**
   * Create and configure Lambda triggers for Phone OTP authentication
   */
  private createPhoneOtpLambdaTriggers(userPool: UserPool, userProfilesTable?: any) {
    // Pre Sign-up Function - collapses phone signup to a SINGLE SMS by
    // auto-confirming phone-only accounts, so Cognito never mints its own
    // signup verification code and the custom-auth login OTP is the only text.
    // Wired in BOTH environments: the two-code flow was a usability bug
    // everywhere, not a staging quirk.
    //
    // Safe only in combination with the password rotation in
    // user-profile-handler/cognito_trigger.py — see the header comment in
    // pre-sign-up.js. An auto-confirmed account whose client-chosen password
    // still worked would be an account-takeover vector.
    const preSignUpFunction = new lambda.Function(this, 'PreSignUpFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(path.join(__dirname, '../chatbot-api/functions/phone-otp-auth')),
      handler: 'pre-sign-up.handler',
      environment: {
        TURNSTILE_SECRET_PARAM,
      },
      // Turnstile adds one outbound call to Cloudflare, bounded at 5s in the
      // trigger, so 30s stays comfortable.
      timeout: cdk.Duration.seconds(30),
      logRetention: cdk.aws_logs.RetentionDays.ONE_YEAR,
      description: 'Auto-confirm phone-only signups so only one OTP SMS is sent'
    });

    // Read-only, and exactly one parameter. This trigger runs on every
    // self-service signup, so a wildcard here would put the whole hierarchy,
    // including the API keys, one bug away from a caller-influenced read.
    preSignUpFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter${TURNSTILE_SECRET_PARAM}`,
      ],
    }));

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
    const otpRateLimitTable = this.otpRateLimitTable = new dynamodb.Table(this, 'OtpRateLimitTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      // DESTROY on purpose, unlike the user-data tables: every row is a
      // throwaway hourly counter that TTLs itself out within the hour, so
      // losing the table costs one hour of rate-limit history and nothing
      // else. Retaining it would just strand junk tables on every teardown.
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
        // Both environments serve United States families only. Set here as
        // well as defaulted in the lambda so the value is pinned by
        // test/infra rather than resting on the lambda default alone.
        SMS_ALLOWED_COUNTRY_CODES: SMS_ALLOWED_COUNTRY_CODES.join(','),
        SMS_POLICY_PARAM_PREFIX,
        ...(userProfilesTable && { USER_PROFILES_TABLE: userProfilesTable.tableName })
      },
      timeout: cdk.Duration.seconds(30),
      logRetention: cdk.aws_logs.RetentionDays.ONE_YEAR,
      description: 'Create Auth Challenge for Phone OTP authentication'
    });

    // Read-only, and scoped to exactly the policy subtree: this role must
    // never be able to read the rest of the parameter hierarchy, and must
    // never be able to write its own ceilings.
    createAuthChallengeFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [
        `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter${SMS_POLICY_PARAM_PREFIX}/*`,
      ],
    }));

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
      createAuthChallengeFunction.addEnvironment('TEST_EMAIL_ADDRESSES', TEST_EMAIL_ADDRESSES.join(','));
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

    // ── The signup endpoint ────────────────────────────────────────────────
    // Lives here rather than with the API lambdas because it needs the pool
    // and the rate-limit table, and because it is part of the auth flow: it
    // does what PreSignUp and PostConfirmation used to do for a self-service
    // signup, in one place where it can be read.
    const signupFunction = new lambda.Function(this, 'SignupEndpointFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(path.join(__dirname, '../chatbot-api/functions/phone-otp-auth')),
      handler: 'signup-endpoint.handler',
      environment: {
        USER_POOL_ID: userPool.userPoolId,
        // Same table as the OTP limiter: identical schema (pk plus a TTL on
        // expiresAt), different key prefixes, and signup is roughly a daily
        // event so it adds no meaningful load.
        SIGNUP_RATE_LIMIT_TABLE: otpRateLimitTable.tableName,
        SIGNUP_ALLOWED_COUNTRY_CODES: SMS_ALLOWED_COUNTRY_CODES.join(','),
        TURNSTILE_SECRET_PARAM,
        // Staging only, and only because the E2E suite signs up repeatedly
        // from one CI address, which no rule can tell apart from abuse.
        // Production keeps the compiled floors.
        ...(getEnvironment() !== 'prod'
          ? { MAX_SIGNUPS_PER_IP_HOUR: '40', MAX_SIGNUPS_PER_HOUR: '80' }
          : {}),
      },
      // One outbound call to Cloudflare, bounded at 5s inside the handler.
      timeout: cdk.Duration.seconds(30),
      logRetention: cdk.aws_logs.RetentionDays.ONE_YEAR,
      description: 'Creates accounts; the only path once self-service signup is off',
    });
    this.signupFunction = signupFunction;

    otpRateLimitTable.grantWriteData(signupFunction);

    // Exactly three actions, on exactly this pool. AdminCreateUser without
    // AdminSetUserPassword would leave every new account holding a password
    // the caller was given, which is the takeover this pair prevents.
    //
    // AdminDeleteUser is the rollback for the gap between those two: an
    // account that is created and then cannot be secured has to be removed,
    // because it can neither sign in (it is stuck in FORCE_CHANGE_PASSWORD)
    // nor sign up again (the number is taken). Scoped to this pool, and the
    // endpoint only ever calls it on a user it just created in the same
    // invocation.
    signupFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminSetUserPassword',
        'cognito-idp:AdminDeleteUser',
      ],
      resources: [userPool.userPoolArn],
    }));

    signupFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter${TURNSTILE_SECRET_PARAM}`,
      ],
    }));

    // Production gets no env var and no grant, so the bypass branch in the
    // endpoint is unreachable there rather than merely unused. Pinned on both
    // sides in test/infra/gen-ai-mvp-stack.test.ts.
    if (getEnvironment() !== 'prod') {
      signupFunction.addEnvironment('E2E_BYPASS_PARAM', E2E_TURNSTILE_BYPASS_PARAM);
      signupFunction.addEnvironment('TEST_PHONE_NUMBERS', TEST_PHONE_NUMBERS.join(','));
      signupFunction.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter${E2E_TURNSTILE_BYPASS_PARAM}`,
        ],
      }));
    }

    tagResource(signupFunction, { Resource: 'Lambda', Function: 'SignupEndpoint' });

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

    // Collected for MonitoringStack, which alarms on each one's Errors. The
    // labels are what a human reads in Slack, so they name the effect on a
    // family where that is not obvious from the trigger name.
    this.authTriggerFunctions.push(
      { label: 'PreSignUp', fn: preSignUpFunction , purpose: 'auto-confirms a phone signup so a new parent gets one code, not two' },
      { label: 'DefineAuthChallenge', fn: defineAuthChallengeFunction , purpose: 'decides each step of the login challenge; runs on every sign-in' },
      { label: 'CreateAuthChallenge (sends the SMS code)', fn: createAuthChallengeFunction , purpose: 'generates and texts the login code; runs on every sign-in' },
      { label: 'VerifyAuthChallenge (checks the SMS code)', fn: verifyAuthChallengeFunction , purpose: 'checks the code a parent typed; runs on every sign-in' },
      { label: 'CustomMessage', fn: customMessageFunction , purpose: 'wording for the codes Cognito itself sends' },
      { label: 'PreAuthentication', fn: preAuthenticationFunction , purpose: 'runs just before a sign-in is accepted' },
    );

    // Allow Cognito to invoke the Lambda functions
    [preSignUpFunction, defineAuthChallengeFunction, createAuthChallengeFunction, verifyAuthChallengeFunction, customMessageFunction, preAuthenticationFunction].forEach(func => {
      func.addPermission('CognitoInvocation', {
        principal: new iam.ServicePrincipal('cognito-idp.amazonaws.com'),
        action: 'lambda:InvokeFunction',
        sourceArn: userPool.userPoolArn
      });
    });

    // Add the Lambda triggers to Cognito User Pool
    userPool.addTrigger(
      cognito.UserPoolOperation.PRE_SIGN_UP,
      preSignUpFunction
    );

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