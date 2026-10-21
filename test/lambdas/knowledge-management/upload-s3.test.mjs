/**
 * upload-s3 is the IEP upload API: it validates the request, writes the new
 * document record, and returns a presigned PUT URL. It never deletes anything:
 * replacing a child's IEP is the pipeline's job, once the new document has
 * finished (ddb-service purge_replaced_documents, tested in
 * test/python/test_replaced_documents.py). ES module, so this suite runs under
 * jest's vm-modules mode (see jest.config.js / `npm test`).
 *
 * The AWS SDK clients are intercepted with aws-sdk-client-mock (prototype-
 * level, so the handler's own client instances are covered). getSignedUrl is
 * the real presigner: it signs offline with the fake env credentials, so
 * assertions run against a genuine URL.
 */
import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const BUCKET = 'kb-bucket-test';
const DOCUMENTS_TABLE = 'documents-test';
const USER = 'user-sub-1';

process.env.BUCKET = BUCKET;
process.env.IEP_DOCUMENTS_TABLE = DOCUMENTS_TABLE;
process.env.AWS_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'testing';
process.env.AWS_SECRET_ACCESS_KEY = 'testing';

const s3Mock = mockClient(S3Client);

const ddbMock = mockClient(DynamoDBDocumentClient);

// Import AFTER env + mocks: the module builds its clients and reads the
// bucket/table names at load time.
const { handler } = await import(
    '../../../lib/chatbot-api/functions/knowledge-management/upload-s3/index.mjs');

const uploadEvent = (body, user = USER) => ({
    body: JSON.stringify(body),
    requestContext: { authorizer: { jwt: { claims: { sub: user } } } },
});

const GOOD_UPLOAD = {
    fileName: 'report.pdf',
    fileType: 'application/pdf',
    operation: 'upload',
    childId: '3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b',
};

const call = async (body) => {
    const response = await handler(uploadEvent(body));
    return { status: response.statusCode, body: JSON.parse(response.body) };
};

beforeEach(() => {
    s3Mock.reset();
    ddbMock.reset();
    ddbMock.on(PutCommand).resolves({});
});

describe('request validation', () => {
    test.each([
        [{ ...GOOD_UPLOAD, fileName: undefined }],
        [{ ...GOOD_UPLOAD, operation: undefined }],
        [{ ...GOOD_UPLOAD, childId: undefined }],
    ])('missing required field -> 400 (%#)', async (body) => {
        const { status, body: response } = await call(body);
        expect(status).toBe(400);
        expect(response.message).toContain('required');
    });

    test('upload without fileType -> 400', async () => {
        const { status, body: response } = await call({ ...GOOD_UPLOAD, fileType: undefined });
        expect(status).toBe(400);
        expect(response.message).toContain('fileType');
    });

    // The upload fileName is the final S3 key segment: separators or '..'
    // segments would mint keys the download branch's ownership guard can
    // never serve, so they are rejected before any AWS work happens.
    test.each([
        ['nested/report.pdf'],
        ['nested\\report.pdf'],
        ['..'],
        ['../report.pdf'],
    ])('upload fileName with a separator or dot-dot segment -> 400 (%s)', async (fileName) => {
        const { status, body: response } = await call({ ...GOOD_UPLOAD, fileName });
        expect(status).toBe(400);
        expect(response.message).toContain('fileName');
        expect(s3Mock.calls()).toHaveLength(0);
        expect(ddbMock.calls()).toHaveLength(0);
    });

    test('dots inside a name are not traversal: report..pdf still uploads', async () => {
        const { status } = await call({ ...GOOD_UPLOAD, fileName: 'report..pdf' });
        expect(status).toBe(200);
    });

    // Every one of these three rejections used to be silent, so "the upload
    // button does nothing" was undiagnosable: nothing in CloudWatch said a
    // request had arrived and been turned away, or why.
    //
    // The filename must stay OUT of the log line. It is the parent's own
    // filename and routinely carries the child's name, and this repo does not
    // log document content or anything derived from it.
    describe.each([
        ['missing field', { ...GOOD_UPLOAD, childId: undefined }, /childId/],
        ['missing fileType', { ...GOOD_UPLOAD, fileType: undefined }, /fileType/],
        ['path separator', { ...GOOD_UPLOAD, fileName: 'Nadia-IEP/../secret.pdf' }, /separator/],
    ])('a %s rejection', (_label, requestBody, reason) => {
        test('says why, without naming the file', async () => {
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
            try {
                const { status } = await call(requestBody);
                expect(status).toBe(400);

                expect(warn).toHaveBeenCalledTimes(1);
                const line = warn.mock.calls.flat().join(' ');
                expect(line).toMatch(reason);
                expect(line).not.toContain('Nadia');
                expect(line).not.toContain('.pdf');
            } finally {
                warn.mockRestore();
            }
        });
    });
});

