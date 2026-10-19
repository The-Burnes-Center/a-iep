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
    ListObjectVersionsCommand,
    DeleteObjectsCommand,
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

// Every version and delete marker goes out in DeleteObjects batches, so
// the deleted set is read from the batch inputs, not one call per key.
const deletedObjects = () => s3Mock.commandCalls(DeleteObjectsCommand)
    .flatMap((c) => c.args[0].input.Delete.Objects);

// The bucket is versioned, so the replace flow lists versions, not objects.
// A current object is a version with IsLatest.
const current = (...keys) => ({
    Versions: keys.map((Key) => ({ Key, VersionId: `v-${Key}`, IsLatest: true })),
});
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
    s3Mock.on(ListObjectVersionsCommand).resolves({});
    s3Mock.on(DeleteObjectsCommand).resolves({});
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

    test("replaces the child's existing documents before writing the new record", async () => {
        // Prefix-aware: the replace path sweeps three different prefixes (raw
        // upload, iep-data, iep-audio), so a mock that answers every prefix
        // with the same object would claim deletions that never happened.
        s3Mock.on(ListObjectVersionsCommand).resolves({});
        s3Mock.on(ListObjectVersionsCommand, { Prefix: `${USER}/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/` }).resolves(current(`${USER}/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/iep-old/old.pdf`));
        ddbMock.on(QueryCommand, { TableName: DOCUMENTS_TABLE }).resolves({
            Items: [
                { iepId: 'iep-old', childId: '3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b', userId: USER },
                // Same childId but someone else's record: must survive.
                { iepId: 'iep-foreign', childId: '3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b', userId: 'other-user' },
            ],
        });
        ddbMock.on(QueryCommand, { TableName: PROFILES_TABLE }).resolves({ Items: [] });

        const { status } = await call(GOOD_UPLOAD);
        expect(status).toBe(200);

        // Old S3 object removed
        expect(deletedObjects().map((o) => o.Key))
            .toEqual([`${USER}/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/iep-old/old.pdf`]);

        // Only the caller's own record deleted, and before the new Put
        const deletes = ddbMock.commandCalls(DeleteCommand);
        expect(deletes.map((c) => c.args[0].input.Key.iepId)).toEqual(['iep-old']);

        const ordered = ddbMock.calls().map((c) => c.args[0].constructor.name);
        expect(ordered.indexOf('DeleteCommand')).toBeLessThan(ordered.indexOf('PutCommand'));
    });

    // The bucket is versioned: a DeleteObject without a VersionId writes a
    // delete marker and the previous original stays retrievable by version id
    // for another 1 to 3 days. Every version and every marker must go, each by
    // its own id, and a key that only shares the prefix must not.
    test("deletes every version of the replaced original, not just the current one", async () => {
        const oldKey = `${USER}/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/iep-old/old.pdf`;
        ddbMock.on(QueryCommand).resolves({ Items: [] });
        s3Mock.on(ListObjectVersionsCommand, { Prefix: `${USER}/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/` }).resolves({
            Versions: [
                { Key: oldKey, VersionId: 'v-current', IsLatest: true },
                { Key: oldKey, VersionId: 'v-older', IsLatest: false },
            ],
            DeleteMarkers: [{ Key: oldKey, VersionId: 'm-1', IsLatest: false }],
        });

        expect((await call(GOOD_UPLOAD)).status).toBe(200);

        const deleted = deletedObjects();
        expect(deleted.map((d) => d.VersionId).sort()).toEqual(['m-1', 'v-current', 'v-older']);
        expect(deleted.every((d) => d.Key === oldKey)).toBe(true);
    });

    test('follows the version listing past its first page', async () => {
        const prefix = `${USER}/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/`;
        ddbMock.on(QueryCommand).resolves({ Items: [] });
        s3Mock.on(ListObjectVersionsCommand, { Prefix: prefix })
            .resolvesOnce({
                Versions: [{ Key: `${prefix}a/a.pdf`, VersionId: 'v1', IsLatest: true }],
                IsTruncated: true, NextKeyMarker: `${prefix}a/a.pdf`, NextVersionIdMarker: 'v1',
            })
            .resolves({ Versions: [{ Key: `${prefix}b/b.pdf`, VersionId: 'v2', IsLatest: true }] });

        expect((await call(GOOD_UPLOAD)).status).toBe(200);

        expect(deletedObjects().map((o) => o.VersionId)).toEqual(['v1', 'v2']);
        const second = s3Mock.commandCalls(ListObjectVersionsCommand)
            .map((c) => c.args[0].input).filter((i) => i.Prefix === prefix)[1];
        expect(second).toMatchObject({ KeyMarker: `${prefix}a/a.pdf`, VersionIdMarker: 'v1' });
    });

    // The raw upload's filename is typed by a parent and routinely names the
    // child. The replace flow used to log the whole key on every upload.
    test("never logs the replaced original's filename", async () => {
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        try {
            ddbMock.on(QueryCommand).resolves({ Items: [] });
            s3Mock.on(ListObjectVersionsCommand, { Prefix: `${USER}/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/` })
                .resolves(current(`${USER}/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/iep-old/Sofia Ejemplo IEP.pdf`));

            expect((await call(GOOD_UPLOAD)).status).toBe(200);

            const logged = log.mock.calls.flat().join('\n');
            expect(logged).not.toContain('Sofia');
            expect(logged).toContain(`${USER}/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/iep-old/...`);
        } finally {
            log.mockRestore();
        }
    });

    // Every upload replaces the child's previous IEP, so this is the most
    // travelled delete path in the app. It used to sweep only the raw-upload
    // prefix, stranding the previous document's redacted summary and cached
    // audio: 40 content and 18 audio directories in staging, 20 in prod, with
    // no row pointing at any of them.
    test('purges the replaced document\'s summary and cached audio', async () => {
        s3Mock.on(ListObjectVersionsCommand).resolves({});
        s3Mock.on(ListObjectVersionsCommand, { Prefix: 'iep-data/iep-old/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/' }).resolves(current('iep-data/iep-old/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/content.json'));
        s3Mock.on(ListObjectVersionsCommand, { Prefix: 'iep-audio/iep-old/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/' }).resolves(current('iep-audio/iep-old/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/en/summary-abc.mp3', 'iep-audio/iep-old/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/es/summary-def.mp3'));
        ddbMock.on(QueryCommand, { TableName: DOCUMENTS_TABLE }).resolves({
            Items: [{
                iepId: 'iep-old', childId: '3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b', userId: USER,
                contentS3Reference: { bucket: BUCKET, s3Key: 'iep-data/iep-old/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/content.json' },
            }],
        });
        ddbMock.on(QueryCommand, { TableName: PROFILES_TABLE }).resolves({ Items: [] });

        expect((await call(GOOD_UPLOAD)).status).toBe(200);

        const deletedKeys = deletedObjects().map((o) => o.Key);
        expect(deletedKeys).toContain('iep-data/iep-old/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/content.json');
        expect(deletedKeys).toContain('iep-audio/iep-old/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/en/summary-abc.mp3');
        expect(deletedKeys).toContain('iep-audio/iep-old/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/es/summary-def.mp3');
    });

    test('purges artifacts before deleting the row that points at them', async () => {
        // contentS3Reference is the only pointer to the summary object, so a
        // row deleted first leaves it unreachable in S3 forever. The two
        // deletes land on different mocks, so record a single interleaved
        // order log rather than comparing per-mock indexes.
        const order = [];
        s3Mock.on(ListObjectVersionsCommand).resolves({});
        s3Mock.on(ListObjectVersionsCommand, { Prefix: 'iep-data/iep-old/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/' }).resolves(current('iep-data/iep-old/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/content.json'));
        s3Mock.on(DeleteObjectsCommand).callsFake((input) => {
            for (const object of input.Delete.Objects) order.push(`s3:${object.Key}`);
            return {};
        });
        ddbMock.on(QueryCommand, { TableName: DOCUMENTS_TABLE }).resolves({
            Items: [{ iepId: 'iep-old', childId: '3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b', userId: USER }],
        });
        ddbMock.on(QueryCommand, { TableName: PROFILES_TABLE }).resolves({ Items: [] });
        ddbMock.on(DeleteCommand).callsFake((input) => {
            order.push(`row:${input.Key.iepId}`);
            return {};
        });

        await call(GOOD_UPLOAD);

        const contentAt = order.indexOf('s3:iep-data/iep-old/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/content.json');
        const rowAt = order.indexOf('row:iep-old');
        expect(contentAt).toBeGreaterThanOrEqual(0);
        expect(rowAt).toBeGreaterThanOrEqual(0);
        expect(contentAt).toBeLessThan(rowAt);
    });

    test('purges documents past the first query page', async () => {
        s3Mock.on(ListObjectVersionsCommand).resolves({});
        s3Mock.on(ListObjectVersionsCommand, { Prefix: 'iep-data/iep-page2/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/' }).resolves(current('iep-data/iep-page2/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/content.json'));
        ddbMock.on(QueryCommand, { TableName: DOCUMENTS_TABLE })
            .resolvesOnce({
                Items: [{ iepId: 'iep-page1', childId: '3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b', userId: USER }],
                LastEvaluatedKey: { iepId: 'iep-page1', childId: '3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b' },
            })
            .resolves({
                Items: [{ iepId: 'iep-page2', childId: '3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b', userId: USER }],
            });
        ddbMock.on(QueryCommand, { TableName: PROFILES_TABLE }).resolves({ Items: [] });

        expect((await call(GOOD_UPLOAD)).status).toBe(200);

        const deletedIepIds = ddbMock.commandCalls(DeleteCommand)
            .map((c) => c.args[0].input.Key.iepId);
        expect(deletedIepIds).toEqual(['iep-page1', 'iep-page2']);
        expect(deletedObjects().map((o) => o.Key))
            .toContain('iep-data/iep-page2/3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b/content.json');
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

describe('batched version deletes', () => {
    const CHILD_ID = '3f2b8a1e-6c4d-4e8f-9a1b-2c3d4e5f6a7b';

    test('a listing past 1000 entries goes out in DeleteObjects batches of at most 1000', async () => {
        const prefix = `${USER}/${CHILD_ID}/`;
        const versions = Array.from({ length: 1001 }, (_, i) => ({
            Key: `${prefix}d${i}/f.pdf`, VersionId: `v${i}`, IsLatest: false,
        }));
        s3Mock.on(ListObjectVersionsCommand, { Prefix: prefix }).resolves({ Versions: versions });

        expect((await call(GOOD_UPLOAD)).status).toBe(200);

        const batchSizes = s3Mock.commandCalls(DeleteObjectsCommand)
            .map((c) => c.args[0].input.Delete.Objects.length);
        expect(batchSizes).toEqual([1000, 1]);
        expect(deletedObjects().map((o) => o.VersionId).sort())
            .toEqual(versions.map((v) => v.VersionId).sort());
    });

    test('a version the store refuses to delete is not counted as deleted', async () => {
        const { deleteIepDocumentsForChild } = await import(
            '../../../lib/chatbot-api/functions/knowledge-management/upload-s3/utils/iep-document-utils.mjs');
        const oldKey = `${USER}/${CHILD_ID}/iep-old/old.pdf`;
        s3Mock.on(ListObjectVersionsCommand, { Prefix: `${USER}/${CHILD_ID}/` })
            .resolves(current(oldKey));
        // DeleteObjects reports per-key failures in a 200 body, not as a throw.
        s3Mock.on(DeleteObjectsCommand).resolves({
            Errors: [{ Key: oldKey, VersionId: 'v-current', Code: 'AccessDenied' }],
        });
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const result = await deleteIepDocumentsForChild(USER, CHILD_ID, BUCKET, DOCUMENTS_TABLE, PROFILES_TABLE);
            expect(result.s3ObjectsDeleted).toBe(0);
            expect(error).toHaveBeenCalled();
            const everything = [...error.mock.calls, ...log.mock.calls].flat().map(String).join('\n');
            expect(everything).toContain('AccessDenied');
            expect(everything).not.toContain('old.pdf');
        } finally {
            error.mockRestore();
            log.mockRestore();
        }
    });
});
