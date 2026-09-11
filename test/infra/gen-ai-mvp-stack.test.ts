/**
 * CDK assertion suite: pins the security-critical wiring of the synthesized
 * stack. Before this suite existed the app had zero infrastructure tests, so
 * a template that (for example) dropped the JWT authorizer from the HTTP API
 * would synth and deploy green — every /profile route would serve children's
 * IEP data to anyone on the internet. Each test below pins one invariant a
 * refactor must not silently change; if a change here is intentional, update
 * the pin in the same PR and say why.
 *
 * The suite synthesizes the staging stack (AIEPStagingStack, same as CI's
 * `cdk synth` with ENVIRONMENT=staging) exactly once in beforeAll and shares
 * the Template. Asset bundling is disabled via the 'aws:cdk:bundling-stacks'
 * context so the Docker/npm bundling of the pdf-generator, metadata-handler
 * steps, and frontend never runs here; synth stays ~20s.
 *
 * A second synth with ENVIRONMENT=production runs in the final describe: the
 * staging-only OTP test backdoor must be provably absent from the production
 * template, and only a production synth can prove that.
 */
import * as fs from 'fs';
import * as path from 'path';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

// The deliberately unauthenticated routes. Each one has to justify itself,
// because this list is the API's attack surface.
//
//   /referral/click  hit by visitors who are not signed in yet, stores no
//                    PII, and only bumps counters for known active codes.
//   /auth/signup     there is no token before an account exists, so this
//                    cannot be authorized. Everything an authorizer would do
//                    happens inside the handler instead: destination policy,
//                    per-source and global rate limits, then anti-abuse
//                    verification, cheapest check first.
//   /auth/start      the same, for the passwordless path: a parent signing in
//                    has no token yet. Unlike /auth/signup this one also
//                    fronts the OTP SEND, which is why the bot check moved in
//                    front of it.
//   /auth/verify     reachable only with a challenge handle from /auth/start,
//                    which cannot be obtained without passing that bot check.
//   /auth/token      this is the route that ISSUES the JWT, so it cannot
//                    require one. It is authorized by the opaque session
//                    handle instead, which is looked up server-side.
//   /auth/logout     same handle, and it must work for an expired session --
//                    which is exactly the case a JWT authorizer would reject.
//
// Anything added here must survive the same scrutiny.
const PUBLIC_ROUTE_KEYS = [
  'POST /referral/click',
  'POST /auth/signup',
  'POST /auth/start',
  'POST /auth/verify',
  'POST /auth/token',
  'POST /auth/logout',
];

// The one pipeline state whose failure must NOT reach RecordFailure, and only
// one. PurgeRedactedOCR runs AFTER the document is finished, so recording a
// failure there would mark a completed document as failed: the parent would
// see an error for a summary they already have, and the document-failure
// alarm would fire for a document that did not fail. Leaving the redacted
// text behind is the lesser harm and a sweep can collect it; losing a
// parent's upload cannot be undone.
//
// Named rather than pattern-matched, so a second state cannot quietly join it.
const CATCH_EXEMPT_STATES = ['PurgeRedactedOCR'];

// Lambdas aws-cdk-lib injects for its own custom resources (log retention,
// auto-delete-objects, bucket notifications, bucket deployment). Their
// runtimes are managed by the library, not by us, so the runtime pin below
// exempts them by logical-id prefix.
const CDK_HELPER_PREFIXES = [
  'LogRetention',
  'CustomS3AutoDeleteObjects',
  'BucketNotificationsHandler',
  'CustomCDKBucketDeployment',
];

const APPROVED_RUNTIMES = ['python3.12', 'nodejs20.x'];

// ── Durable-store retention pins ────────────────────────────────────────
// WHY (2026-06/07 data-loss incident): e1df452 (2025-09-15) made the
// knowledge bucket's name interpolate getEnvironment(). edc7d2d (2026-06-22),
// a tag-standardization commit, then redefined the Environment type from
// 'production'|'staging' to 'prod'|'dev'. That silently renamed both buckets;
// S3 names are immutable, so CloudFormation REPLACED them, and because they
// were declared removalPolicy DESTROY with autoDeleteObjects, it deleted the
// old buckets and every object inside. 50 of 102 production and 10 of 44
// staging IEP documents lost their stored content. The deploy reported
// success and no test failed.
//
// The pins below close both halves of that hole for every store that holds
// irreplaceable user data: the DeletionPolicy/UpdateReplacePolicy must be
// Retain (a rename or teardown must strand the data, never delete it), no
// auto-delete machinery may be armed on it, and the knowledge bucket's
// literal name is pinned per environment so any future change to the env
// label or the naming scheme fails here instead of relocating live data.
//
// Deliberately NOT pinned to Retain, because they are genuinely disposable:
//   - WebsiteBucket / WebsiteLogsBucket (already Retain, but only assets and
//     access logs; no user content)
//   - DistributionLogsBucket (CloudFront access logs, DESTROY + autoDelete)
//   - OtpRateLimitTable (hourly SMS counters that TTL themselves out; losing
//     it costs at most one hour of rate-limit history)
//   - CustomSenderKey (staging-only KMS key for Cognito codes that live for
//     minutes; pinned as Delete by its own test above)
// AuthSessionTable joined them when the login path moved server-side. Its
// ROWS are short-lived -- a challenge lives five minutes, a session thirty
// days -- so retention here is not about restoring old data. It is the same
// 2026-06-22 failure mode: a rename or a construct move must STRAND this
// table, never replace it, because a replacement is an EMPTY table and an
// empty table signs every currently-signed-in family out at once. It also
// holds live Cognito refresh tokens, which is why it carries the CMK.
const USER_DATA_TABLE_HINTS = [
  'UserProfilesTable', 'IepDocumentsTable', 'ReferralsTable', 'AuthSessionTable',
];

// The live bucket names, per environment. These are the names the production
// and staging documents in DynamoDB (contentS3Reference) already point at.
// Changing either value relocates real data: do not "fix" this test to match
// a new scheme without migrating the objects first.
const KNOWLEDGE_BUCKET_NAMES = {
  staging: 'ai-iep-knowledge-source-dev',
  production: 'ai-iep-knowledge-source-prod',
} as const;

// The knowledge bucket and the user-data tables carry no explicit TableName,
// so their identity is their logical ID: a changed construct path replaces
// the resource (new, empty table) just as surely as a changed bucket name.
//
// The user pool and the CMK are in this list as well as in the retention
// tests above, because the two catch different mistakes. The retention tests
// find the resource by a substring of its logical ID ('NewUserPool',
// 'AppKmsKey'), so they fail on a rename that drops the substring but pass
// straight through a construct MOVE — nesting it one level deeper, or
// renaming the parent construct — which changes the whole hashed path while
// keeping the substring. That is exactly the shape a refactor produces, and
// for the pool it is unrecoverable: Cognito cannot export credentials, so a
// replaced pool locks every family out with no restore path.
const USER_DATA_LOGICAL_IDS = {
  staging: [
    'ChatbotAPIstagingKnowledgeSourceBucket6569EF05',
    'ChatbotAPIstagingUserProfilesTable49F35014',
    'ChatbotAPIstagingIepDocumentsTable38D1586F',
    'ChatbotAPIstagingReferralsTableF8A5555D',
    'NewAuthorizationstagingNewUserPoolE62D52A8',
    'NewAuthorizationstagingAuthSessionTable6BBCBD81',
    'ChatbotAPIstagingAppKmsKey70AB614E',
  ],
  production: [
    'ChatbotAPIKnowledgeSourceBucketD704DDFD',
    'ChatbotAPIUserProfilesTable3923A78F',
    'ChatbotAPIIepDocumentsTable6A6A0420',
    'ChatbotAPIReferralsTable4107EA6C',
    'NewAuthorizationNewUserPoolD1894B52',
    'NewAuthorizationAuthSessionTable344055BA',
    'ChatbotAPIAppKmsKey027D7204',
  ],
} as const;

type EnvLabel = keyof typeof KNOWLEDGE_BUCKET_NAMES;

function resourcesMatching(t: Template, type: string, hint: string): [string, any][] {
  return Object.entries(t.findResources(type)).filter(([logicalId]) => logicalId.includes(hint));
}

function retentionOffenders(entries: [string, any][]): string[] {
  return entries
    .filter(([, r]) => r.DeletionPolicy !== 'Retain' || r.UpdateReplacePolicy !== 'Retain')
    .map(([logicalId, r]) =>
      `${logicalId} (DeletionPolicy: ${r.DeletionPolicy}, UpdateReplacePolicy: ${r.UpdateReplacePolicy})`);
}

/**
 * Registers the retention/naming pins against one synthesized template.
 * Called once at the top level for staging and once inside the production
 * describe below, so both environments are covered without a third synth.
 */
function describeDurableStoreRetention(envLabel: EnvLabel, getTemplate: () => Template) {
  describe(`durable-store retention (${envLabel})`, () => {
    test('the knowledge bucket retains on delete and on replace', () => {
      const buckets = resourcesMatching(getTemplate(), 'AWS::S3::Bucket', 'KnowledgeSourceBucket');
      // Vacuity floor: the pin is worthless if the bucket vanished.
      expect(buckets).toHaveLength(1);
      expect(retentionOffenders(buckets)).toEqual([]);
    });

    // THE ROOT-CAUSE PIN. The incident was a rename, not a bad policy: the
    // env label moved and the bucket followed it. Retain alone would only
    // downgrade that from "objects deleted" to "prod silently reading an
    // empty bucket", so the literal name is pinned too.
    test(`the knowledge bucket is named ${KNOWLEDGE_BUCKET_NAMES[envLabel]}`, () => {
      const buckets = resourcesMatching(getTemplate(), 'AWS::S3::Bucket', 'KnowledgeSourceBucket');
      expect(buckets).toHaveLength(1);
      expect(buckets[0][1].Properties?.BucketName).toBe(KNOWLEDGE_BUCKET_NAMES[envLabel]);
    });

    // Both halves of the auto-delete machinery: the Custom::S3AutoDeleteObjects
    // resource that empties a bucket on removal, and the
    // 'aws-cdk:auto-delete-objects' tag that is what actually arms its handler.
    // The CloudFront log bucket keeps its own auto-delete resource on purpose,
    // so this checks the target rather than counting resources.
    test('no auto-delete-objects machinery is armed on the knowledge bucket', () => {
      const t = getTemplate();
      const buckets = resourcesMatching(t, 'AWS::S3::Bucket', 'KnowledgeSourceBucket');
      expect(buckets).toHaveLength(1);
      const [bucketLogicalId, bucket] = buckets[0];

      const offenders = Object.entries(t.findResources('Custom::S3AutoDeleteObjects'))
        .filter(([, r]) => JSON.stringify(r.Properties ?? {}).includes(bucketLogicalId))
        .map(([logicalId]) => logicalId);
      expect(offenders).toEqual([]);

      const tagKeys = (bucket.Properties?.Tags ?? []).map((tag: any) => tag.Key);
      expect(tagKeys).not.toContain('aws-cdk:auto-delete-objects');
    });

    test('every user-data DynamoDB table retains on delete and on replace', () => {
      const tables = Object.entries(getTemplate().findResources('AWS::DynamoDB::Table'));
      // Four user-data tables plus the OTP rate limiter and the email
      // suppression list.
      expect(tables.length).toBeGreaterThanOrEqual(6);

      const userDataTables = tables.filter(([logicalId]) =>
        USER_DATA_TABLE_HINTS.some((hint) => logicalId.includes(hint)));
      // Vacuity floor: all four must be found, or a rename hollowed the pin out.
      expect(userDataTables).toHaveLength(USER_DATA_TABLE_HINTS.length);

      expect(retentionOffenders(userDataTables)).toEqual([]);
    });

    // Retain is a CloudFormation-level protection against a
    // CloudFormation-level event, and nothing else. It does not help against a
    // bad ops script, a console delete, or an UpdateItem on the wrong row, and
    // those had no restore path at all: the knowledge bucket got versioning
    // after the 2026-06-22 loss and the tables got nothing.
    //
    // Deletion protection is also the drift fix. Two production tables had it
    // enabled by hand and declared nowhere in CDK; CloudFormation only tracks
    // drift on properties that are set explicitly, so an undeclared flag is
    // one that can quietly go away.
    test('every user-data DynamoDB table has a restore point and cannot be deleted by hand', () => {
      const tables = Object.entries(getTemplate().findResources('AWS::DynamoDB::Table'))
        .filter(([logicalId]) => USER_DATA_TABLE_HINTS.some((hint) => logicalId.includes(hint)));
      // Vacuity floor, same as above: all four, or the pin is hollow.
      expect(tables).toHaveLength(USER_DATA_TABLE_HINTS.length);

      const offenders = tables
        .filter(([, r]) =>
          r.Properties?.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled !== true ||
          r.Properties?.DeletionProtectionEnabled !== true)
        .map(([logicalId, r]) =>
          `${logicalId} (PITR: ${r.Properties?.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled}, ` +
          `DeletionProtectionEnabled: ${r.Properties?.DeletionProtectionEnabled})`);
      expect(offenders).toEqual([]);
    });

    // Cognito cannot export or re-import credentials, so a replaced or
    // destroyed pool locks every parent out permanently with no restore path.
    test('the Cognito user pool retains on delete and on replace', () => {
      const pools = resourcesMatching(getTemplate(), 'AWS::Cognito::UserPool', 'NewUserPool');
      expect(pools).toHaveLength(1);
      expect(retentionOffenders(pools)).toEqual([]);
    });

    // The other half of the pool guard, and a different failure mode than the
    // retention pin above: RemovalPolicy/DeletionPolicy only stops
    // CloudFormation from deleting or replacing the resource. It does nothing
    // against a direct DeleteUserPool API call, which bypasses CloudFormation
    // entirely. Cognito's own DeletionProtection is the switch for that call;
    // both pools were verified sitting on 'INACTIVE' on 2026-09-10.
    test('the Cognito user pool cannot be deleted by a direct API call', () => {
      const pools = resourcesMatching(getTemplate(), 'AWS::Cognito::UserPool', 'NewUserPool');
      // Vacuity floor: the pin is worthless if the pool vanished.
      expect(pools).toHaveLength(1);
      expect(pools[0][1].Properties?.DeletionProtection).toBe('ACTIVE');
    });

    // Losing the CMK is data loss by another route: the IEP objects and the
    // profile/document tables it encrypts become permanently unreadable.
    test('the application CMK retains on delete and on replace', () => {
      const keys = resourcesMatching(getTemplate(), 'AWS::KMS::Key', 'AppKmsKey');
      expect(keys).toHaveLength(1);
      expect(retentionOffenders(keys)).toEqual([]);
    });

    // The other half of the root-cause guard: these resources have
    // CloudFormation-generated physical names, so their logical ID IS their
    // identity. Move the construct path and CloudFormation builds a new empty
    // table (retaining the old one, invisible to the app). If you are here
    // because a refactor changed a logical ID, migrate the data first.
    test('the user-data stores keep their logical IDs', () => {
      const resources = getTemplate().toJSON().Resources ?? {};
      const missing = USER_DATA_LOGICAL_IDS[envLabel].filter((id) => !(id in resources));
      expect(missing).toEqual([]);
    });
  });
}