describe('upload', () => {
    test('returns a presigned PUT URL under the caller-scoped key layout', async () => {
        const { status, body } = await call(GOOD_UPLOAD);
        expect(status).toBe(200);

        expect(body.iepId).toMatch(/^iep-/);

        const url = new URL(body.signedUrl);
        expect(url.hostname).toContain(BUCKET);
        expect(url.pathname).toBe(`/${USER}/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/${body.iepId}/report.pdf`);
        expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
        expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    });

    // The response used to carry documentUrl, i.e. `s3://{BUCKET}/{key}`, so
    // every upload handed the browser the physical name of the bucket
    // holding other families' IEPs. Nothing read it: the browser needs the
    // presigned URL to PUT to and the iepId to poll on.
    //
    // The presigned URL necessarily contains the bucket (it is the host it
    // PUTs to), so this asserts the shape of the response rather than the
    // absence of the string.
    test('the response does not hand the client the bucket name', async () => {
        const { body } = await call(GOOD_UPLOAD);

        expect(Object.keys(body).sort()).toEqual(['iepId', 'signedUrl']);
        expect(body.documentUrl).toBeUndefined();
    });

    test('writes the document record for the authenticated user', async () => {
        const { body } = await call(GOOD_UPLOAD);

        const puts = ddbMock.commandCalls(PutCommand);
        expect(puts).toHaveLength(1);
        const { TableName, Item } = puts[0].args[0].input;
        expect(TableName).toBe(DOCUMENTS_TABLE);
        expect(Item.iepId).toBe(body.iepId);
        expect(Item.childId).toBe('3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b');
        expect(Item.userId).toBe(USER);
        expect(Item.summaries).toEqual({});
        expect(typeof Item.createdAt).toBe('number');
    });

    // documentUrl left the RESPONSE, not the row. Three things parse the
    // stored value as `s3://bucket/key`: ddb-service's
    // _cleanup_unredacted_artifacts, which is what purges the unredacted
    // original; user-profile-handler; and scripts/purge-orphaned-artifacts.py.
    // Dropping the persisted field would leave unredacted uploads in S3, so
    // the exact stored form is pinned here, where the key layout is also
    // pinned: {userId}/{childId}/{iepId}/{fileName}, prefixed by the JWT sub
    // rather than by anything the client sent.
    test('the persisted row still carries the s3:// URL the purge parses', async () => {
        const { body } = await call(GOOD_UPLOAD);
        const { Item } = ddbMock.commandCalls(PutCommand)[0].args[0].input;

        expect(Item.documentUrl)
            .toBe(`s3://${BUCKET}/${USER}/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/${body.iepId}/report.pdf`);

        // The parser in ddb-service is `url[len('s3://'):].partition('/')`.
        const [bucket, ...keyParts] = Item.documentUrl.slice('s3://'.length).split('/');
        expect(bucket).toBe(BUCKET);
        expect(keyParts.join('/')).toBe(`${USER}/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/${body.iepId}/report.pdf`);
    });

    // The row is written before this handler knows the browser's presigned
    // PUT below actually lands in S3. Without an explicit starting status, a
    // dropped upload (closed tab, network drop) leaves a row with no status
    // at all and nothing ever moves it again — see ddb-service's
    // expire_stale_pending_uploads, which is what reclaims rows stuck here.
    test('the new record starts at PENDING_UPLOAD, not PROCESSING', async () => {
        await call(GOOD_UPLOAD);
        const { Item } = ddbMock.commandCalls(PutCommand)[0].args[0].input;
        expect(Item.status).toBe('PENDING_UPLOAD');
    });

    // The product rule: a parent who replaces their child's IEP keeps the old
    // one until the new one has finished processing. Asking for an upload URL
    // is not that moment: the file has not been sent, and may never be. This
    // handler used to delete the child's previous document right here, so a
    // cancelled upload, a dropped connection or a failed run left the family
    // with no IEP. Mutation-checked: putting a delete (or a listing, which
    // only a delete needs) back anywhere in handleUpload fails these.
    describe('replacing an IEP', () => {
        const touchedStorage = () => [
            ...s3Mock.calls().map((c) => c.args[0].constructor.name),
            ...ddbMock.calls().map((c) => c.args[0].constructor.name),
        ];

        test('requesting an upload URL deletes nothing, even when the child already has an IEP', async () => {
            // Whatever the table holds for this child, the handler must not even
            // look: any read of the child's documents is the first half of a delete.
            ddbMock.onAnyCommand().resolves({
                Items: [{ iepId: 'iep-old', childId: GOOD_UPLOAD.childId, userId: USER, status: 'PROCESSED' }],
            });

            const { status } = await call(GOOD_UPLOAD);

            expect(status).toBe(200);
            expect(touchedStorage()).toEqual(['PutCommand']);
        });

        test('the only write is the new PENDING_UPLOAD row', async () => {
            const { body } = await call(GOOD_UPLOAD);

            const puts = ddbMock.commandCalls(PutCommand);
            expect(puts).toHaveLength(1);
            expect(puts[0].args[0].input.Item.iepId).toBe(body.iepId);
            expect(puts[0].args[0].input.Item.status).toBe('PENDING_UPLOAD');
            expect(s3Mock.calls()).toHaveLength(0);
        });

        test('a failed record write still deletes nothing', async () => {
            ddbMock.on(PutCommand).rejects(new Error('DynamoDB down'));

            const { status } = await call(GOOD_UPLOAD);

            expect(status).toBe(503);
            expect(touchedStorage()).toEqual(['PutCommand']);
            expect(s3Mock.calls()).toHaveLength(0);
        });

        test('an upload that is requested and never sent leaves nothing deleted', async () => {
            // The presigned PUT is never used: no S3 call of any kind reaches
            // the bucket from this handler, so the old IEP cannot have moved.
            await call(GOOD_UPLOAD);
            await call({ ...GOOD_UPLOAD, fileName: 'second-attempt.pdf' });

            expect(s3Mock.calls()).toHaveLength(0);
            expect(ddbMock.commandCalls(PutCommand)).toHaveLength(2);
            expect(touchedStorage().every((name) => name === 'PutCommand')).toBe(true);
        });
    });

    test('a failed record write is a 503, not a silent success', async () => {
        ddbMock.on(PutCommand).rejects(new Error('DynamoDB down'));
        const { status, body } = await call(GOOD_UPLOAD);
        expect(status).toBe(503);
        expect(body.error).toContain('Failed');
    });
});

