/**
 * upload-s3 is the IEP upload API: it validates the request, replaces the
 * child's existing documents (one active IEP per child), writes the new
 * document record, and returns a presigned PUT URL. ES module, so this suite
 * runs under jest's vm-modules mode (see jest.config.js / `npm test`).
 *
 * The AWS SDK clients are intercepted with aws-sdk-client-mock (prototype-
 * level, so the handler's and iep-document-utils' own client instances are
 * both covered). getSignedUrl is the real presigner: it signs offline with
 * the fake env credentials, so assertions run against a genuine URL.
 */
import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import {
    S3Client,
    ListObjectsV2Command,
    DeleteObjectCommand,
    GetObjectCommand,
} from '@aws-sdk/client-s3';
import {
    DynamoDBDocumentClient,
    PutCommand,
    QueryCommand,
    DeleteCommand,
} from '@aws-sdk/lib-dynamodb';

const BUCKET = 'kb-bucket-test';
const DOCUMENTS_TABLE = 'documents-test';
const PROFILES_TABLE = 'profiles-test';
const USER = 'user-sub-1';

process.env.BUCKET = BUCKET;
process.env.IEP_DOCUMENTS_TABLE = DOCUMENTS_TABLE;
process.env.USER_PROFILES_TABLE = PROFILES_TABLE;
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
    childId: 'child-1',
};

const call = async (body) => {
    const response = await handler(uploadEvent(body));
    return { status: response.statusCode, body: JSON.parse(response.body) };
};

beforeEach(() => {
    s3Mock.reset();
    ddbMock.reset();
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});
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
});

describe('upload', () => {
    test('returns a presigned PUT URL under the caller-scoped key layout', async () => {
        const { status, body } = await call(GOOD_UPLOAD);
        expect(status).toBe(200);

        expect(body.iepId).toMatch(/^iep-/);
        // Key layout {userId}/{childId}/{iepId}/{fileName}: the JWT sub, not
        // anything client-supplied, is the ownership prefix.
        expect(body.documentUrl).toBe(`s3://${BUCKET}/${USER}/child-1/${body.iepId}/report.pdf`);

        const url = new URL(body.signedUrl);
        expect(url.hostname).toContain(BUCKET);
        expect(url.pathname).toBe(`/${USER}/child-1/${body.iepId}/report.pdf`);
        expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
        expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    });

    test('writes the document record for the authenticated user', async () => {
        const { body } = await call(GOOD_UPLOAD);

        const puts = ddbMock.commandCalls(PutCommand);
        expect(puts).toHaveLength(1);
        const { TableName, Item } = puts[0].args[0].input;
        expect(TableName).toBe(DOCUMENTS_TABLE);
        expect(Item.iepId).toBe(body.iepId);
        expect(Item.childId).toBe('child-1');
        expect(Item.userId).toBe(USER);
        expect(Item.documentUrl).toBe(body.documentUrl);
        expect(Item.summaries).toEqual({});
        expect(typeof Item.createdAt).toBe('number');
    });

    test("replaces the child's existing documents before writing the new record", async () => {
        s3Mock.on(ListObjectsV2Command).resolves({
            Contents: [{ Key: `${USER}/child-1/iep-old/old.pdf` }],
        });
        ddbMock.on(QueryCommand, { TableName: DOCUMENTS_TABLE }).resolves({
            Items: [
                { iepId: 'iep-old', childId: 'child-1', userId: USER },
                // Same childId but someone else's record: must survive.
                { iepId: 'iep-foreign', childId: 'child-1', userId: 'other-user' },
            ],
        });
        ddbMock.on(QueryCommand, { TableName: PROFILES_TABLE }).resolves({ Items: [] });

        const { status } = await call(GOOD_UPLOAD);
        expect(status).toBe(200);

        // Old S3 object removed
        const s3Deletes = s3Mock.commandCalls(DeleteObjectCommand);
        expect(s3Deletes.map((c) => c.args[0].input.Key))
            .toEqual([`${USER}/child-1/iep-old/old.pdf`]);

        // Only the caller's own record deleted, and before the new Put
        const deletes = ddbMock.commandCalls(DeleteCommand);
        expect(deletes.map((c) => c.args[0].input.Key.iepId)).toEqual(['iep-old']);

        const ordered = ddbMock.calls().map((c) => c.args[0].constructor.name);
        expect(ordered.indexOf('DeleteCommand')).toBeLessThan(ordered.indexOf('PutCommand'));
    });

    test('a failed record write is a 500, not a silent success', async () => {
        ddbMock.on(PutCommand).rejects(new Error('DynamoDB down'));
        const { status, body } = await call(GOOD_UPLOAD);
        expect(status).toBe(500);
        expect(body.error).toContain('Failed');
    });
});

describe('download', () => {
    test('presigns GET for keys under the caller prefix only', async () => {
        const key = `${USER}/child-1/iep-1/report.pdf`;
        const { status, body } = await call({ fileName: key, operation: 'download', childId: 'child-1' });
        expect(status).toBe(200);
        expect(new URL(body.signedUrl).pathname).toBe(`/${key}`);
    });

    test.each([
        ['other-user/child-1/iep-1/report.pdf'],
        [`${USER}/../other-user/report.pdf`],
    ])('foreign or traversal key -> 403 (%s)', async (key) => {
        const { status } = await call({ fileName: key, operation: 'download', childId: 'child-1' });
        expect(status).toBe(403);
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
                fileName: `${USER}/child-1/iep-1/report.pdf`,
                operation: 'download',
                childId: 'child-1',
            });
            expect(status).toBe(500);
            expect(body.error).toBe('Failed to generate signed URL');
        } finally {
            spy.mockRestore();
        }
    });
});