let template: Template;
let savedEnvironment: string | undefined;

beforeAll(() => {
  // ENVIRONMENT is read at import time by lib/constants.ts and lib/tags.ts
  // (resource naming), so it must be set before the stack modules load;
  // require() below (not a hoisted import) guarantees that ordering.
  savedEnvironment = process.env.ENVIRONMENT;
  process.env.ENVIRONMENT = 'staging';
  // Keep jsii deprecation noise (CloudFrontWebDistribution) out of test output.
  process.env.JSII_DEPRECATED = 'quiet';

  /* eslint-disable @typescript-eslint/no-var-requires */
  const { GenAiMvpStack } = require('../../lib/gen-ai-mvp-stack');
  const { stackName } = require('../../lib/constants');
  /* eslint-enable @typescript-eslint/no-var-requires */

  // No env props: same account/region-agnostic synth as CI's credential-free
  // `cdk synth --no-staging` (CDK_DEFAULT_* are unset there).
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new GenAiMvpStack(app, stackName, {});
  template = Template.fromStack(stack);
}, 180_000);

afterAll(() => {
  // Other suites can share this worker process; don't leak the override.
  process.env.ENVIRONMENT = savedEnvironment;
});

describe('HTTP API authorization', () => {
  // THE CROWN JEWEL. Every route except the click beacon fronts FERPA-scoped
  // data (child profiles, IEP documents, referral admin); a route that synths
  // without the JWT authorizer is a public leak, so this must fail for any
  // new or existing route that isn't explicitly in PUBLIC_ROUTE_KEYS.
  test('every route requires the JWT authorizer except the public ones', () => {
    const routes = template.findResources('AWS::ApiGatewayV2::Route');

    // Sanity floor: if the API "lost" this many routes, the template is
    // broken and per-route assertions would pass vacuously.
    expect(Object.keys(routes).length).toBeGreaterThanOrEqual(20);

    const offenders = Object.values(routes)
      .map((route: any) => route.Properties)
      .filter((p: any) => !PUBLIC_ROUTE_KEYS.includes(p.RouteKey))
      .filter((p: any) => p.AuthorizationType !== 'JWT' || p.AuthorizerId === undefined)
      .map((p: any) => `${p.RouteKey} (AuthorizationType: ${p.AuthorizationType ?? 'none'})`);

    expect(offenders).toEqual([]);
  });

  // Pins the exemption itself: the beacon must exist (visitors aren't signed
  // in yet, so wiring JWT onto it silently kills referral attribution) and
  // must stay the ONLY unauthenticated route.
  test('exactly the expected routes are public, and no others', () => {
    const routes = template.findResources('AWS::ApiGatewayV2::Route');

    const publicRoutes = Object.values(routes)
      .map((route: any) => route.Properties)
      .filter((p: any) => p.AuthorizationType !== 'JWT');

    expect(publicRoutes.map((p: any) => p.RouteKey).sort()).toEqual([...PUBLIC_ROUTE_KEYS].sort());
    for (const p of publicRoutes) {
      expect(p.AuthorizationType ?? 'NONE').toBe('NONE');
      expect(p.AuthorizerId).toBeUndefined();
    }
  });

  // An AuthorizerId is only as strong as the authorizer behind it: it must
  // validate Authorization-header JWTs issued by OUR user pool for OUR app
  // client, not merely exist.
  test('the JWT authorizer validates tokens from both app user pool clients', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
      IdentitySource: ['$request.header.Authorization'],
      JwtConfiguration: Match.objectLike({
        // TWO, and the second is load-bearing rather than belt-and-braces. A
        // JWT authorizer checks `aud` on an ID token and `client_id` on an
        // access token, and both carry the id of the client that MINTED the
        // token. Tokens from /auth/verify are minted through the confidential
        // backend client, so without its id here every FERPA-scoped route
        // would 401 the instant a parent signed in the new way: the API up,
        // the login working, and nothing in the app loading.
        //
        // Order matters to CloudFormation only as a list, but it is pinned
        // exactly so that REMOVING either one fails here. The browser client's
        // id comes out in the same change that drops ALLOW_CUSTOM_AUTH from it.
        Audience: [
          { Ref: Match.stringLikeRegexp('NewUserPoolClient') },
          { Ref: Match.stringLikeRegexp('BackendAuthClient') },
        ],
        Issuer: { 'Fn::GetAtt': [Match.stringLikeRegexp('NewUserPool'), 'ProviderURL'] },
      }),
    });
  });

  // Audit finding #7: without this, a request the JWT authorizer rejects is
  // recorded nowhere, and the two unauthenticated routes have no visibility
  // into load at all.
  test('the default stage logs access, to a real destination', () => {
    const stages = template.findResources('AWS::ApiGatewayV2::Stage');
    const entries = Object.values(stages).map((s: any) => s.Properties);
    expect(entries).toHaveLength(1);

    const settings = entries[0].AccessLogSettings;
    expect(settings).toBeDefined();
    expect(settings.DestinationArn).toBeDefined();
    expect(typeof settings.Format).toBe('string');

    // The destination is a real, distinct log group, not a dangling ARN.
    const logGroups = template.findResources('AWS::Logs::LogGroup');
    expect(Object.keys(logGroups).length).toBeGreaterThanOrEqual(1);
  });

  // The core of the privacy pin: no field that could carry a resolved path
  // parameter, a query string or a per-user identifier is in the format,
  // regardless of which fields ARE chosen.
  test('the access log format carries no path parameter, query string or user identifier', () => {
    const stages = template.findResources('AWS::ApiGatewayV2::Stage');
    const format = Object.values(stages).map((s: any) => s.Properties.AccessLogSettings?.Format)
      .find((f: any) => typeof f === 'string');
    expect(format).toBeDefined();

    // $context.path is the RESOLVED path (real childId/iepId/referral code/
    // admin username); $context.routeKey (the route TEMPLATE) is the safe
    // substitute and must be what is actually used.
    expect(format).not.toContain('$context.path');
    expect(format).toContain('$context.routeKey');

    // No $context.identity.* (source IP, IAM/Cognito caller identity) and no
    // JWT claims, which are the literal per-user identifiers this pin exists
    // to keep out of CloudWatch.
    expect(format).not.toContain('$context.identity');
    expect(format).not.toContain('$context.authorizer.claims');

    // No raw query string. There is no dedicated $context variable for one on
    // HTTP APIs, so this also guards against a future field that smuggles it
    // in some other way (e.g. a custom $context.requestOverride reference).
    expect(format.toLowerCase()).not.toContain('querystring');

    // requestId is CloudFormation's own hard floor: AWS rejects a format that
    // omits it, so its absence would mean this test is validating nothing.
    expect(format).toContain('$context.requestId');
  });
});