describe('download', () => {
    test('presigns GET for keys under the caller prefix only', async () => {
        const key = `${USER}/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/iep-1/report.pdf`;
        const { status, body } = await call({ fileName: key, operation: 'download', childId: '3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b' });
        expect(status).toBe(200);
        expect(new URL(body.signedUrl).pathname).toBe(`/${key}`);
    });

    // Not-owned is 404, the same answer as a key that does not exist, so the
    // response never reveals whose keys exist.
    test.each([
        ['other-user/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/iep-1/report.pdf'],
        [`${USER}/../other-user/report.pdf`],
    ])('foreign or traversal key -> 404 (%s)', async (key) => {
        const { status } = await call({ fileName: key, operation: 'download', childId: '3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b' });
        expect(status).toBe(404);
    });

    test('a presigning failure is a 500 with the stock error body', async () => {
        // getSignedUrl signs offline through command.resolveMiddleware and
        // never touches Client.send, so the s3Mock cannot reject it; stub the
        // command's middleware resolution instead (same prototype-level idea
        // as mockClient).
        const spy = jest.spyOn(GetObjectCommand.prototype, 'resolveMiddleware')
            .mockReturnValue(() => Promise.reject(new Error('presign failed')));
        try {
            const { status, body } = await call({
                fileName: `${USER}/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/iep-1/report.pdf`,
                operation: 'download',
                childId: '3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b',
            });
            expect(status).toBe(500);
            expect(body.error).toBe('Failed to generate signed URL');
        } finally {
            spy.mockRestore();
        }
    });
});

