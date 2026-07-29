/**
 * Global setup: resolve the deployed staging environment, then make sure the
 * persistent test users exist.
 *
 * The CloudFront URL and user pool id come from the AIEPStagingStack outputs
 * at runtime (same approach as scripts/smoke-test.sh) so the suite never
 * goes stale when the stack changes. Output keys are matched by substring
 * because CDK mangles logical ids (e.g.
 * UserInterfacestagingWebsiteUserInterfaceDomainNameDD905D62).
 *
 * Local override: set SITE_URL (and optionally USER_POOL_ID) to skip the
 * CloudFormation lookup for the site; the pool id is still needed for the
 * user-healing helpers, so without USER_POOL_ID the lookup runs anyway.
 */
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { REGION, STACK_NAME, stashResolvedConfig } from './helpers/config';
import { ensureTestUser } from './helpers/aws';
import { STABLE_USER, LOCKOUT_USER, PROFILE_USER, DOCUMENTS_USER } from './helpers/phones';

async function resolveStackOutputs(): Promise<{ siteUrl: string; userPoolId: string }> {
  const cfn = new CloudFormationClient({ region: REGION });
  let outputs;
  try {
    const result = await cfn.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
    outputs = result.Stacks?.[0]?.Outputs ?? [];
  } catch (error) {
    const err = error as Error;
    if (err.name === 'CredentialsProviderError' || /credential/i.test(err.message)) {
      throw new Error(
        'AWS credentials are missing: the suite resolves the staging URL and ' +
        'user pool from CloudFormation and reads OTPs from SSM. In CI the ' +
        'workflow provides them; locally, export AWS credentials for the ' +
        `staging account (region ${REGION}) before running. Original error: ${err.message}`
      );
    }
    throw new Error(`Could not describe stack ${STACK_NAME} in ${REGION}: ${err.message}`);
  }

  const outputLike = (test: (key: string) => boolean): string | undefined =>
    outputs.find((o) => o.OutputKey && test(o.OutputKey))?.OutputValue;

  const siteUrl = outputLike((k) => k.includes('UserInterfaceDomainName'));
  // 'NewUserPoolID...' must not be confused with 'NewUserPoolClientID...'
  const userPoolId = outputLike((k) => k.includes('UserPoolID') && !k.includes('ClientID'));

  if (!siteUrl || !userPoolId) {
    throw new Error(
      `Stack ${STACK_NAME} is missing expected outputs ` +
      `(UserInterfaceDomainName -> ${siteUrl ?? 'NOT FOUND'}, ` +
      `UserPoolID -> ${userPoolId ?? 'NOT FOUND'}). ` +
      'Did the stack outputs get renamed? Update global-setup.ts to match.'
    );
  }
  return { siteUrl, userPoolId };
}

export default async function globalSetup(): Promise<void> {
  let siteUrl = process.env.SITE_URL;
  let userPoolId = process.env.USER_POOL_ID;

  if (!siteUrl || !userPoolId) {
    const resolved = await resolveStackOutputs();
    siteUrl = siteUrl || resolved.siteUrl;
    userPoolId = userPoolId || resolved.userPoolId;
  }

  stashResolvedConfig(siteUrl, userPoolId);
  console.log(`[e2e setup] site: ${siteUrl}`);
  console.log(`[e2e setup] user pool: ${userPoolId}`);

  // Every persistent user must exist before its journey runs. The throwaway
  // re-signup number is deliberately NOT healed here: its spec deletes the
  // account mid-journey, so healing must happen per attempt (inside the
  // spec) or the automatic retry would start user-less.
  await ensureTestUser(STABLE_USER);
  await ensureTestUser(LOCKOUT_USER);
  await ensureTestUser(PROFILE_USER);
  await ensureTestUser(DOCUMENTS_USER);
  console.log('[e2e setup] persistent test users ensured');
}