describe('Cognito custom-auth wiring', () => {
  // Phone OTP sign-in is entirely trigger-driven; a pool that synths with any
  // of these missing breaks login in ways only visible at runtime (the
  // 2026-07 silent-signup outage was exactly this class of failure).
  //
  // PreSignUp is what makes a new parent receive ONE SMS instead of two: it
  // auto-confirms phone-only signups so Cognito never mints its own signup
  // verification code. PostConfirmation was wired all along but went unpinned
  // until the same change; it now also carries the password rotation that
  // makes that auto-confirm safe, so losing it is a security regression, not
  // merely a missing profile.
  test('user pool wires all seven auth triggers', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.hasResourceProperties('AWS::Cognito::UserPool', Match.objectLike({
      LambdaConfig: Match.objectLike({
        PreSignUp: Match.anyValue(),
        PostConfirmation: Match.anyValue(),
        DefineAuthChallenge: Match.anyValue(),
        CreateAuthChallenge: Match.anyValue(),
        VerifyAuthChallengeResponse: Match.anyValue(),
        CustomMessage: Match.anyValue(),
        PreAuthentication: Match.anyValue(),
      }),
    }));
  });

  test('the pre-sign-up trigger points at the auto-confirm handler', () => {
    // Match.anyValue() above proves a trigger exists, not that it is THIS
    // handler; a PreSignUp wired to the wrong file would still pass it.
    template.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
      Handler: 'pre-sign-up.handler',
      Runtime: 'nodejs20.x',
    }));
  });

  // The single-SMS auto-confirm makes an account usable the moment SignUp
  // returns, while it still carries the password the CLIENT chose. Without
  // this grant cognito_trigger.py cannot rotate that password away, and
  // anyone could sign up a phone number they do not own and then sign in to
  // it with USER_PASSWORD_AUTH. Scope matters as much as presence: a wildcard
  // resource here would let the trigger reset passwords in any pool.
  test('the post-confirmation trigger may rotate passwords, scoped to this pool', () => {
    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    expect(policies.length).toBeGreaterThanOrEqual(10);

    const rotationStatements = policies
      .flatMap((policy: any) => policy.Properties?.PolicyDocument?.Statement ?? [])
      // AdminDisableUser is what distinguishes the PostConfirmation trigger's
      // grant from the signup endpoint's, which also rotates a password but
      // on an account it just created and cannot disable one.
      .filter((statement: any) => [statement.Action].flat().includes('cognito-idp:AdminSetUserPassword'))
      .filter((statement: any) => [statement.Action].flat().includes('cognito-idp:AdminDisableUser'));

    expect(rotationStatements).toHaveLength(1);
    const statement: any = rotationStatements[0];
    expect([statement.Action].flat()).toEqual(
      expect.arrayContaining([
        'cognito-idp:AdminSetUserPassword',
        'cognito-idp:AdminDisableUser',
        // Without this the best-effort session revocation fails and only logs,
        // leaving the confirm-before-rotate race silently open.
        'cognito-idp:AdminUserGlobalSignOut',
      ])
    );
    // Scoped to this account's pools, never a bare '*'. It cannot be the
    // pool's own ARN: this lambda is a trigger OF that pool, so a Ref to it
    // closes a CloudFormation cycle (see the comment at the grant site). The
    // assertion therefore pins the wildcard's SHAPE — an account/region-bound
    // userpool ARN — so a lazy widening to '*' still fails.
    const resources = [statement.Resource].flat();
    expect(resources).toHaveLength(1);
    expect(resources[0]).not.toBe('*');
    const joinParts = resources[0]['Fn::Join'][1];
    expect(joinParts).toEqual([
      'arn:aws:cognito-idp:',
      { Ref: 'AWS::Region' },
      ':',
      { Ref: 'AWS::AccountId' },
      ':userpool/*',
    ]);
  });

  // Two clients now, and which one is which is the whole point of the split.
  const userPoolClients = () => Object.entries(template.findResources('AWS::Cognito::UserPoolClient'));
  const clientNamed = (hint: string) => {
    const found = userPoolClients().filter(([logicalId]) => logicalId.includes(hint));
    expect(found).toHaveLength(1);
    return found[0][1].Properties as any;
  };

  test('user pool client keeps the custom-auth contract', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 2);
    const browser = clientNamed('NewUserPoolClient');

    // The define-auth-challenge handler's userNotFound guard is written
    // against this setting; flipping it changes how unknown numbers fail.
    expect(browser.PreventUserExistenceErrors).toBe('ENABLED');
    // The whole handshake+OTP session must fit the 5-minute validity the
    // SMS text promises (see lib/authorization/new-auth.ts).
    expect(browser.AuthSessionValidity).toBe(5);

    // ROLLOUT STATE, not a target state. ALLOW_CUSTOM_AUTH on the client the
    // BROWSER holds is the remaining hole: the client id necessarily ships in
    // the bundle and InitiateAuth is a public unauthenticated API, so anyone
    // who knows a registered number can loop it and A-IEP will text that
    // number with no bot check in the path.
    //
    // It stays for now because the deployed frontend calls InitiateAuth
    // directly and removing it would break sign-in for every parent the
    // moment it landed. When the frontend has switched to /auth/start, delete
    // `custom: true` from this client in new-auth.ts and flip this assertion
    // to not.toContain. Both changes belong in the same commit.
    expect(browser.ExplicitAuthFlows).toContain('ALLOW_CUSTOM_AUTH');
  });

  test('the backend client is confidential, and the browser client is not', () => {
    const browser = clientNamed('NewUserPoolClient');
    const backend = clientNamed('BackendAuthClient');

    // The property the whole two-client split rests on. A secret on the
    // browser's client would be a secret shipped in a JavaScript bundle.
    expect(browser.GenerateSecret).toBeUndefined();
    expect(backend.GenerateSecret).toBe(true);

    // CUSTOM_AUTH and refresh, and nothing else. No password and no SRP, so a
    // stolen client secret cannot be turned into a password-guessing oracle
    // against 296 real accounts. Exact match: an added flow must fail here.
    expect([...backend.ExplicitAuthFlows].sort()).toEqual([
      'ALLOW_CUSTOM_AUTH',
      'ALLOW_REFRESH_TOKEN_AUTH',
    ]);
    expect(backend.PreventUserExistenceErrors).toBe('ENABLED');
    expect(backend.AuthSessionValidity).toBe(5);
  });

  // CDK will happily hand out `client.userPoolClientSecret`, which adds an
  // AwsCustomResource calling DescribeUserPoolClient -- and CloudFormation
  // stores that custom resource's response, so the live secret ends up in
  // stack state and in the custom resource's logs. The lambdas read it from
  // Cognito at runtime instead. This is the assertion that catches somebody
  // "simplifying" that into an environment variable.
  test('the client secret is nowhere in the template', () => {
    expect(JSON.stringify(template.toJSON())).not.toContain('ClientSecret');
  });

  // Both live pools are ESSENTIALS and both allow SMS_OTP as a native first
  // auth factor, set OUT OF BAND with nothing in this repo declaring either.
  // That left a supported passwordless send path enabled at the pool and
  // unreachable only because no app client asks for ALLOW_USER_AUTH -- one
  // line away from an OTP path with no bot check, no suppression list and no
  // per-parent language in front of it.
  test('the pool pins its feature plan and its sign-in policy', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', Match.objectLike({
      UserPoolTier: 'ESSENTIALS',
      Policies: Match.objectLike({
        SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD'] },
        // The override must MERGE, not replace: assigning Policies wholesale
        // would silently drop the password rules the L2 put there.
        PasswordPolicy: Match.objectLike({ MinimumLength: 8, RequireNumbers: true }),
      }),
    }));
  });

  // The hourly SMS budget lives outside the auth session on purpose (Cognito
  // resets session state every InitiateAuth); lose this table or its TTL and
  // an attacker can drain the SNS budget / spam a victim's phone.
  test('OTP rate-limit table: pk hash key, on-demand billing, TTL on expiresAt', () => {
    const tables = Object.entries(template.findResources('AWS::DynamoDB::Table'))
      .filter(([logicalId]) => logicalId.includes('OtpRateLimitTable'));
    expect(tables).toHaveLength(1);

    const props: any = tables[0][1].Properties;
    expect(props.KeySchema).toEqual([{ AttributeName: 'pk', KeyType: 'HASH' }]);
    expect(props.BillingMode).toBe('PAY_PER_REQUEST');
    expect(props.TimeToLiveSpecification).toEqual({ AttributeName: 'expiresAt', Enabled: true });
  });

  // The server-side session store. Retention, PITR, deletion protection and
  // CMK encryption are covered by the durable-store pins above (it is in
  // USER_DATA_TABLE_HINTS); this pins the shape the handlers are written
  // against. Lose the TTL and a challenge handle outlives the Cognito session
  // behind it, and every session row lives forever.
  test('auth session table: pk hash key, on-demand billing, TTL on expiresAt', () => {
    const tables = Object.entries(template.findResources('AWS::DynamoDB::Table'))
      .filter(([logicalId]) => logicalId.includes('AuthSessionTable'));
    expect(tables).toHaveLength(1);

    const props: any = tables[0][1].Properties;
    expect(props.KeySchema).toEqual([{ AttributeName: 'pk', KeyType: 'HASH' }]);
    expect(props.BillingMode).toBe('PAY_PER_REQUEST');
    expect(props.TimeToLiveSpecification).toEqual({ AttributeName: 'expiresAt', Enabled: true });
  });

  // Nothing in this repo reserved concurrency on anything before the auth
  // endpoints, so there is no precedent to lean on and the value is worth
  // pinning rather than inheriting.
  //
  // It is a hard CAP as well as a floor: past it Lambda returns 429 at invoke
  // time, before the handler runs, and what it sheds on this path is a
  // parent's sign-in. Twenty is roughly three orders of magnitude above real
  // demand (a few dozen sign-ins a day), and the service-wide SMS and email
  // budgets bind thousands of times sooner. Lowering it is how a well-meaning
  // cost change turns into a login outage, so the number is asserted, not the
  // presence of the property.
  test('every auth endpoint reserves concurrency, at the value that was reasoned about', () => {
    const AUTH_HANDLERS = [
      'auth-start.handler', 'auth-verify.handler', 'auth-dispatch.handler', 'auth-session.handler',
    ];
    const functions = Object.values(template.findResources('AWS::Lambda::Function'))
      .map((fn: any) => fn.Properties)
      .filter((p: any) => AUTH_HANDLERS.includes(p.Handler));

    // Vacuity floor: all four, or a renamed handler hollowed this out.
    expect(functions.map((p: any) => p.Handler).sort()).toEqual([...AUTH_HANDLERS].sort());
    for (const p of functions) {
      expect(p.ReservedConcurrentExecutions).toBe(20);
    }
  });

  // The confidential client's secret is read from Cognito at runtime, which
  // only works if the role is allowed to ask. Without this every /auth/*
  // Cognito call throws NotAuthorizedException with nothing in the message
  // pointing at why -- which is the exact failure the SECRET_HASH work exists
  // to avoid, moved one layer down.
  test('every function that signs a Cognito call can read the client secret', () => {
    const statements = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement as any[]);
    const describers = statements.filter((st) =>
      JSON.stringify(st.Action).includes('cognito-idp:DescribeUserPoolClient'));

    // Dispatch, verify and session: the three that call AdminInitiateAuth or
    // AdminRespondToAuthChallenge on the confidential client.
    expect(describers).toHaveLength(3);
    for (const st of describers) {
      expect(JSON.stringify(st.Resource)).not.toContain('"*"');
    }
  });

  // Data events are the only record that an IEP document or a profile row was
  // READ. Without them the question "was anything taken" has no answer, only
  // an absence of evidence, and a trail cannot be made to cover the past.
  test('object and item reads on the FERPA stores are audited', () => {
    const trails = Object.values(template.findResources('AWS::CloudTrail::Trail'))
      .map((r: any) => r.Properties);
    expect(trails).toHaveLength(1);
    const [trail] = trails;

    // Tamper-evidence: a log that can be altered afterwards is not evidence.
    expect(trail.EnableLogFileValidation).toBe(true);

    const dataResources = (trail.EventSelectors as any[]).flatMap((s) => s.DataResources ?? []);
    const byType = (t: string) => dataResources.filter((d) => d.Type === t);

    // Reads, not just writes: a write shows up in the data, an exfiltration
    // shows up nowhere else.
    for (const selector of trail.EventSelectors as any[]) {
      expect(selector.ReadWriteType).toBe('All');
    }
    expect(byType('AWS::S3::Object')).toHaveLength(1);
    expect(byType('AWS::DynamoDB::Table')[0].Values).toHaveLength(3);
  });

  // The audit log is the only copy of the evidence for anything already
  // recorded, so a stack teardown must not take it.
  test('the audit log bucket is retained', () => {
    const buckets = Object.entries(template.findResources('AWS::S3::Bucket'))
      .filter(([logicalId]) => logicalId.includes('AuditLog'));
    expect(buckets).toHaveLength(1);
    expect(buckets[0][1].DeletionPolicy).toBe('Retain');
  });

  // The OTP counter holds hashes and counters, no personal data, and is
  // written several times per login. Auditing it would be most of the volume
  // for none of the value, so its absence is deliberate rather than an
  // oversight, and this says so out loud.
  test('the OTP rate-limit table is deliberately NOT audited', () => {
    const trail = Object.values(template.findResources('AWS::CloudTrail::Trail'))
      .map((r: any) => r.Properties)[0];
    const tableRefs = JSON.stringify(
      (trail.EventSelectors as any[]).flatMap((s) => s.DataResources ?? []),
    );
    expect(tableRefs).not.toContain('OtpRateLimitTable');
  });

  // Data minimisation: the redacted OCR is an intermediate, and redaction is
  // best-effort rather than a guarantee, so keeping it after the summary
  // exists is holding a copy of a child's IEP text for no reason.
  test('the pipeline purges the redacted OCR once the summary exists', () => {
    const states = parseStateMachineDefinition(template, 'IEPProcessingStateMachine').States;

    // AFTER the summary is written, never before: the parsing agent reads
    // this text, so purging earlier would break the product itself.
    expect(states.FinalizeResults.Next).toBe('PurgeRedactedOCR');
    expect(states.PurgeRedactedOCR.Parameters.params.data_type).toBe('redacted_ocr_result');
    expect(states.PurgeRedactedOCR.Parameters.operation).toBe('delete_ocr_data');
  });

  // A cleanup failure must not turn a finished document into a failed one.
  // The parent already has their summary; RecordFailure would tell them
  // otherwise, and would also fire the document-failure alarm for a document
  // that did not fail.
  test('a failed purge does not mark the document failed', () => {
    const states = parseStateMachineDefinition(template, 'IEPProcessingStateMachine').States;
    const purge: any = states.PurgeRedactedOCR;

    expect(purge).toBeDefined();
    const catches: any[] = purge.Catch ?? [];
    expect(catches).toHaveLength(1);
    // Anywhere but RecordFailure: the document is already finished.
    expect(catches[0].Next).toBe('RedactedOCRPurgeSkipped');
    expect(states.RedactedOCRPurgeSkipped).toMatchObject({ Type: 'Pass', End: true });
  });

  // The change that actually closes the hole. Cognito's SignUp API is public
  // and the app client id necessarily ships in the browser bundle, so while
  // self-service signup was on, anyone could create accounts without ever
  // loading the site. That is what happened on 2026-09-09. Every control we
  // write lives downstream of this setting.
  test('self-service signup is OFF: the public SignUp API is closed', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', Match.objectLike({
      AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
    }));
  });

  test('signup is reachable without a token, because there cannot be one yet', () => {
    const routes = Object.values(template.findResources('AWS::ApiGatewayV2::Route'))
      .map((r: any) => r.Properties);
    const signup = routes.find((r: any) => r.RouteKey === 'POST /auth/signup');

    expect(signup).toBeDefined();
    expect(signup.AuthorizationType).toBe('NONE');
  });

  // AdminCreateUser without AdminSetUserPassword leaves every new account
  // holding a password its creator was handed. The pair is the control that
  // kept ~1,030 abuse accounts unusable, and it is only a pair if both
  // permissions travel together.
  //
  // AdminDeleteUser joined them as the rollback for the gap BETWEEN the two.
  // If the password rotation fails after the account exists, that account can
  // neither sign in (it is stuck in FORCE_CHANGE_PASSWORD, so custom auth
  // never runs) nor sign up again (the number is taken), so the number is
  // permanently unusable unless the endpoint removes what it just made.
  test('the account-creating roles can create a user AND replace its password, on one pool', () => {
    const statements = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement as any[]);
    const cognitoAdmin = statements.filter((st) =>
      JSON.stringify(st.Action).includes('cognito-idp:AdminCreateUser'));

    // EXACTLY TWO roles may create an account: the old signup endpoint and the
    // new auth dispatcher. Both are the same control in two places while the
    // frontend switches over; the first one goes when /auth/signup does.
    // Anything else acquiring AdminCreateUser must fail here.
    expect(cognitoAdmin).toHaveLength(2);

    const actionSets = cognitoAdmin
      .map((st) => ([] as string[]).concat(st.Action).sort())
      .sort((a, b) => a.length - b.length);

    // Exact matches, not arrayWith: an exact-match IAM assertion is the only
    // kind that catches a permission creeping in.
    expect(actionSets[0]).toEqual([
      'cognito-idp:AdminCreateUser',
      'cognito-idp:AdminDeleteUser',
      'cognito-idp:AdminSetUserPassword',
    ]);
    expect(actionSets[1]).toEqual([
      'cognito-idp:AdminCreateUser',
      'cognito-idp:AdminDeleteUser',
      'cognito-idp:AdminGetUser',
      'cognito-idp:AdminInitiateAuth',
      'cognito-idp:AdminRespondToAuthChallenge',
      'cognito-idp:AdminSetUserPassword',
      'cognito-idp:DescribeUserPoolClient',
    ]);

    // Scoped to the pool, never '*': these roles can mint AND delete accounts.
    for (const st of cognitoAdmin) {
      expect(JSON.stringify(st.Resource)).not.toContain('"*"');
    }
  });

  // The verify handler answers an UNAUTHENTICATED route with a caller-supplied
  // code. It must not be able to mint or remove an account even if it is
  // wrong, so its permissions are asserted as an exact list of their own.
  test('the verify endpoint cannot create, delete or re-password an account', () => {
    const statements = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement as any[]);
    // AdminRespondToAuthChallenge is what identifies this role: the profile
    // handler also holds AdminUpdateUserAttributes, for account deletion.
    const verifyStatements = statements.filter((st) => {
      const actions = JSON.stringify(st.Action);
      return actions.includes('cognito-idp:AdminRespondToAuthChallenge')
        && actions.includes('cognito-idp:AdminUpdateUserAttributes');
    });

    expect(verifyStatements).toHaveLength(1);
    expect(([] as string[]).concat(verifyStatements[0].Action).sort()).toEqual([
      'cognito-idp:AdminRespondToAuthChallenge',
      // Only so a code that actually arrived at an address can set
      // email_verified, which is what possession means and is the only thing
      // that will ever fix the 8 production accounts sitting on false.
      'cognito-idp:AdminUpdateUserAttributes',
      'cognito-idp:DescribeUserPoolClient',
    ]);
  });

  // The signup abuse control. It only works because it runs in the trigger:
  // the 2026-09-09 run never loaded the site, it called the public SignUp API
  // directly, so anything enforced in the browser was not in its path.
  test('pre-sign-up can read the Turnstile secret, and only that', () => {
    template.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
      Handler: 'pre-sign-up.handler',
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          TURNSTILE_SECRET_PARAM: Match.stringLikeRegexp('^/a-iep/.+/turnstile/secret$'),
        }),
      }),
    }));

    const statements = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement as any[]);
    const onTurnstile = statements.filter((st) =>
      JSON.stringify(st.Resource ?? '').includes('turnstile'));
    expect(onTurnstile.length).toBeGreaterThan(0);

    for (const st of onTurnstile) {
      const actions = ([] as string[]).concat(st.Action);
      // Read-only, and one exact parameter. This trigger runs on every
      // self-service signup, so a wildcard would put the whole hierarchy,
      // API keys included, one bug away from a caller-influenced read.
      expect(actions).toEqual(['ssm:GetParameter']);
      const resources = ([] as any[]).concat(st.Resource).map((r) => JSON.stringify(r));
      // Two exact parameters are legitimate here and nothing else is: the
      // secret itself, and (staging only) the E2E bypass token. The property
      // that matters is that each grant names ONE parameter, so widening
      // either one to a prefix fails this.
      expect(resources.every((r) =>
        r.includes('/turnstile/secret') || r.includes('/e2e-turnstile-bypass'))).toBe(true);
      expect(resources.some((r) => r.includes('turnstile/*'))).toBe(false);
      expect(resources.some((r) => r.includes('e2e-turnstile-bypass*'))).toBe(false);
    }
  });

  // A-IEP serves United States families, so +1 is every real destination.
  // Widening this to a country the service does not serve removes a
  // load-bearing abuse control. The lambda defaults to +1 on its own; this
  // pins the value actually deployed.
  test('create-auth-challenge only texts +1 destinations', () => {
    template.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
      Handler: 'create-auth-challenge.handler',
      Environment: Match.objectLike({
        Variables: Match.objectLike({ SMS_ALLOWED_COUNTRY_CODES: '+1' }),
      }),
    }));
  });

  // The SMS ceilings are read at runtime from Parameter Store so the deployed
  // calibration is not published with the source. Two properties matter and
  // neither is obvious from reading the lambda: the role may only READ, and
  // only within its own subtree. A wildcard here would let the auth trigger
  // read the rest of the hierarchy, which includes API keys.
  test('create-auth-challenge reads its SMS policy, and only that, from SSM', () => {
    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    const statements = policies.flatMap(
      (p: any) => p.Properties.PolicyDocument.Statement as any[],
    );
    // Selected by the subtree they name, so other lambdas' unrelated SSM
    // grants (API keys, the staging OTP backdoor) are not swept in.
    const onPolicySubtree = statements.filter((st) =>
      JSON.stringify(st.Resource ?? '').includes('sms-policy'),
    );
    expect(onPolicySubtree.length).toBeGreaterThan(0);

    for (const st of onPolicySubtree) {
      const actions = ([] as string[]).concat(st.Action);
      // Read-only: nothing may rewrite its own ceilings.
      expect(actions.every((a) => a.startsWith('ssm:Get'))).toBe(true);
      // Scoped: never the whole parameter hierarchy.
      const resources = ([] as any[]).concat(st.Resource).map((r) => JSON.stringify(r));
      expect(resources.every((r) => r.includes('sms-policy'))).toBe(true);
    }

    // And nothing anywhere may write into that subtree.
    const writers = statements.filter(
      (st) =>
        JSON.stringify(st.Resource ?? '').includes('sms-policy') &&
        JSON.stringify(st.Action).includes('ssm:Put'),
    );
    expect(writers).toHaveLength(0);
  });

  // create-auth-challenge fails open (or falls back to English SMS) when its
  // table wiring is missing, so the env vars are load-bearing: the rate-limit
  // counter and the profile lookup for OTP localization.
  // Account deletion has to reach the referrals table: a user's personal link
  // and the events under it are their data, and they used to outlive the
  // deleted account entirely. Without the env var the handler silently skips
  // the cleanup, and without the IAM actions it fails at runtime, so both are
  // pinned. Scan is required because signup events name the deleted user under
  // SOMEONE ELSE'S code and there is no GSI on referredUserId. UpdateItem is
  // for redacting that reference instead of deleting the event, which would
  // decrement the referrer's count.
  test('user-profile-handler can purge referral data on account deletion', () => {
    template.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
      Handler: 'lambda_function.lambda_handler',
      Environment: {
        Variables: Match.objectLike({
          REFERRALS_TABLE: { Ref: Match.stringLikeRegexp('ReferralsTable') },
          USER_PROFILES_TABLE: { Ref: Match.stringLikeRegexp('UserProfilesTable') },
          IEP_DOCUMENTS_TABLE: { Ref: Match.stringLikeRegexp('IepDocumentsTable') },
        }),
      },
    }));

    const referralActions = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap((p: any) => p.Properties?.PolicyDocument?.Statement ?? [])
      .filter((st: any) => JSON.stringify(st.Resource ?? '').includes('ReferralsTable'))
      .flatMap((st: any) => (Array.isArray(st.Action) ? st.Action : [st.Action]));

    for (const action of ['dynamodb:Query', 'dynamodb:Scan',
                          'dynamodb:DeleteItem', 'dynamodb:UpdateItem']) {
      expect(referralActions).toContain(action);
    }
  });

  test('create-auth-challenge lambda is wired to the rate-limit and profiles tables', () => {
    template.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
      Handler: 'create-auth-challenge.handler',
      Environment: {
        Variables: Match.objectLike({
          OTP_RATE_LIMIT_TABLE: { Ref: Match.stringLikeRegexp('OtpRateLimitTable') },
          USER_PROFILES_TABLE: { Ref: Match.stringLikeRegexp('UserProfilesTable') },
        }),
      },
    }));
  });

  // The staging-only E2E backdoor: create-auth-challenge stashes OTPs for
  // allowlisted numbers in SSM instead of texting them. Every allowlisted
  // number must sit inside the NANP-fictional 555-01XX block — the same
  // regex the lambda hard-codes as its second lock — so the allowlist can
  // never name a real phone. The smoke users (+15555550101/0102) must stay
  // absent: smoke asserts the real, non-backdoored SMS contract.
  test('staging allowlists only NANP-fictional numbers for the OTP test backdoor', () => {
    const functions = Object.values(template.findResources('AWS::Lambda::Function'))
      .filter((fn: any) => fn.Properties?.Handler === 'create-auth-challenge.handler');
    expect(functions).toHaveLength(1);

    const vars: any = (functions[0] as any).Properties.Environment.Variables;
    expect(vars.TEST_OTP_PARAM_PREFIX).toBe('/a-iep/staging/test-otp');

    const numbers = vars.TEST_PHONE_NUMBERS.split(',');
    expect(numbers.length).toBeGreaterThanOrEqual(1);
    for (const number of numbers) {
      expect(number).toMatch(/^\+155555501\d{2}$/);
    }
    expect(numbers).not.toContain('+15555550101');
    expect(numbers).not.toContain('+15555550102');
    // The stable per-journey users the E2E specs sign in as. Dropping one
    // silently turns that journey's OTP into a real (undeliverable) SMS.
    expect(numbers).toEqual(expect.arrayContaining([
      '+15555550111', '+15555550112', '+15555550113', '+15555550114',
    ]));
  });

  // The backdoor's write permission must stay pinned to the test-otp prefix;
  // a widened resource would let the auth lambdas scribble over real config
  // (e.g. the /a-iep/* and /ai-iep/* app parameters). Two lambdas hold this
  // grant: create-auth-challenge (our sign-in OTP) and the custom SMS sender
  // (Cognito's signup code).
  test('staging scopes ssm:PutParameter to the test-otp prefix only', () => {
    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    const ssmPutStatements = policies.flatMap((policy: any) =>
      (policy.Properties?.PolicyDocument?.Statement ?? []).filter((stmt: any) =>
        JSON.stringify(stmt.Action).includes('ssm:PutParameter')));

    expect(ssmPutStatements).toHaveLength(2);
    for (const statement of ssmPutStatements) {
      // The resource is an Fn::Join around the AccountId pseudo-parameter; its
      // serialized form must pin the region and the parameter prefix.
      const resource = JSON.stringify(statement.Resource);
      expect(resource).toContain('arn:aws:ssm:us-east-1:');
      expect(resource).toContain('parameter/a-iep/staging/test-otp/*');
    }
  });
});