// Request hardening: every rejection is a 4xx with its reason logged, nothing
// touches AWS, and the errors that are not the caller's fault are generic.
describe('request hardening', () => {
    const quietWarn = () => jest.spyOn(console, 'warn').mockImplementation(() => {});

    test.each([
        ['an array', '[1,2]'],
        ['a string', '"report.pdf"'],
        ['null', 'null'],
        ['invalid JSON', '{not json'],
        ['absent', undefined],
    ])('a body that is %s -> 400 with the reason logged, and no AWS call', async (_label, raw) => {
        const warn = quietWarn();
        try {
            const response = await handler({
                body: raw,
                requestContext: { authorizer: { jwt: { claims: { sub: USER } } } },
            });
            expect(response.statusCode).toBe(400);
            expect(warn.mock.calls.flat().join(' ')).toMatch(/JSON object/);
            expect(s3Mock.calls()).toHaveLength(0);
            expect(ddbMock.calls()).toHaveLength(0);
        } finally {
            warn.mockRestore();
        }
    });

    test.each([
        ['a non-UUID id', 'child-1'],
        ['a traversal id', '../../other'],
        ['a truncated UUID', '3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7'],
    ])('childId is %s -> 400, and nothing is written or signed', async (_label, childId) => {
        const warn = quietWarn();
        try {
            const { status } = await call({ ...GOOD_UPLOAD, childId });
            expect(status).toBe(400);
            expect(warn.mock.calls.flat().join(' ')).toMatch(/not a UUID/);
            expect(s3Mock.calls()).toHaveLength(0);
            expect(ddbMock.calls()).toHaveLength(0);
        } finally {
            warn.mockRestore();
        }
    });

    test('an operation outside upload and download -> 400, and the value stays out of the log', async () => {
        const warn = quietWarn();
        try {
            const { status } = await call({ ...GOOD_UPLOAD, operation: 'delete-everything' });
            expect(status).toBe(400);
            expect(warn.mock.calls.flat().join(' ')).not.toContain('delete-everything');
            expect(s3Mock.calls()).toHaveLength(0);
        } finally {
            warn.mockRestore();
        }
    });

    test('a request with no JWT subject -> 401, not an unhandled throw', async () => {
        const warn = quietWarn();
        try {
            const response = await handler({ body: JSON.stringify(GOOD_UPLOAD), requestContext: {} });
            expect(response.statusCode).toBe(401);
        } finally {
            warn.mockRestore();
        }
    });

    test('every response, success or refusal, says no-store', async () => {
        const warn = quietWarn();
        try {
            const ok = await handler(uploadEvent(GOOD_UPLOAD));
            const refused = await handler(uploadEvent({ ...GOOD_UPLOAD, childId: 'child-1' }));
            expect(ok.statusCode).toBe(200);
            expect(refused.statusCode).toBe(400);
            expect(ok.headers['Cache-Control']).toBe('no-store');
            expect(refused.headers['Cache-Control']).toBe('no-store');
        } finally {
            warn.mockRestore();
        }
    });

    test('a DynamoDB throttle is a generic 503: no table name, no AWS error text', async () => {
        const error = Object.assign(
            new Error(`ProvisionedThroughputExceededException on ${DOCUMENTS_TABLE}`),
            { name: 'ProvisionedThroughputExceededException' },
        );
        ddbMock.on(PutCommand).rejects(error);
        const { status, body } = await call(GOOD_UPLOAD);
        expect(status).toBe(503);
        expect(JSON.stringify(body)).not.toContain(DOCUMENTS_TABLE);
        expect(JSON.stringify(body)).not.toContain('Throughput');
    });

    test('a download refused as not-owned is logged without the key or its filename', async () => {
        const warn = quietWarn();
        try {
            const { status } = await call({
                fileName: 'other-user/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/iep-1/Sofia Ejemplo IEP.pdf',
                operation: 'download',
                childId: '3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b',
            });
            const line = warn.mock.calls.flat().join(' ');
            expect(status).toBe(404);
            expect(line).not.toContain('Sofia');
            expect(line).not.toContain('.pdf');
            expect(line).not.toContain('other-user');
        } finally {
            warn.mockRestore();
        }
    });
});
