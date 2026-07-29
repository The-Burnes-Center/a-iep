/**
 * get-s3 lists a user's uploaded documents. The contract that matters is the
 * scoping: the listing prefix always comes from the JWT sub, so one user can
 * never enumerate another's files, and unauthenticated calls get 401.
 */
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const BUCKET = 'kb-bucket-test';
const USER = 'user-sub-1';

process.env.BUCKET = BUCKET;
process.env.AWS_REGION = 'us-east-1';

const s3Mock = mockClient(S3Client);

const { handler } = await import(
    '../../../lib/chatbot-api/functions/knowledge-management/get-s3/index.mjs');

const listEvent = (extra = {}, authed = true) => ({
    ...(authed ? { requestContext: { authorizer: { jwt: { claims: { sub: USER } } } } } : {}),
    ...extra,
});

beforeEach(() => {
    s3Mock.reset();
    s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [{ Key: `${USER}/child-1/iep-1/report.pdf` }],
        IsTruncated: false,
    });
});

test('unauthenticated calls are rejected', async () => {
    const response = await handler(listEvent({}, false));
    expect(response.statusCode).toBe(401);
    expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
});

test('always lists under the caller prefix', async () => {
    const response = await handler(listEvent());
    expect(response.statusCode).toBe(200);

    const input = s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input;
    expect(input.Bucket).toBe(BUCKET);
    expect(input.Prefix).toBe(`${USER}/`);
    expect(JSON.parse(response.body).Contents).toHaveLength(1);
});

test('continuation token is accepted from the event or the HTTP body', async () => {
    await handler(listEvent({ continuationToken: 'tok-direct' }));
    await handler(listEvent({ body: JSON.stringify({ continuationToken: 'tok-body' }) }));
    await handler(listEvent({ body: 'not json' }));

    const tokens = s3Mock.commandCalls(ListObjectsV2Command)
        .map((c) => c.args[0].input.ContinuationToken);
    expect(tokens).toEqual(['tok-direct', 'tok-body', undefined]);
});

test('an S3 failure is a 500', async () => {
    s3Mock.on(ListObjectsV2Command).rejects(new Error('S3 down'));
    const response = await handler(listEvent());
    expect(response.statusCode).toBe(500);
});