describe('Cognito custom SMS sender (staging only)', () => {
  // The second half of the E2E backdoor. Cognito — not create-auth-challenge —
  // mints the SIGN-UP verification code, so without this trigger no test can
  // ever confirm a new user. Assigning it also means Cognito stops sending SMS
  // for the whole staging pool, which is why the trigger, its key, and its
  // allowlist are pinned together: a half-configured sender takes staging's
  // SMS offline rather than failing loudly at synth.
  test('the staging pool assigns a V1_0 CustomSMSSender against a KMS key', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', Match.objectLike({
      LambdaConfig: Match.objectLike({
        // V1_0 is the only version custom senders support; CDK stamps it.
        CustomSMSSender: Match.objectLike({
          LambdaArn: Match.anyValue(),
          LambdaVersion: 'V1_0',
        }),
        // Cognito refuses a custom sender without a customer-managed key, and
        // the lambda cannot decrypt the code without the matching ARN.
        KMSKeyID: Match.anyValue(),
      }),
    }));
  });

  // Both halves of the double gate plus the key ARN. Losing TEST_PHONE_NUMBERS
  // sends every staging code as a real SMS (silently breaking E2E); losing
  // KMS_KEY_ARN breaks decryption, i.e. all staging SMS.
  test('the sender lambda carries the key ARN and the same allowlist', () => {
    const functions = Object.entries(template.findResources('AWS::Lambda::Function'))
      .filter(([logicalId]) => logicalId.includes('CustomSmsSenderFunction'));
    expect(functions).toHaveLength(1);

    const vars: any = (functions[0][1] as any).Properties.Environment.Variables;
    expect(vars.KMS_KEY_ARN).toBeDefined();
    expect(vars.TEST_OTP_PARAM_PREFIX).toBe('/a-iep/staging/test-otp');

    const numbers = vars.TEST_PHONE_NUMBERS.split(',');
    for (const number of numbers) {
      expect(number).toMatch(/^\+155555501\d{2}$/);
    }

    // One allowlist, two lambdas: a number the sign-in backdoor knows but the
    // signup backdoor doesn't (or vice versa) is a half-usable test user.
    const createAuthChallenge = Object.values(template.findResources('AWS::Lambda::Function'))
      .find((fn: any) => fn.Properties?.Handler === 'create-auth-challenge.handler');
    expect(vars.TEST_PHONE_NUMBERS)
      .toBe((createAuthChallenge as any).Properties.Environment.Variables.TEST_PHONE_NUMBERS);
  });

  // Also the anchor for the production pin below ("no alias contains
  // custom-sender"): without this, that assertion could pass because the
  // alias was renamed rather than because production is clean.
  test('the sender key is a dedicated, destroyable staging key', () => {
    const aliases = Object.values(template.findResources('AWS::KMS::Alias'))
      .map((alias: any) => alias.Properties?.AliasName);
    expect(aliases).toContain('alias/a-iep-staging-custom-sender');

    const keys = Object.entries(template.findResources('AWS::KMS::Key'))
      .filter(([logicalId]) => logicalId.includes('CustomSenderKey'));
    expect(keys).toHaveLength(1);
    // Nothing durable is encrypted with it (codes live for minutes), so a
    // torn-down staging stack must not strand a key.
    expect((keys[0][1] as any).DeletionPolicy).toBe('Delete');
  });
});

