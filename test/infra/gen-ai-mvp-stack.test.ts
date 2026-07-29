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
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

// The one deliberately unauthenticated route: the referral click beacon is
// hit by visitors who are not signed in yet, stores no PII, and only bumps
// counters for known active codes (lib/chatbot-api/index.ts). Anything else
// added here must survive the same scrutiny.
const PUBLIC_ROUTE_KEYS = ['POST /referral/click'];

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
const USER_DATA_TABLE_HINTS = ['UserProfilesTable', 'IepDocumentsTable', 'ReferralsTable'];

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
const USER_DATA_LOGICAL_IDS = {
  staging: [
    'ChatbotAPIstagingKnowledgeSourceBucket6569EF05',
    'ChatbotAPIstagingUserProfilesTable49F35014',
    'ChatbotAPIstagingIepDocumentsTable38D1586F',
    'ChatbotAPIstagingReferralsTableF8A5555D',
  ],
  production: [
    'ChatbotAPIKnowledgeSourceBucketD704DDFD',
    'ChatbotAPIUserProfilesTable3923A78F',
    'ChatbotAPIIepDocumentsTable6A6A0420',
    'ChatbotAPIReferralsTable4107EA6C',
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
      // Three user-data tables plus the OTP rate limiter.
      expect(tables.length).toBeGreaterThanOrEqual(4);

      const userDataTables = tables.filter(([logicalId]) =>
        USER_DATA_TABLE_HINTS.some((hint) => logicalId.includes(hint)));
      // Vacuity floor: all three must be found, or a rename hollowed the pin out.
      expect(userDataTables).toHaveLength(USER_DATA_TABLE_HINTS.length);

      expect(retentionOffenders(userDataTables)).toEqual([]);
    });

    // Cognito cannot export or re-import credentials, so a replaced or
    // destroyed pool locks every parent out permanently with no restore path.
    test('the Cognito user pool retains on delete and on replace', () => {
      const pools = resourcesMatching(getTemplate(), 'AWS::Cognito::UserPool', 'NewUserPool');
      expect(pools).toHaveLength(1);
      expect(retentionOffenders(pools)).toEqual([]);
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
  test('every route requires the JWT authorizer except the referral click beacon', () => {
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
  test('POST /referral/click is the single deliberately public route', () => {
    const routes = template.findResources('AWS::ApiGatewayV2::Route');

    const publicRoutes = Object.values(routes)
      .map((route: any) => route.Properties)
      .filter((p: any) => p.AuthorizationType !== 'JWT');

    expect(publicRoutes.map((p: any) => p.RouteKey)).toEqual(PUBLIC_ROUTE_KEYS);
    for (const p of publicRoutes) {
      expect(p.AuthorizationType ?? 'NONE').toBe('NONE');
      expect(p.AuthorizerId).toBeUndefined();
    }
  });

  // An AuthorizerId is only as strong as the authorizer behind it: it must
  // validate Authorization-header JWTs issued by OUR user pool for OUR app
  // client, not merely exist.
  test('the JWT authorizer validates tokens from the app user pool client', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
      IdentitySource: ['$request.header.Authorization'],
      JwtConfiguration: Match.objectLike({
        Audience: [{ Ref: Match.stringLikeRegexp('NewUserPoolClient') }],
        Issuer: { 'Fn::GetAtt': [Match.stringLikeRegexp('NewUserPool'), 'ProviderURL'] },
      }),
    });
  });
});

describe('Cognito custom-auth wiring', () => {
  // Phone OTP sign-in is entirely trigger-driven; a pool that synths with any
  // of the five missing breaks login in ways only visible at runtime (the
  // 2026-07 silent-signup outage was exactly this class of failure).
  test('user pool wires all five custom-auth triggers', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.hasResourceProperties('AWS::Cognito::UserPool', Match.objectLike({
      LambdaConfig: Match.objectLike({
        DefineAuthChallenge: Match.anyValue(),
        CreateAuthChallenge: Match.anyValue(),
        VerifyAuthChallengeResponse: Match.anyValue(),
        CustomMessage: Match.anyValue(),
        PreAuthentication: Match.anyValue(),
      }),
    }));
  });

  test('user pool client keeps the custom-auth contract', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', Match.objectLike({
      // The define-auth-challenge handler's userNotFound guard is written
      // against this setting; flipping it changes how unknown numbers fail.
      PreventUserExistenceErrors: 'ENABLED',
      // Without CUSTOM_AUTH the OTP flow can't even start.
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_CUSTOM_AUTH']),
      // The whole handshake+OTP session must fit the 5-minute validity the
      // SMS text promises (see lib/authorization/new-auth.ts).
      AuthSessionValidity: 5,
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

  // create-auth-challenge fails open (or falls back to English SMS) when its
  // table wiring is missing, so the env vars are load-bearing: the rate-limit
  // counter and the profile lookup for OTP localization.
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

describeDurableStoreRetention('staging', () => template);

describe('IEP processing state machine', () => {
  // The ASL definition reaches the template as an Fn::Join of JSON fragments
  // with lambda ARN tokens spliced inside string values; substituting a plain
  // placeholder for each token yields parseable JSON again.
  function stateMachineDefinition(): any {
    const machines = template.findResources('AWS::StepFunctions::StateMachine');
    expect(Object.keys(machines)).toHaveLength(1);
    const ds: any = Object.values(machines)[0].Properties.DefinitionString;
    if (typeof ds === 'string') return JSON.parse(ds);
    const [separator, parts] = ds['Fn::Join'];
    return JSON.parse(parts.map((p: any) => (typeof p === 'string' ? p : 'ARN')).join(separator));
  }

  // A processing failure that never reaches RecordFailure leaves the document
  // stuck at PROCESSING forever — the parent sees an eternal spinner and the
  // failure is invisible to us (no failed_step, no error_message in DDB).
  test('every task and parallel state catches States.ALL into RecordFailure', () => {
    const definition = stateMachineDefinition();
    expect(definition.States.RecordFailure).toMatchObject({ Type: 'Task' });

    const offenders = Object.entries(definition.States)
      .filter(([name, state]: [string, any]) =>
        name !== 'RecordFailure' && (state.Type === 'Task' || state.Type === 'Parallel'))
      .filter(([, state]: [string, any]) => {
        const catches: any[] = state.Catch ?? [];
        return !catches.some((c) =>
          (c.ErrorEquals ?? []).includes('States.ALL') && c.Next === 'RecordFailure');
      })
      .map(([name]) => name);

    expect(offenders).toEqual([]);
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

  test('no production resource references the test-otp SSM prefix', () => {
    // Sweeps IAM policies and everything else in one pass: the string simply
    // must not appear anywhere in the production template.
    expect(JSON.stringify(prodTemplate.toJSON())).not.toContain('/a-iep/staging/test-otp');
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
      // The five custom-auth triggers must still be there; only the sender
      // (and the key id it drags in) must be absent.
      expect(lambdaConfig.DefineAuthChallenge).toBeDefined();
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
