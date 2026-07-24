import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Principals allowed to access IEP data (the knowledge S3 bucket and the
 * DynamoDB tables). This account is shared with other projects and users,
 * so everything holding IEP data carries an explicit Deny for any principal
 * not on this list. Identity-based IAM policies cannot override the Deny.
 *
 * aws:PrincipalArn resolves assumed-role sessions to the ROLE ARN, so the
 * role/NAME-* patterns match Lambda/StepFunctions/custom-resource roles for
 * both environments' stacks.
 *
 * Recovery if the allowlist is ever wrong: account root, user/dhruv, or a
 * CDK redeploy (the cdk bootstrap roles are allowlisted) can always fix it.
 */
export function iepDataPrincipalAllowlist(accountId: string): string[] {
  return [
    // Account root — never deny root (lockout safety)
    `arn:aws:iam::${accountId}:root`,
    // Project owner
    `arn:aws:iam::${accountId}:user/dhruv`,
    // Application roles created by the prod and staging stacks
    `arn:aws:iam::${accountId}:role/AIEPStack-*`,
    `arn:aws:iam::${accountId}:role/AIEPStagingStack-*`,
    // CDK bootstrap roles (deploy, file publishing, CloudFormation execution)
    // used by the GitHub Actions deploys. Note: these are account-wide CDK
    // roles, so any CDK deployment in this account retains access.
    `arn:aws:iam::${accountId}:role/cdk-hnb659fds-*`,
  ];
}

/**
 * Explicit Deny for every principal outside the allowlist. AWS service
 * principals (e.g. S3 log delivery) are exempt — services acting on behalf
 * of a user still evaluate as that user's role and remain covered.
 */
export function createIepDataDenyStatement(
  accountId: string,
  actions: string[],
  resources: string[]
): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'DenyIepDataOutsideAllowlist',
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    actions,
    resources,
    conditions: {
      StringNotLike: {
        'aws:PrincipalArn': iepDataPrincipalAllowlist(accountId),
      },
      Bool: {
        'aws:PrincipalIsAWSService': 'false',
      },
    },
  });
}