describe('S3 data protection', () => {
  // The knowledge bucket holds redacted IEP documents and the others hold
  // site assets/access logs; none of them has any business being public, so
  // every bucket (present and future) must block all four public-access paths.
  test('every bucket blocks all public access', () => {
    const buckets = template.findResources('AWS::S3::Bucket');

    // Knowledge, website, and the two log buckets — a shrink means the
    // template is broken, not that we need fewer pins.
    expect(Object.keys(buckets).length).toBeGreaterThanOrEqual(4);

    const required = ['BlockPublicAcls', 'BlockPublicPolicy', 'IgnorePublicAcls', 'RestrictPublicBuckets'];
    const offenders = Object.entries(buckets)
      .filter(([, bucket]: [string, any]) => {
        const config = bucket.Properties?.PublicAccessBlockConfiguration;
        return !config || required.some((key) => config[key] !== true);
      })
      .map(([logicalId]) => logicalId);

    expect(offenders).toEqual([]);
  });

  // A 2026-07-28 security review found the knowledge-management lambdas
  // holding s3:* on the whole bucket. That bucket is every family's IEP
  // documents, so a wildcard turns any compromise of one function into
  // read/write/delete over all of them. Allow statements must name the
  // actions the handler actually performs.
  //
  // Deny statements are exempt on purpose: the bucket resource policy denies
  // s3:* to non-allowlisted principals and to non-HTTPS callers, where a
  // wildcard is what makes the guard strong.
  test('no identity policy allows wildcard s3 actions', () => {
    const policies = Object.entries(template.findResources('AWS::IAM::Policy'));
    expect(policies.length).toBeGreaterThanOrEqual(5);

    const offenders: string[] = [];
    for (const [logicalId, policy] of policies) {
      const statements = (policy as any).Properties?.PolicyDocument?.Statement ?? [];
      for (const statement of statements) {
        if (statement.Effect !== 'Allow') continue;
        const actions = [statement.Action ?? []].flat();
        if (actions.some((action: unknown) => action === 's3:*' || action === '*')) {
          offenders.push(logicalId);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  // The presigned URLs these two mint are evaluated against their own roles,
  // so this pins the real upload/download/replace surface, not just the SDK
  // calls in the handler files.
  test('the knowledge-management lambdas hold only the S3 actions they use', () => {
    const s3ActionsFor = (roleHint: string): string[] => {
      const actions = new Set<string>();
      for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
        const props = (policy as any).Properties ?? {};
        const attachedTo = JSON.stringify(props.Roles ?? []);
        if (!attachedTo.includes(roleHint)) continue;
        for (const statement of props.PolicyDocument?.Statement ?? []) {
          if (statement.Effect !== 'Allow') continue;
          for (const action of [statement.Action ?? []].flat()) {
            if (typeof action === 'string' && action.startsWith('s3:')) actions.add(action);
          }
        }
      }
      return [...actions].sort();
    };

    // get-s3 only lists a caller's own prefix.
    expect(s3ActionsFor('GetS3FilesHandlerFunctionServiceRole')).toEqual(['s3:ListBucket']);

    // upload-s3 presigns a PUT and a GET, and clears the child's previous
    // document (list + delete) before writing the new one.
    expect(s3ActionsFor('UploadS3KnowledgeFilesHandlerFunctionServiceRole')).toEqual(
      ['s3:DeleteObject', 's3:GetObject', 's3:ListBucket', 's3:PutObject']
    );
  });
});

// ── Cross-project blast radius ──────────────────────────────────────────
// This AWS account is shared with other Burnes Center projects, so a
// wildcard resource here does not stop at A-IEP's own data.
//
// The case that produced this pin: every step-function lambda plus the DDB
// service -- eight roles -- carried bedrock:InvokeModel, bedrock:Retrieve and
// bedrock-agent-runtime:Retrieve with `Resource: ['<model-arn>', '*']`. The
// model ARN next to the wildcard made the wildcard the whole grant, and
// bedrock:Retrieve on '*' reads knowledge bases belonging to the other
// projects in this account. Nothing in this repo has ever called Bedrock:
// the pipeline uses Mistral, Comprehend and OpenAI, and the statement was
// inherited from the template this repo started from.
//
// The grant is a plausible thing to want back (docs/AI_EVALUATION_RESEARCH.md
// proposes a Claude-on-Bedrock eval judge), which is exactly why the shape is
// pinned rather than just deleted: it has to come back scoped to one model
// and one function.
describe('Bedrock is not granted on a wildcard', () => {
  const bedrockStatements = (t: Template): any[] =>
    Object.values(t.findResources('AWS::IAM::Policy'))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement as any[])
      .filter((st) => st.Effect === 'Allow')
      .filter((st) => [st.Action ?? []].flat()
        .some((a: unknown) => typeof a === 'string' && a.startsWith('bedrock')));

  // Staging only, and that is enough: the statement lived in the shared
  // `stepFunctionPolicies` list in functions.ts with no environment gate, so
  // both templates carry whatever this one carries. A second full synth would
  // cost ~20s to re-assert the same fact.
  test('any future Bedrock grant names a model, never a wildcard', () => {
    for (const statement of bedrockStatements(template)) {
      const resources = [statement.Resource ?? []].flat();
      // A '*' anywhere in the list IS the grant, however many specific ARNs
      // sit beside it. That is precisely how the deleted statement read.
      expect(resources).not.toContain('*');
      expect(resources.length).toBeGreaterThan(0);
      expect(JSON.stringify(resources)).toContain('foundation-model');
    }
  });

  // Vacuity guard. The test above passes trivially when there are no Bedrock
  // statements at all, which is the state we want, so assert that state
  // explicitly: if a statement appears, this fails and forces someone to
  // read the block above before widening the loop's exemptions.
  test('there are no Bedrock statements at all today', () => {
    expect(bedrockStatements(template)).toEqual([]);
  });
});

// ── Encryption ──────────────────────────────────────────────────────────
// WHY: on 2026-09-08 an audit found the encryption posture correct in the
// live account but pinned by nothing. `encryptionKey` and `environmentEncryption`
// are optional props threaded through from lib/chatbot-api/index.ts, so
// dropping one downgrades a store from the CMK to an AWS-owned key, synths
// clean, deploys green, and shows up nowhere: the same failure shape as the
// bucket rename above, which also passed every check that existed at the time.
// The same audit found both live CloudFront distributions on a TLSv1 floor
// for the same reason, so the in-transit floor is pinned here too.
//
// "Encrypted" is not the property that matters, since AWS encrypts these at
// rest by default regardless. The property is WHICH key: only the CMK gives
// per-decrypt CloudTrail records and a revocation path over children's IEPs.
describe('encryption at rest and in transit', () => {
  // Resolved from the template rather than hardcoded: the assertions below
  // must break if the key is swapped, not if its logical ID is refactored.
  const appKmsKeyLogicalId = (): string => {
    const keys = resourcesMatching(template, 'AWS::KMS::Key', 'AppKmsKey');
    // Vacuity floor: no CMK means every pin below is asserting nothing.
    expect(keys).toHaveLength(1);
    return keys[0][0];
  };

  const referencesAppKmsKey = (value: unknown): boolean =>
    JSON.stringify(value ?? null).includes(appKmsKeyLogicalId());

  test('the knowledge bucket encrypts objects with the application CMK', () => {
    const buckets = resourcesMatching(template, 'AWS::S3::Bucket', 'KnowledgeSourceBucket');
    expect(buckets).toHaveLength(1);

    const rules = buckets[0][1].Properties?.BucketEncryption?.ServerSideEncryptionConfiguration ?? [];
    expect(rules).toHaveLength(1);

    const applied = rules[0].ServerSideEncryptionByDefault;
    // Not 'AES256': SSE-S3 would still read as "encrypted at rest" in the
    // console while dropping the audit trail and the revocation path.
    expect(applied?.SSEAlgorithm).toBe('aws:kms');
    expect(referencesAppKmsKey(applied?.KMSMasterKeyID)).toBe(true);
  });

  test('every user-data table encrypts with the application CMK', () => {
    const tables = Object.entries(template.findResources('AWS::DynamoDB::Table'))
      .filter(([logicalId]) => USER_DATA_TABLE_HINTS.some((hint) => logicalId.includes(hint)));
    expect(tables).toHaveLength(USER_DATA_TABLE_HINTS.length);

    const offenders = tables
      .filter(([, table]: [string, any]) => {
        const sse = table.Properties?.SSESpecification;
        return sse?.SSEEnabled !== true
          || sse?.SSEType !== 'KMS'
          || !referencesAppKmsKey(sse?.KMSMasterKeyId);
      })
      .map(([logicalId]) => logicalId);

    // The OtpRateLimitTable is deliberately absent from this list: its rows
    // are sha256(phone)#hour counters that TTL out within the hour, so the
    // AWS-owned default key is the right call and a CMK would only add cost.
    expect(offenders).toEqual([]);
  });

  test('the application log group encrypts with the application CMK', () => {
    const groups = resourcesMatching(template, 'AWS::Logs::LogGroup', 'LoggingLogGroup');
    expect(groups).toHaveLength(1);
    expect(referencesAppKmsKey(groups[0][1].Properties?.KmsKeyId)).toBe(true);
  });

  // Every lambda that touches document content, profiles, or a decrypted API
  // key holds its configuration in environment variables. The Cognito trigger
  // lambdas under NewAuthorization are exempt on purpose: their environments
  // carry table names and the fictional-number allowlist, no secret and no
  // document reference. If that ever changes, delete the exemption.
  test('every data-plane lambda encrypts its environment with the application CMK', () => {
    const dataPlane = Object.entries(template.findResources('AWS::Lambda::Function'))
      .filter(([logicalId]) => logicalId.startsWith('ChatbotAPI'));
    // 18 at the time of writing; the floor catches a filter that stops matching.
    expect(dataPlane.length).toBeGreaterThanOrEqual(15);

    const offenders = dataPlane
      .filter(([, fn]: [string, any]) => !referencesAppKmsKey(fn.Properties?.KmsKeyArn))
      .map(([logicalId]) => logicalId);

    expect(offenders).toEqual([]);
  });

  // enforceSSL renders as a Deny statement on the bucket's resource policy,
  // which is the only one of the two that binds a caller holding a presigned
  // URL: presigned GETs are evaluated against the bucket policy, so without
  // this a link could be replayed over plaintext HTTP.
  // Both TLS pins below assert the rendered Deny rather than the CDK prop.
  // That matters here: buckets.ts once carried a hand-written
  // aws:SecureTransport deny next to enforceSSL, CDK emits a byte-identical
  // statement, and PostProcessPolicyDocument dedupes them to one. A pin on
  // the prop would have passed either way and told us nothing about the
  // policy that actually ships.
  // WHY: S3 allows exactly ONE policy document per bucket, so two
  // AWS::S3::BucketPolicy resources naming the same bucket are not additive.
  // Whichever deploys last overwrites the other, completely and silently.
  //
  // This is not hypothetical. buckets.ts created the bucket in the PARENT
  // stack and its policy in S3BucketStack, which extends cdk.Stack, so synth
  // emitted a SECOND top-level stack carrying a second policy for the live
  // IEP bucket, referencing it by hard-coded name. CI only ever deploys the
  // named parent stack, so the two never met -- but `cdk deploy --all`, which
  // README.md documents, would have applied the sibling's two-statement
  // policy over the real four-statement one, dropping both
  // DenyIepDataOutsideAllowlist and the TLS 1.2 floor, and reporting success.
  // The same shape as the 2026-06-22 bucket rename: routine documented
  // command, silent security downgrade, green deploy.
  test('no bucket has a second, competing policy in a sibling stack', () => {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { GenAiMvpStack } = require('../../lib/gen-ai-mvp-stack');
    const { stackName } = require('../../lib/constants');
    /* eslint-enable @typescript-eslint/no-var-requires */
    const root = new GenAiMvpStack(app, stackName, {});

    // Every stack synthesized from this app, not just the named one.
    const policiesByBucket = new Map<string, string[]>();
    for (const stack of app.node.findAll().filter((c): c is Stack => Stack.isStack(c))) {
      const resources = Template.fromStack(stack)
        .findResources('AWS::S3::BucketPolicy');
      for (const [logicalId, resource] of Object.entries(resources)) {
        const bucket = JSON.stringify((resource as any).Properties.Bucket);
        policiesByBucket.set(bucket, [
          ...(policiesByBucket.get(bucket) ?? []),
          `${stack.stackName}/${logicalId}`,
        ]);
      }
    }
    void root;

    const duplicated = [...policiesByBucket.entries()].filter(([, ids]) => ids.length > 1);
    expect(duplicated).toEqual([]);
  });

  const bucketsWithoutDeny = (matches: (statement: any) => boolean): string[] => {
    const buckets = Object.keys(template.findResources('AWS::S3::Bucket'));
    // Knowledge, website, website logs, CloudFront logs.
    expect(buckets.length).toBeGreaterThanOrEqual(4);

    const policies = Object.values(template.findResources('AWS::S3::BucketPolicy'));

    return buckets.filter((bucketLogicalId) => !policies.some((policy: any) => {
      const doc = policy.Properties ?? {};
      if (!JSON.stringify(doc.Bucket ?? null).includes(bucketLogicalId)) return false;
      return (doc.PolicyDocument?.Statement ?? []).some((statement: any) =>
        statement.Effect === 'Deny'
        && [statement.Action ?? []].flat().includes('s3:*')
        && matches(statement));
    }));
  };

  // enforceSSL renders as a Deny statement on the bucket's resource policy,
  // which is the only one of the two that binds a caller holding a presigned
  // URL: presigned GETs are evaluated against the bucket policy, so without
  // this a link could be replayed over plaintext HTTP.
  test('every bucket denies requests that are not over TLS', () => {
    expect(bucketsWithoutDeny(
      (statement) => statement.Condition?.Bool?.['aws:SecureTransport'] === 'false'
    )).toEqual([]);
  });

  // The floor, not just the scheme. enforceSSL on its own denies plaintext
  // HTTP and happily accepts TLS 1.0 and 1.1, which is where all four buckets
  // sat until 2026-09-08: the same shape as the CloudFront TLSv1 default
  // found the same day. minimumTLSVersion adds this second Deny, and CDK
  // throws at synth if enforceSSL is turned off underneath it.
  test('every bucket denies TLS below 1.2', () => {
    expect(bucketsWithoutDeny(
      (statement) => statement.Condition?.NumericLessThan?.['s3:TlsVersion'] === 1.2
    )).toEqual([]);
  });
});

describeDurableStoreRetention('staging', () => template);

/**
 * Parse one state machine's ASL out of the template, selected by logical ID.
 *
 * The definition reaches the template as an Fn::Join of JSON fragments with
 * lambda ARN tokens spliced inside string values; substituting a plain
 * placeholder for each token yields parseable JSON again.
 *
 * The `hint` argument used to be unnecessary — there was exactly one state
 * machine and this helper asserted that count. The on-demand single-language
 * translation machine made it two, so the pin became a selector rather than
 * being dropped: each caller still proves its own machine exists exactly once,
 * so a rename or a deletion fails here instead of passing vacuously.
 */
function parseStateMachineDefinition(t: Template, hint: string): any {
  const machines = Object.entries(t.findResources('AWS::StepFunctions::StateMachine'))
    .filter(([logicalId]) => logicalId.includes(hint));
  expect(machines).toHaveLength(1);
  const ds: any = machines[0][1].Properties.DefinitionString;
  if (typeof ds === 'string') return JSON.parse(ds);
  const [separator, parts] = ds['Fn::Join'];
  return JSON.parse(parts.map((p: any) => (typeof p === 'string' ? p : 'ARN')).join(separator));
}

/** Every 'Allow' action a role's inline policies grant, deduped and sorted. */
function allowedActionsFor(t: Template, roleHint: string, prefix: string): string[] {
  const actions = new Set<string>();
  for (const policy of Object.values(t.findResources('AWS::IAM::Policy'))) {
    const props = (policy as any).Properties ?? {};
    if (!JSON.stringify(props.Roles ?? []).includes(roleHint)) continue;
    for (const statement of props.PolicyDocument?.Statement ?? []) {
      if (statement.Effect !== 'Allow') continue;
      for (const action of [statement.Action ?? []].flat()) {
        if (typeof action === 'string' && action.startsWith(prefix)) actions.add(action);
      }
    }
  }
  return [...actions].sort();
}

describe('IEP processing state machine', () => {
  const stateMachineDefinition = () =>
    parseStateMachineDefinition(template, 'IEPProcessingStateMachine');

  // A processing failure that never reaches RecordFailure leaves the document
  // stuck at PROCESSING forever — the parent sees an eternal spinner and the
  // failure is invisible to us (no failed_step, no error_message in DDB).
  //
  // Catches now reach RecordFailure through a one-state FailedAt<Step> Pass
  // that injects the failing step's name, so this resolves that hop instead of
  // requiring Next === 'RecordFailure' directly. The pin was updated, not
  // relaxed: the hop is allowed only if it is a Pass that goes straight to
  // RecordFailure, so an arbitrary chain, a Choice that could route elsewhere,
  // or a dead end still fails. Its intent is unchanged, that every failure
  // ARRIVES at RecordFailure.
  test('every task and parallel state catches States.ALL into RecordFailure', () => {
    const definition = stateMachineDefinition();
    const states: Record<string, any> = definition.States;
    expect(states.RecordFailure).toMatchObject({ Type: 'Task' });

    // The exemption only counts if the state actually exists; a rename would
    // otherwise silently exempt nothing and hide a real regression.
    for (const exempt of CATCH_EXEMPT_STATES) {
      expect(states[exempt]).toBeDefined();
    }

    /** Does this catch target land on RecordFailure, at most one Pass away? */
    const reachesRecordFailure = (next: string): boolean => {
      if (next === 'RecordFailure') return true;
      const hop = states[next];
      return Boolean(hop) && hop.Type === 'Pass' && hop.Next === 'RecordFailure';
    };

    const offenders = Object.entries(states)
      .filter(([name, state]: [string, any]) =>
        name !== 'RecordFailure'
        && !CATCH_EXEMPT_STATES.includes(name)
        && (state.Type === 'Task' || state.Type === 'Parallel'))
      .filter(([, state]: [string, any]) => {
        const catches: any[] = state.Catch ?? [];
        return !catches.some((c) =>
          (c.ErrorEquals ?? []).includes('States.ALL') && reachesRecordFailure(c.Next));
      })
      .map(([name]) => name);

    expect(offenders).toEqual([]);

    // The exempt state must still CATCH, just somewhere else. An uncaught
    // failure would abort the execution and is a different bug.
    for (const exempt of CATCH_EXEMPT_STATES) {
      const catches: any[] = states[exempt].Catch ?? [];
      expect(catches.some((c) => (c.ErrorEquals ?? []).includes('States.ALL'))).toBe(true);
    }
  });

  // Guards the catch-all test against renames hollowing it out: the OCR,
  // redaction, and parsing tasks must exist under these names, and each must
  // be a top-level state so its Catch can route to RecordFailure (a state
  // nested in a Parallel branch cannot).
  test('the OCR, redaction, and parsing stages are present by name', () => {
    const definition = stateMachineDefinition();
    for (const name of ['MistralOCR', 'RedactOCR', 'ParsingAgent']) {
      expect(definition.States[name]).toMatchObject({ Type: 'Task' });
    }
  });

  // Longest legitimate run, in seconds: the translation branch with every task
  // exhausting its retries. MaxAttempts 3 means 3 retries AFTER the initial
  // attempt, so each task is 4 x (its lambda timeout) + 2+4+8s of backoff. That
  // is 12902s across the 13 tasks on that path, plus a 254s RecordFailure tail.
  const WORST_CASE_RUN_SECONDS = 13156;

  // WHY: this machine carried `timeout: cdk.Duration.minutes(30)` on the CDK
  // construct and it did nothing. CDK silently discards that prop when the
  // definition comes from DefinitionBody.fromString, so the synthesized template
  // held no TimeoutSeconds in the ASL and none among the state machine's
  // CloudFormation properties: the main document pipeline had no execution
  // timeout at all. A Standard execution with no bound survives up to a year, so
  // a lambda that wedges instead of erroring pins the document at PROCESSING and
  // the parent on a spinner for as long as it takes someone to notice by hand.
  // The bound therefore lives in the ASL, where it takes effect, and is pinned
  // here. The lower bound is the anti-hollowing half: 6h is a backstop, not a
  // performance budget, and re-pinning it down to something that could kill a
  // slow but succeeding run (30 minutes, or the sibling machine's 1800s) has to
  // fail even if the exact number above is edited to match.
  test('the state machine carries a real execution timeout', () => {
    const timeout = stateMachineDefinition().TimeoutSeconds;
    expect(timeout).toBe(21600);
    expect(timeout).toBeGreaterThan(WORST_CASE_RUN_SECONDS);
  });

  // WHY: failed_step was `$$.State.Name` read INSIDE RecordFailure, so it
  // resolved to the literal string "RecordFailure" for every failure the
  // pipeline has ever recorded. All six failures in production carry that
  // value, and none of them names the stage that actually broke, which is the
  // first thing anyone triaging wants and the field the document-pipeline
  // alarm's runbook points at.
  //
  // The fix routes each Task's Catch through a Pass that injects its own name,
  // so these assertions pin the wiring rather than the outcome: a Catch that
  // goes straight to RecordFailure again, or a marker whose Result drifts from
  // its state name, silently restores a field that lies.
  describe('a failure names the stage that failed', () => {
    test('every Catch is routed through a marker that injects its own step name', () => {
      const states = stateMachineDefinition().States;
      const caught = Object.entries<any>(states)
        .flatMap(([name, state]) => (state.Catch ?? []).map((c: any) => [name, c.Next]));

      expect(caught.length).toBeGreaterThan(0);
      for (const [source, next] of caught) {
        if (CATCH_EXEMPT_STATES.includes(source as string)) continue;
        // Never straight to RecordFailure: that is what made failed_step a lie.
        expect(next).toBe(`FailedAt${source}`);
        const marker = states[next as string];
        expect(marker.Type).toBe('Pass');
        // The literal must match the state it catches for, or the field names
        // the wrong stage, which is worse than naming none.
        expect(marker.Result).toBe(source);
        expect(marker.ResultPath).toBe('$.failed_step');
        expect(marker.Next).toBe('RecordFailure');
      }
    });

    test('RecordFailure reads the injected step, not its own state name', () => {
      const params = stateMachineDefinition().States.RecordFailure.Parameters.params;
      expect(params['failed_step.$']).toBe('$.failed_step');
      expect(params['failed_step.$']).not.toBe('$$.State.Name');
    });
  });
});

// The upload handler (knowledge-management/upload-s3) writes a document row
// with status PENDING_UPLOAD before the browser's presigned-URL PUT to S3 is
// confirmed. If that PUT never lands, no S3 event ever fires the
// orchestrator, so nothing in the pipeline itself moves the row again — this
// schedule is the only thing that does (ddb-service's
// expire_stale_pending_uploads).
describe('pending-upload sweep', () => {
  const sweepTargetsOf = (rule: any) =>
    (rule.Properties.Targets ?? []).filter((target: any) => {
      try {
        return JSON.parse(target.Input).operation === 'expire_stale_pending_uploads';
      } catch {
        return false;
      }
    });

  test('a scheduled rule invokes the DDB service to expire stale pending uploads', () => {
    const ddbServiceIds = Object.keys(template.findResources('AWS::Lambda::Function'))
      .filter((id) => id.includes('DDBServiceFunction'));
    expect(ddbServiceIds).toHaveLength(1);
    const [ddbServiceId] = ddbServiceIds;

    const rules = Object.values(template.findResources('AWS::Events::Rule'));
    const matchingTargets = rules
      .flatMap((rule: any) => sweepTargetsOf(rule))
      .filter((target: any) => JSON.stringify(target.Arn).includes(ddbServiceId));

    expect(matchingTargets).toHaveLength(1);
  });

  // Must run more often than PENDING_UPLOAD_TIMEOUT_MINUTES (15, in
  // ddb-service/handler.py) or a stuck upload could sit well past its
  // supposed timeout before the next pass even looks at it.
  test('the sweep runs more often than the 15-minute pending-upload timeout', () => {
    const rules = Object.values(template.findResources('AWS::Events::Rule')) as any[];
    const sweepRule = rules.find((rule) => sweepTargetsOf(rule).length > 0);
    expect(sweepRule).toBeDefined();

    const match = /rate\((\d+) minutes?\)/.exec(sweepRule.Properties.ScheduleExpression);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeLessThanOrEqual(15);
  });
});

describe('on-demand single-language translation', () => {
  const TRANSLATIONS_ROUTE =
    'POST /profile/children/{childId}/documents/{iepId}/translations';
  const MACHINE_HINT = 'SingleLanguageTranslationStateMachine';
  const ROLE_HINT = 'TranslationRequestFunctionServiceRole';

  const definition = () => parseStateMachineDefinition(template, MACHINE_HINT);

  // WHY: this route starts a paid OpenAI run against one family's IEP. The
  // catch-all authorizer test above would notice a missing JWT, but only if the
  // route is actually in the template — an integration wired to the wrong
  // lambda, or a route quietly dropped, would leave the frontend's translate
  // button returning 404 with nothing failing here. So the route is pinned by
  // name, together with its authorizer.
  test('the translations route exists and carries the JWT authorizer', () => {
    const routes = Object.values(template.findResources('AWS::ApiGatewayV2::Route'))
      .map((route: any) => route.Properties)
      .filter((p: any) => p.RouteKey === TRANSLATIONS_ROUTE);

    expect(routes).toHaveLength(1);
    expect(routes[0].AuthorizationType).toBe('JWT');
    expect(routes[0].AuthorizerId).toBeDefined();
  });

  // WHY: an async lambda invoke would have been simpler and wrong — the
  // translation step is a 600s function behind a 29s API Gateway cap, and
  // nothing but this machine puts the document back to PROCESSED afterwards.
  // If the machine disappears, every requested translation strands its document
  // at PROCESSING_TRANSLATIONS and the parent watches a spinner forever.
  test('the single-language translation state machine exists', () => {
    const machines = Object.keys(template.findResources('AWS::StepFunctions::StateMachine'));
    // Vacuity floor: the main pipeline plus this one.
    expect(machines.length).toBeGreaterThanOrEqual(2);
    expect(machines.filter((id) => id.includes(MACHINE_HINT))).toHaveLength(1);

    expect(definition().StartAt).toBe('TranslateRequestedLanguage');
  });

  // WHY: the CDK `timeout` prop is silently ignored when the definition comes
  // from DefinitionBody.fromString — the main pipeline's declared 30 minutes
  // renders no TimeoutSeconds at all. An unbounded Standard execution can sit
  // there for a year holding a document at PROCESSING_TRANSLATIONS, so the
  // bound is declared in the ASL and pinned here rather than trusted to a prop
  // that does nothing.
  test('the state machine carries a real execution timeout', () => {
    expect(definition().TimeoutSeconds).toBe(1800);
  });

  // WHY: same failure mode the main pipeline's catch-all pin guards. A task
  // that throws with no Catch leaves the document at PROCESSING_TRANSLATIONS
  // with no error recorded anywhere, which is indistinguishable from work still
  // running.
  test('every task catches States.ALL into RecordTranslationFailure', () => {
    const states = definition().States;
    expect(states.RecordTranslationFailure).toMatchObject({ Type: 'Task' });
    expect(states.TranslationFailed).toMatchObject({ Type: 'Fail' });

    const offenders = Object.entries(states)
      .filter(([name, state]: [string, any]) =>
        name !== 'RecordTranslationFailure' && state.Type === 'Task')
      .filter(([, state]: [string, any]) =>
        !(state.Catch ?? []).some((c: any) =>
          (c.ErrorEquals ?? []).includes('States.ALL') &&
          c.Next === 'RecordTranslationFailure'))
      .map(([name]) => name);

    // Vacuity floor: the translate task and the completion task.
    expect(Object.keys(states).length).toBeGreaterThanOrEqual(4);
    expect(offenders).toEqual([]);
  });

  // WHY: translate_content returns the whole translated summary and sections,
  // and Step Functions stores every state's output in execution history for 90
  // days. Without the ResultSelector, FERPA-protected document content lands in
  // the console for anyone with states:DescribeExecution. The main pipeline
  // avoids the same leak with ResultPath: null; here one field is needed, so the
  // narrowing has to be explicit and must stay.
  test('the translate result is narrowed to languages_processed only', () => {
    const translate = definition().States.TranslateRequestedLanguage;
    expect(Object.keys(translate.ResultSelector)).toEqual(['languages_processed.$']);
    expect(translate.Parameters.content_type).toBe('parsing_result');
    // Whatever the caller asked for, passed through verbatim — this is the
    // single-element list that makes the run an append rather than a rewrite.
    expect(translate.Parameters['target_languages.$']).toBe('$.target_languages');
  });

  // WHY: a failed optional translation must not mark an already-processed
  // document FAILED. The parent has readable English content in front of them;
  // FAILED would hide it behind the error screen and stop the UI ever offering
  // a retry. Deliberate divergence from the main pipeline's RecordFailure, so
  // it is pinned rather than left to be "fixed" into consistency later.
  test('a failed translation leaves the document PROCESSED, not FAILED', () => {
    const states = definition().States;
    const statusesWritten = ['MarkTranslationComplete', 'RecordTranslationFailure']
      .map((name) => states[name].Parameters.params.status);
    expect(statusesWritten).toEqual(['PROCESSED', 'PROCESSED']);
    expect(states.RecordTranslationFailure.Parameters.params.last_error).toBeDefined();
    // The cause must not be piped into the document: it is an exception string
    // from a step that handles document text, and a provider error can echo
    // prompt content. Parameters only — the state's Comment explains this and
    // naming $.error.Cause there must not fail the pin.
    expect(JSON.stringify(states.RecordTranslationFailure.Parameters))
      .not.toContain('$.error');
  });

  // WHY: this lambda is the only thing in the app that can start an execution.
  // A wildcard resource would let a compromise of an unauthenticated-adjacent
  // API lambda drive the full document pipeline (OCR, redaction, deletion of
  // the original) instead of just one translation.
  test('StartExecution is scoped to the translation machine alone', () => {
    const statements = Object.values(template.findResources('AWS::IAM::Policy'))
      .map((policy: any) => policy.Properties ?? {})
      .filter((props: any) => JSON.stringify(props.Roles ?? []).includes(ROLE_HINT))
      .flatMap((props: any) => props.PolicyDocument?.Statement ?? [])
      .filter((statement: any) =>
        [statement.Action ?? []].flat().some((a: any) =>
          typeof a === 'string' && a.startsWith('states:')));

    expect(statements).toHaveLength(1);
    expect([statements[0].Action].flat()).toEqual(['states:StartExecution']);

    const resource = JSON.stringify(statements[0].Resource);
    expect(resource).toContain(MACHINE_HINT);
    expect(resource).not.toContain('IEPProcessingStateMachine');
    expect(resource).not.toBe('"*"');
  });

  // WHY: the handler reads a document and conditionally flips its status. It has
  // no business deleting or replacing a document row, and PutItem on this table
  // would let a bug overwrite a family's only IEP record. Pinned as an exact
  // set so a widened grant (a copied grantReadWriteData) fails here.
  test('the handler holds only the DynamoDB actions it uses', () => {
    expect(allowedActionsFor(template, ROLE_HINT, 'dynamodb:')).toEqual([
      'dynamodb:GetItem',
      'dynamodb:UpdateItem',
    ]);
  });

  // WHY: it only needs to see which languages content.json already has. Write
  // access to iep-data/ would put the canonical content of every processed
  // document one bug away from being overwritten by an API handler.
  test('the handler holds only read access to S3', () => {
    expect(allowedActionsFor(template, ROLE_HINT, 's3:')).toEqual([
      's3:GetObject',
      's3:ListBucket',
    ]);
  });
});

// Lambda caps ALL environment variables at 4KB COMBINED, and CloudFormation
// only says so at deploy time. A manifest of 23 components measured 4,745
// bytes and took the staging deploy down with it, after CI had gone green.
//
// Tokens are the reason this needs care: an unresolved `${Token[...]}` is
// shorter than the value it becomes, so a naive measurement understates the
// real size. Each is counted as a generous fixed width instead, which is why
// the budget below is well under 4096 rather than at it.
describe('Lambda environment variables fit inside the 4KB limit', () => {
  // Staging only, and that is the worst case on purpose: every staging
  // resource name carries an extra "staging", so if it fits here it fits in
  // production.
  const LAMBDA_ENV_LIMIT_BYTES = 4096;
  // An unresolved `${Token[...]}` is shorter than the name it becomes, so
  // measuring the synthesized text understates the deployed size. Each token
  // is charged a generous fixed width instead.
  const ASSUMED_TOKEN_BYTES = 140;

  // Walks the value rather than measuring its JSON. A large env var
  // synthesizes as an Fn::Join whose parts hold the real text, so charging
  // the whole object a flat token width undercounts it by thousands of bytes.
  // That mistake made the first version of this test pass against the exact
  // manifest that broke the deploy.
  const measureValue = (value: unknown): number => {
    if (typeof value === 'string') {
      const tokens = (value.match(/\$\{Token\[/g) ?? []).length;
      return value.length + tokens * ASSUMED_TOKEN_BYTES;
    }
    if (Array.isArray(value)) {
      return value.reduce<number>((total, item) => total + measureValue(item), 0);
    }
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      if ('Fn::Join' in object) {
        const [delimiter, parts] = object['Fn::Join'] as [string, unknown[]];
        const joined: number = parts.reduce<number>(
          (total, part) => total + measureValue(part), 0);
        return joined + delimiter.length * Math.max(0, parts.length - 1);
      }
      // A Ref or GetAtt: resolves to one resource name at deploy.
      return ASSUMED_TOKEN_BYTES;
    }
    return 0;
  };

  const measure = (variables: Record<string, unknown>): number =>
    Object.entries(variables).reduce(
      (total, [key, value]) => total + key.length + measureValue(value), 0);

  test('no function is close to the limit', () => {
    const functions = Object.entries(template.findResources('AWS::Lambda::Function'));
    expect(functions.length).toBeGreaterThan(0);

    const oversized = functions
      .map(([logicalId, resource]) => ({
        logicalId,
        bytes: measure((resource as any).Properties?.Environment?.Variables ?? {}),
      }))
      .filter((f) => f.bytes >= LAMBDA_ENV_LIMIT_BYTES);

    expect(oversized).toEqual([]);
  });
});

describe('Lambda runtimes', () => {
  // One approved runtime per language keeps deprecation upgrades atomic and
  // matches CI's pinned toolchains (python 3.12 in the pytest job, node 20 in
  // the jest job) — a stray runtime means tests exercise a different VM than
  // production runs.
  test('all app lambdas run python3.12 or nodejs20.x', () => {
    const functions = Object.entries(template.findResources('AWS::Lambda::Function'))
      .filter(([logicalId]) => !CDK_HELPER_PREFIXES.some((prefix) => logicalId.startsWith(prefix)));

    // 23 app functions today; a large shrink means the helper filter (or the
    // stack) broke and the loop below would pass vacuously.
    expect(functions.length).toBeGreaterThanOrEqual(20);

    const offenders = functions
      .filter(([, fn]: [string, any]) => !APPROVED_RUNTIMES.includes(fn.Properties.Runtime))
      .map(([logicalId, fn]: [string, any]) => `${logicalId}: ${JSON.stringify(fn.Properties.Runtime)}`);

    expect(offenders).toEqual([]);
  });
});

describe('Python lambda assets exclude __pycache__', () => {
  const FUNCTIONS_DIR = path.join(__dirname, '../../lib/chatbot-api/functions');
  const SOURCE = fs.readFileSync(path.join(FUNCTIONS_DIR, 'functions.ts'), 'utf8');
  const CALL = "lambda.Code.fromAsset(path.join(__dirname, '";

  /**
   * Every fromAsset call site with a literal directory, paired with the text of
   * its options object. The window for each site ends at the next fromAsset
   * call, so an `exclude` belonging to a different site can never satisfy this
   * one.
   */
  function assetCallSites(): { dir: string; options: string }[] {
    const sites: { dir: string; options: string }[] = [];
    for (let i = SOURCE.indexOf(CALL); i !== -1; i = SOURCE.indexOf(CALL, i + 1)) {
      const start = i + CALL.length;
      const dir = SOURCE.slice(start, SOURCE.indexOf("'", start));
      const next = SOURCE.indexOf(CALL, i + 1);
      sites.push({ dir, options: SOURCE.slice(start, next === -1 ? SOURCE.length : next) });
    }
    return sites;
  }

  const isPythonAsset = (dir: string) =>
    fs.existsSync(path.join(FUNCTIONS_DIR, dir)) &&
    fs.readdirSync(path.join(FUNCTIONS_DIR, dir)).some((f) => f.endsWith('.py'));

  // WHY: the pytest suite imports these handlers by path, leaving a __pycache__
  // in the source directory, and fromAsset fingerprints and zips the directory
  // verbatim. Without an exclude, a laptop that has run pytest stages a
  // different asset hash than a clean CI checkout: the deploy cache churns and
  // .pyc files ship to production. Measured, not assumed — dropping the exclude
  // from referral-handler moves its hash from b0798298 to c7124259 purely
  // because a __pycache__ exists on disk.
  //
  // `assetHashType: SOURCE` does NOT cover this. It selects which content is
  // hashed, not what is filtered out of it; the filtering is these fingerprint
  // options. That is the assumption this pin exists to stop.
  //
  // This reads source rather than the template on purpose: an exclude leaves no
  // trace in the synthesized template (it only shifts an opaque asset hash), so
  // there is nothing in the template to assert against.
  test('every Python lambda asset is staged with the __pycache__ exclude', () => {
    const pythonSites = assetCallSites().filter((s) => isPythonAsset(s.dir));

    // Vacuity floor: 8 literal-directory Python call sites today
    // (user-profile-handler is staged twice). A large shrink means the parser
    // broke and the loop below would pass by finding nothing. The step lambdas
    // are staged through a shared helper with a variable path, so they are not
    // literal sites and are pinned separately below.
    expect(pythonSites.length).toBeGreaterThanOrEqual(8);

    const offenders = pythonSites
      .filter((s) => !s.options.includes('exclude: PYTHON_ASSET_EXCLUDES'))
      .map((s) => s.dir);

    expect(offenders).toEqual([]);
  });

  // WHY: the eight pipeline step lambdas are the ones pytest actually imports
  // most (five carry a __pycache__ right now), and they are all staged through
  // createStepFunctionLambda, whose asset path is the `handlerPath` variable
  // rather than a literal. The parser above cannot see it, so without this the
  // biggest group of affected functions would be silently uncovered.
  test('the shared step-function lambda helper stages with the exclude too', () => {
    const helperCall = "lambda.Code.fromAsset(path.join(__dirname, handlerPath), {";
    const start = SOURCE.indexOf(helperCall);
    expect(start).toBeGreaterThan(-1);

    const options = SOURCE.slice(start, SOURCE.indexOf('handler:', start));
    expect(options).toContain('exclude: PYTHON_ASSET_EXCLUDES');
  });

  // WHY: guards the constant the pin above matches on. If PYTHON_ASSET_EXCLUDES
  // were edited to an empty list, every call site would still read
  // `exclude: PYTHON_ASSET_EXCLUDES` and the test above would pass while
  // excluding nothing.
  test('the shared exclude constant actually lists __pycache__', () => {
    expect(SOURCE).toContain("const PYTHON_ASSET_EXCLUDES = ['__pycache__'];");
  });
});

describe('production synth: SMS delivery-status logging', () => {
  let prodTemplate: Template;
  let saved: string | undefined;

  beforeAll(() => {
    saved = process.env.ENVIRONMENT;
    process.env.ENVIRONMENT = 'production';
    jest.resetModules();
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { GenAiMvpStack } = require('../../lib/gen-ai-mvp-stack');
    /* eslint-enable @typescript-eslint/no-var-requires */
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    prodTemplate = Template.fromStack(new GenAiMvpStack(app, 'AIEPStack', {}));
  }, 180_000);

  afterAll(() => {
    process.env.ENVIRONMENT = saved;
    jest.resetModules();
  });

  // A message the provider accepts and then fails to deliver is otherwise
  // invisible: the publish succeeds, an id comes back, and nothing records
  // that it never arrived. This role is what lets SNS write that down.
  test('SNS can write SMS delivery outcomes, and only that', () => {
    prodTemplate.hasResourceProperties('AWS::IAM::Role', Match.objectLike({
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Principal: { Service: 'sns.amazonaws.com' } }),
        ]),
      }),
    }));

    const statements = Object.values(prodTemplate.findResources('AWS::IAM::Policy'))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement as any[]);
    const deliveryStatus = statements.filter((st) =>
      JSON.stringify(st.Action).includes('logs:PutMetricFilter'),
    );
    expect(deliveryStatus.length).toBeGreaterThan(0);
    for (const st of deliveryStatus) {
      // Logs only. This role is assumable by an AWS service, so anything
      // beyond writing logs would be a standing grant to SNS.
      const actions = ([] as string[]).concat(st.Action);
      expect(actions.every((a) => a.startsWith('logs:'))).toBe(true);
    }
  });


  // The SNS setting this role serves is account-level, so there is exactly
  // one of it. A copy per environment would model it as though each had its
  // own: whichever role the account setting names is the one in use, so
  // tearing down the other environment would silently end delivery logging
  // for both, with nothing in either stack hinting at it.
  test('the role exists in production and NOT in staging', () => {
    const prodRoles = Object.values(prodTemplate.findResources('AWS::IAM::Role'))
      .map((r: any) => r.Properties)
      .filter((p: any) => String(p.RoleName ?? '').includes('sms-delivery-status'));
    const stagingRoles = Object.values(template.findResources('AWS::IAM::Role'))
      .map((r: any) => r.Properties)
      .filter((p: any) => String(p.RoleName ?? '').includes('sms-delivery-status'));

    expect(prodRoles).toHaveLength(1);
    expect(stagingRoles).toHaveLength(0);
  });
});

