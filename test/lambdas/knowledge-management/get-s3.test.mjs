/**
 * get-s3 lists a user's uploaded documents. The contract that matters is the
 * scoping: the listing prefix always comes from the JWT sub, so one user can
 * never enumerate another's files, and unauthenticated calls get 401.
 *
 * The second contract is what comes BACK. This handler used to
 * JSON.stringify the whole ListObjectsV2 output, which carries `Name` (the
 * bucket), `Prefix`, and a `$metadata` block with the request id, extended
 * request id and HTTP status. None of that is anything a browser needs, and
 * the bucket name is the one piece of infrastructure naming a client should
 * never learn. The response is now assembled field by field, and the tests
 * below assert the leak is gone rather than that the listing works.
 */
import { jest } from '@jest/globals';
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

// What the SDK really hands back, not a trimmed stand-in: $metadata, Name
// and Prefix are always present on a ListObjectsV2 response, and a fixture
// that omitted them would let the leak back in without failing anything.
const S3_RESPONSE = {
    $metadata: {
        httpStatusCode: 200,
        requestId: 'AAAA1111BBBB2222',
        extendedRequestId: 'ext/REQUEST/ID/that/should/never/reach/a/client',
        attempts: 1,
        totalRetryDelay: 0,
    },
    Name: BUCKET,
    Prefix: `${USER}/`,
    KeyCount: 1,
    MaxKeys: 1000,
    IsTruncated: false,
    Contents: [{
        Key: `${USER}/child-1/iep-1/report.pdf`,
        Size: 12345,
        LastModified: new Date('2026-01-01T00:00:00Z'),
        ETag: '"deadbeef"',
        StorageClass: 'STANDARD',
    }],
};

beforeEach(() => {
    s3Mock.reset();
    s3Mock.on(ListObjectsV2Command).resolves(S3_RESPONSE);
});

test('unauthenticated calls are rejected', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
        const response = await handler(listEvent({}, false));
        expect(response.statusCode).toBe(401);
        expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
        // A silent 4xx is undiagnosable: this one can only happen if the
        // route lost its JWT authorizer, and nothing else would say so.
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toMatch(/no JWT sub/i);
    } finally {
        warn.mockRestore();
    }
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
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
        const response = await handler(listEvent());
        expect(response.statusCode).toBe(500);
        // Generic to the caller, detailed in CloudWatch.
        expect(JSON.parse(response.body).message).not.toContain('S3 down');
        expect(error).toHaveBeenCalled();
    } finally {
        error.mockRestore();
    }
});

describe('what comes back to the browser', () => {
    // The bucket name is the whole point of this pin. The listing response
    // used to be the raw SDK output, so `Name` handed every caller the
    // physical name of the bucket holding other families' IEPs.
    test('the response never carries the bucket name, prefix or request ids', async () => {
        const response = await handler(listEvent());
        expect(response.statusCode).toBe(200);

        // Substring, not key lookup: it must not appear ANYWHERE in the body,
        // including nested inside an object a future change adds back.
        expect(response.body).not.toContain(BUCKET);
        expect(response.body).not.toContain('AAAA1111BBBB2222');
        expect(response.body).not.toContain('ext/REQUEST/ID');

        const body = JSON.parse(response.body);
        expect(body.$metadata).toBeUndefined();
        expect(body.Name).toBeUndefined();
        expect(body.Prefix).toBeUndefined();
    });

    // The caller's own key prefix IS their own sub, so keys are not a leak;
    // dropping them would break the endpoint instead of securing it.
    test('it still returns the caller\'s own object listing', async () => {
        const body = JSON.parse((await handler(listEvent())).body);

        expect(body.Contents).toEqual([{
            Key: `${USER}/child-1/iep-1/report.pdf`,
            Size: 12345,
            LastModified: '2026-01-01T00:00:00.000Z',
        }]);
        expect(body.IsTruncated).toBe(false);
    });

    test('pagination survives the trim', async () => {
        s3Mock.on(ListObjectsV2Command).resolves({
            ...S3_RESPONSE,
            IsTruncated: true,
            NextContinuationToken: 'next-page',
        });
        const body = JSON.parse((await handler(listEvent())).body);

        expect(body.IsTruncated).toBe(true);
        expect(body.NextContinuationToken).toBe('next-page');
    });

    // An empty prefix is the normal state for a parent who has not uploaded
    // yet: S3 omits Contents entirely, and the handler must not throw on it.
    test('a listing with no objects is an empty array, not a crash', async () => {
        s3Mock.on(ListObjectsV2Command).resolves({
            $metadata: S3_RESPONSE.$metadata,
            Name: BUCKET,
            Prefix: `${USER}/`,
            IsTruncated: false,
        });
        const response = await handler(listEvent());

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body).Contents).toEqual([]);
    });
});
