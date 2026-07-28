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
  });

  // The backdoor's write permission must stay pinned to the test-otp prefix;
  // a widened resource would let the auth lambda scribble over real config
  // (e.g. the /a-iep/* and /ai-iep/* app parameters).
  test('staging scopes ssm:PutParameter to the test-otp prefix only', () => {
    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    const ssmPutStatements = policies.flatMap((policy: any) =>
      (policy.Properties?.PolicyDocument?.Statement ?? []).filter((stmt: any) =>
        JSON.stringify(stmt.Action).includes('ssm:PutParameter')));

    expect(ssmPutStatements).toHaveLength(1);
    // The resource is an Fn::Join around the AccountId pseudo-parameter; its
    // serialized form must pin the region and the parameter prefix.
    const resource = JSON.stringify(ssmPutStatements[0].Resource);
    expect(resource).toContain('arn:aws:ssm:us-east-1:');
    expect(resource).toContain('parameter/a-iep/staging/test-otp/*');
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
});

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

  // Guards the catch-all test against renames hollowing it out: the OCR and
  // redaction tasks plus the Parallel wrapper that carries the parsing
  // agent's Catch (branch states can't route outside their Parallel) must
  // exist under these names.
  test('the OCR, redaction, and parsing stages are present by name', () => {
    const definition = stateMachineDefinition();
    for (const name of ['MistralOCR', 'RedactOCR', 'ParallelWork']) {
      expect(definition.States[name]).toBeDefined();
    }
    expect(definition.States.ParallelWork.Branches[0].States.ParsingAgent).toBeDefined();
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
});