describe('production synth: HTTP API access logging', () => {
  // rest-api.ts has no getEnvironment() branch of its own, but the whole
  // point of this pin is that a request rejected by the JWT authorizer must
  // stop being invisible in BOTH environments, not just the one the rest of
  // this file happens to synthesize by default.
  let prodTemplate: Template;
  let saved: string | undefined;

  beforeAll(() => {
    saved = process.env.ENVIRONMENT;
    process.env.ENVIRONMENT = 'production';
    jest.resetModules();
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { GenAiMvpStack } = require('../../lib/gen-ai-mvp-stack');
    /* eslint-enable @typescript-eslint/no-var-requires */
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    prodTemplate = Template.fromStack(new GenAiMvpStack(app, 'AIEPStack', {}));
  }, 180_000);

  afterAll(() => {
    process.env.ENVIRONMENT = saved;
    jest.resetModules();
  });

  test('the default stage logs access in production too, with the same safe format', () => {
    const stages = prodTemplate.findResources('AWS::ApiGatewayV2::Stage');
    const entries = Object.values(stages).map((s: any) => s.Properties);
    expect(entries).toHaveLength(1);

    const format = entries[0].AccessLogSettings?.Format;
    expect(entries[0].AccessLogSettings?.DestinationArn).toBeDefined();
    expect(typeof format).toBe('string');
    expect(format).not.toContain('$context.path');
    expect(format).not.toContain('$context.identity');
    expect(format).not.toContain('$context.authorizer.claims');
    expect(format).toContain('$context.requestId');
  });
});

