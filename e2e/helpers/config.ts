/**
 * Resolved-at-runtime configuration.
 *
 * Everything is resolved from the AIEPStagingStack CloudFormation outputs in
 * global-setup (nothing is hardcoded that can go stale when the stack
 * changes), then handed to the workers through process.env: the Playwright
 * config file is evaluated BEFORE global setup runs, so a config-time
 * `baseURL` cannot carry a value that only exists after stack resolution.
 * Worker processes are forked after global setup, so env is the one channel
 * that reaches them without touching disk.
 */

export const REGION = process.env.AWS_REGION ?? 'us-east-1';

/** The staging stack; overridable for one-off experiments only. */
export const STACK_NAME = process.env.E2E_STACK_NAME ?? 'AIEPStagingStack';

/**
 * Where the staging OTP backdoor stashes codes for allowlisted numbers.
 * SSM parameter names cannot contain '+', so the leaf is the E.164 number
 * WITHOUT the plus: /a-iep/staging/test-otp/15555550111.
 */
export const TEST_OTP_PARAM_PREFIX = '/a-iep/staging/test-otp';

// Set by global-setup; never set these two by hand (use SITE_URL /
// USER_POOL_ID to override resolution instead, see global-setup.ts).
const SITE_URL_ENV = 'E2E_RESOLVED_SITE_URL';
const USER_POOL_ENV = 'E2E_RESOLVED_USER_POOL_ID';

export function stashResolvedConfig(siteUrl: string, userPoolId: string): void {
  process.env[SITE_URL_ENV] = siteUrl;
  process.env[USER_POOL_ENV] = userPoolId;
}

function requireEnv(name: string, what: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${what} is not resolved (missing ${name}). ` +
      'Global setup resolves it from the AIEPStagingStack outputs; ' +
      'run the suite through `npx playwright test` so global-setup executes.'
    );
  }
  return value;
}

export function getSiteUrl(): string {
  return requireEnv(SITE_URL_ENV, 'The staging site URL');
}

export function getUserPoolId(): string {
  return requireEnv(USER_POOL_ENV, 'The staging Cognito user pool id');
}

/** Absolute URL for an app path, e.g. appUrl('/login'). */
export function appUrl(path: string): string {
  return new URL(path, getSiteUrl()).toString();
}
