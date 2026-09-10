import { PolicyStatement, Effect, ArnPrincipal } from 'aws-cdk-lib/aws-iam';
import { Bucket } from 'aws-cdk-lib/aws-s3';

export interface BucketPolicyProps {
  bucket: Bucket;
  allowedUsers: string[];
}

/**
 * Add the owner-access and TLS statements to a bucket's own policy.
 *
 * **Statements, not a BucketPolicy resource, and that distinction is the
 * whole point of this function.** S3 allows exactly ONE policy document per
 * bucket, so two `AWS::S3::BucketPolicy` resources naming the same bucket are
 * not additive: whichever deploys last overwrites the other, completely.
 *
 * This used to be `new BucketPolicy(scope, id, ...)`, and the scope it was
 * handed was `S3BucketStack` while the bucket itself was created in the
 * PARENT stack. Because S3BucketStack extends cdk.Stack, that emitted a
 * second, separate CloudFormation stack carrying a second policy for the live
 * IEP bucket, referencing it by hard-coded name. CI only ever deploys the
 * named parent stack, so the two never met; `cdk deploy --all`, which
 * README.md documents, would have applied the sibling's two-statement policy
 * over the real four-statement one and silently dropped both
 * DenyIepDataOutsideAllowlist -- the only thing keeping other principals in
 * this shared account away from families' documents -- and the TLS 1.2 floor.
 * CloudFormation would have reported success.
 *
 * That is the 2026-06-22 bucket rename in a different costume: a routine
 * documented command, a silent security downgrade, a green deploy. Going
 * through addToResourcePolicy means every statement lands in the single
 * policy CDK maintains for the bucket, in the bucket's own stack, and there
 * is no second resource for anything to overwrite.
 */
export function addBucketPolicyStatements(props: BucketPolicyProps): void {
  if (props.allowedUsers.length === 0) {
    return;
  }

  const resources = [props.bucket.bucketArn, `${props.bucket.bucketArn}/*`];

  props.bucket.addToResourcePolicy(new PolicyStatement({
    effect: Effect.ALLOW,
    principals: props.allowedUsers.map((user) => new ArnPrincipal(user)),
    actions: [
      's3:GetObject',
      's3:PutObject',
      's3:DeleteObject',
      's3:ListBucket',
      's3:GetBucketLocation',
    ],
    resources,
  }));

  props.bucket.addToResourcePolicy(new PolicyStatement({
    effect: Effect.DENY,
    principals: [new ArnPrincipal('*')],
    actions: ['s3:*'],
    resources,
    conditions: {
      Bool: { 'aws:SecureTransport': 'false' },
    },
  }));
}