describe('production synth: the OTP test backdoor must not exist', () => {
  // THE CROWN JEWEL OF THE BACKDOOR CHANGE. Staging diverts OTPs for
  // allowlisted fictional numbers into SSM (see the staging pins above); the
  // production template must carry no trace of that machinery. Only a
  // production synth can prove the gate in lib/authorization/new-auth.ts
  // actually holds, so this describe pays for a second full synth.
  let prodTemplate: Template;

  beforeAll(() => {
    // Sharing the module registry with the staging synth above is safe
    // because the backdoor gate (getEnvironment() in new-auth.ts) is
    // evaluated at construct time, not import time — the same reason the
    // real production pipeline (ENVIRONMENT=production, fresh process) gets
    // the gate right. Import-time constants (stack/domain names) stay
    // staging-flavored in this synth; none of them feed the assertions.
    process.env.ENVIRONMENT = 'production';

    /* eslint-disable @typescript-eslint/no-var-requires */
    const { GenAiMvpStack } = require('../../lib/gen-ai-mvp-stack');
    /* eslint-enable @typescript-eslint/no-var-requires */

    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const stack = new GenAiMvpStack(app, 'AIEPStack', {});
    prodTemplate = Template.fromStack(stack);
  }, 180_000);

  afterAll(() => {
    // Hand back the file-wide staging default; the top-level afterAll
    // restores the caller's original value after that.
    process.env.ENVIRONMENT = 'staging';
  });

  test('no production lambda carries TEST_PHONE_NUMBERS or TEST_OTP_PARAM_PREFIX', () => {
    const functions = Object.entries(prodTemplate.findResources('AWS::Lambda::Function'));
    // Vacuity floor, mirroring the runtime pin: a shrunken template must not
    // pass this by having nothing to check.
    expect(functions.length).toBeGreaterThanOrEqual(20);

    const offenders = functions
      .filter(([, fn]: [string, any]) => {
        const vars = fn.Properties?.Environment?.Variables ?? {};
        return 'TEST_PHONE_NUMBERS' in vars || 'TEST_OTP_PARAM_PREFIX' in vars;
      })
      .map(([logicalId]) => logicalId);

    expect(offenders).toEqual([]);
  });

  // The email half of the same allowlist, added with /auth/start. Same double
  // lock as the phone one: an env var production never gets, plus a hard-coded
  // reserved-domain expression in create-auth-challenge and destination.js.
  // Both halves must be provably absent, not merely unused.
  test('no production lambda carries TEST_EMAIL_ADDRESSES', () => {
    const functions = Object.entries(prodTemplate.findResources('AWS::Lambda::Function'));
    expect(functions.length).toBeGreaterThanOrEqual(20);

    const offenders = functions
      .filter(([, fn]: [string, any]) => 'TEST_EMAIL_ADDRESSES' in (fn.Properties?.Environment?.Variables ?? {}))
      .map(([logicalId]) => logicalId);
    expect(offenders).toEqual([]);

    // And the fictional domain itself appears nowhere, which also catches an
    // address that reached the template by some other route.
    expect(JSON.stringify(prodTemplate.toJSON())).not.toContain('a-iep.invalid');
  });

  test('no production resource references the test-otp SSM prefix', () => {
    // Sweeps IAM policies and everything else in one pass: the string simply
    // must not appear anywhere in the production template.
    expect(JSON.stringify(prodTemplate.toJSON())).not.toContain('/a-iep/staging/test-otp');
  });

  // The signup endpoint's Turnstile bypass, which exists only so the E2E
  // suite can complete an account creation: a real widget refuses automated
  // browsers, which is the entire product. In production there must be no
  // env var, no SSM grant and no parameter reference, so the bypass branch in
  // signup-endpoint.js is unreachable rather than merely unused.
  test('no production lambda can bypass the signup bot check', () => {
    const functions = Object.entries(prodTemplate.findResources('AWS::Lambda::Function'));
    expect(functions.length).toBeGreaterThanOrEqual(20);

    const offenders = functions
      .filter(([, fn]: [string, any]) => 'E2E_BYPASS_PARAM' in (fn.Properties?.Environment?.Variables ?? {}))
      .map(([logicalId]) => logicalId);
    expect(offenders).toEqual([]);

    // And nothing anywhere may even name the parameter, which also covers the
    // IAM grant.
    expect(JSON.stringify(prodTemplate.toJSON()))
      .not.toContain('/a-iep/staging/e2e-turnstile-bypass');
  });

  // A custom SMS sender takes over ALL of a pool's SMS delivery. On staging
  // that is the point; in production it would put every parent's login and
  // signup code behind a lambda that exists to divert codes into SSM. The
  // production pool must keep Cognito's native delivery, so neither the
  // trigger nor the key it requires may appear.
  test('no production user pool assigns a CustomSMSSender or a sender KMS key', () => {
    const pools = Object.values(prodTemplate.findResources('AWS::Cognito::UserPool'));
    expect(pools.length).toBeGreaterThanOrEqual(1);

    for (const pool of pools) {
      const lambdaConfig = (pool as any).Properties?.LambdaConfig ?? {};
      // The real auth triggers must still be there; only the sender (and the
      // key id it drags in) must be absent.
      expect(lambdaConfig.DefineAuthChallenge).toBeDefined();
      // PreSignUp is deliberately NOT environment-gated: the two-SMS signup it
      // fixes was a usability bug in production too. If a future change ever
      // wraps it in a getEnvironment() check, this fails rather than quietly
      // leaving production parents with two codes.
      expect(lambdaConfig.PreSignUp).toBeDefined();
      expect(lambdaConfig.PostConfirmation).toBeDefined();
      expect(lambdaConfig.CustomSMSSender).toBeUndefined();
      expect(lambdaConfig.CustomEmailSender).toBeUndefined();
      expect(lambdaConfig.KMSKeyID).toBeUndefined();
    }
  });

  test('no production KMS alias belongs to the custom sender', () => {
    const aliases = Object.values(prodTemplate.findResources('AWS::KMS::Alias'))
      .map((alias: any) => alias.Properties?.AliasName)
      .filter((name: any) => typeof name === 'string');

    expect(aliases.filter((name: string) => name.includes('custom-sender'))).toEqual([]);
  });

  // Nested here to reuse this describe's production synth: the retention and
  // naming pins matter most for production (that is where 50 of 102 documents
  // were lost), and a second top-level synth would double the suite's runtime.
  describeDurableStoreRetention('production', () => prodTemplate);
});

describe('custom-certificate synth: the CloudFront TLS floor', () => {
  // The viewerCertificate block in lib/user-interface/generate-app.ts only
  // renders when ACM_CERTIFICATE_ARN and DOMAIN are both set, which is how
  // the real deploys run and how a-iep.org and dev.a-iep.org got their certs.
  // The shared synth above leaves both unset, so it produces the default
  // *.cloudfront.net certificate and cannot see this field at all. That blind
  // spot is exactly why the TLSv1 floor survived: pay for a third synth.
  let certTemplate: Template;
  let savedAcmArn: string | undefined;
  let savedDomain: string | undefined;

  beforeAll(() => {
    savedAcmArn = process.env.ACM_CERTIFICATE_ARN;
    savedDomain = process.env.DOMAIN;
    process.env.ACM_CERTIFICATE_ARN =
      'arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555';
    process.env.DOMAIN = 'example.test';

    /* eslint-disable @typescript-eslint/no-var-requires */
    const { GenAiMvpStack } = require('../../lib/gen-ai-mvp-stack');
    const { stackName } = require('../../lib/constants');
    /* eslint-enable @typescript-eslint/no-var-requires */

    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    certTemplate = Template.fromStack(new GenAiMvpStack(app, stackName, {}));
  }, 180_000);

  afterAll(() => {
    process.env.ACM_CERTIFICATE_ARN = savedAcmArn;
    process.env.DOMAIN = savedDomain;
  });

  test('the distribution serves the custom certificate over TLS 1.2 or better', () => {
    const distributions = Object.values(certTemplate.findResources('AWS::CloudFront::Distribution'));
    expect(distributions).toHaveLength(1);

    const viewerCertificate = (distributions[0] as any).Properties?.DistributionConfig?.ViewerCertificate;
    // Vacuity floor: with the env vars unset this object is the default
    // certificate and carries no MinimumProtocolVersion, so the pin below
    // would pass against undefined === undefined if the block stopped
    // rendering. Prove the custom certificate is the one under test first.
    expect(viewerCertificate?.AcmCertificateArn).toBe(process.env.ACM_CERTIFICATE_ARN);
    expect(viewerCertificate?.SslSupportMethod).toBe('sni-only');

    // CloudFormation's own default here is 'TLSv1', which also permits 3DES.
    expect(viewerCertificate?.MinimumProtocolVersion).toBe('TLSv1.2_2021');
  });
});
