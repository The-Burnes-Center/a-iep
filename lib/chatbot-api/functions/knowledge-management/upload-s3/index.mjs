// Import necessary modules from AWS SDK for S3 interaction
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
// Import the shared utility for IEP document deletion
import { deleteIepDocumentsForChild } from "./utils/iep-document-utils.mjs";

const URL_EXPIRATION_SECONDS = 300;
const BUCKET = process.env.BUCKET;
const IEP_DOCUMENTS_TABLE = process.env.IEP_DOCUMENTS_TABLE;
const USER_PROFILES_TABLE = process.env.USER_PROFILES_TABLE || "UserProfilesTable";

// childId is minted as a random UUID v4 by user-profile-handler (uuid.uuid4()).
const CHILD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATIONS = ['upload', 'download'];

const RESPONSE_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });

const respond = (statusCode, body) => ({
  statusCode,
  headers: RESPONSE_HEADERS,
  body: JSON.stringify(body),
});

// Every 4xx says why in the log. The reason is what makes "the upload button
// does nothing" diagnosable, so it never carries a filename or a child's id.
const reject = (statusCode, message, reason) => {
  console.warn(`Rejected upload request (${statusCode}): ${reason}`);
  return respond(statusCode, { message });
};

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseBody = (event) => {
  try {
    const parsed = JSON.parse(event.body);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

// Returns a { status, message, reason } rejection, or null when the request
// is well formed.
const validateRequest = (body) => {
  const missing = ['fileName', 'operation', 'childId'].filter((field) => !body[field]);
  if (missing.length > 0) {
    return {
      status: 400,
      message: 'fileName, operation, and childId are required',
      reason: `missing required field(s) ${missing.join(', ')}`,
    };
  }
  if (typeof body.fileName !== 'string' || typeof body.childId !== 'string' || typeof body.operation !== 'string') {
    return {
      status: 400,
      message: 'fileName, operation, and childId must be strings',
      reason: 'a required field is not a string',
    };
  }
  if (!OPERATIONS.includes(body.operation)) {
    return { status: 400, message: 'operation must be upload or download', reason: 'unsupported operation' };
  }
  if (!CHILD_ID_PATTERN.test(body.childId)) {
    return { status: 400, message: 'childId must be a UUID', reason: 'childId is not a UUID' };
  }
  return null;
};

// Main Lambda entry point
export const handler = async (event) => {
  const userId = event?.requestContext?.authorizer?.jwt?.claims?.sub;
  if (!userId) {
    return reject(401, 'Unauthorized', 'no JWT sub claim on the request');
  }

  const body = parseBody(event);
  if (!body) {
    return reject(400, 'Request body must be a JSON object', 'body is not a JSON object');
  }

  const invalid = validateRequest(body);
  if (invalid) {
    return reject(invalid.status, invalid.message, invalid.reason);
  }

  if (!BUCKET) {
    console.error('Server misconfigured: BUCKET is not set');
    return respond(500, { error: 'Server configuration error' });
  }

  if (body.operation === 'upload') {
    return handleUpload(body, userId);
  }
  return handleDownload(body, userId);
};

// Helper function to delete existing IEP documents for a child
const deleteExistingDocuments = async (childId, userId) => {
  try {
    console.log(`Deleting existing IEP documents for childId: ${childId} and userId: ${userId}`);

    // Use the shared utility to delete all IEP-related data directly
    const result = await deleteIepDocumentsForChild(
      userId,
      childId,
      BUCKET,
      IEP_DOCUMENTS_TABLE,
      USER_PROFILES_TABLE
    );

    console.log(`Deletion results: S3 objects deleted: ${result.s3ObjectsDeleted}, ` +
                `Documents deleted: ${result.documentsDeleted}, ` +
                `Profile updated: ${result.profileUpdated}`);

  } catch (error) {
    console.error('Error deleting existing documents:', error);
    // Continue execution even if deletion fails
  }
};

const handleUpload = async (body, userId) => {
  if (!body.fileType || typeof body.fileType !== 'string') {
    return reject(400, 'fileType is required for upload', 'fileType missing or not a string for upload');
  }

  // The upload fileName becomes the final segment of the S3 key
  // (`{userId}/{childId}/{iepId}/{fileName}`). Path separators or '..'
  // segments stay under the caller's own prefix (no cross-user risk) but
  // mint keys the download branch's ownership guard below can never serve,
  // so reject them up front.
  const nameSegments = body.fileName.split(/[/\\]/);
  if (nameSegments.length > 1 || nameSegments.includes('..')) {
    // The filename itself stays out of the log: it is the parent's own
    // and can carry a child's name. The user id is enough to find the
    // request, and the reason is what makes it diagnosable.
    return reject(400, 'fileName must not contain path separators or ".." segments',
      `fileName contains a path separator or ".." segment (user ${userId})`);
  }

  if (!IEP_DOCUMENTS_TABLE) {
    console.error('Server misconfigured: IEP_DOCUMENTS_TABLE is not set');
    return respond(500, { error: 'Server configuration error' });
  }

  // Generate unique IEP document ID
  const iepId = `iep-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  const s3Key = `${userId}/${body.childId}/${iepId}/${body.fileName}`;

  let signedUrl;
  try {
    signedUrl = await getSignedUrl(s3, new PutObjectCommand({
      Bucket: BUCKET,
      Key: s3Key,
      ContentType: body.fileType,
    }), { expiresIn: URL_EXPIRATION_SECONDS });
  } catch (error) {
    // Presigning signs locally, so a failure here is a server fault, not an AWS outage.
    console.error('Failed to presign upload URL:', error?.name ?? 'unknown error');
    return respond(500, { error: 'Failed to generate signed URL or save document record' });
  }

  // Create document record in DynamoDB. This happens before the browser's
  // presigned PUT below is known to succeed, so status starts at
  // PENDING_UPLOAD rather than PROCESSING: if the PUT never lands (closed
  // tab, dropped network, cancelled request), no S3 event ever fires the
  // orchestrator, and nothing in the pipeline will move this row again.
  // The pending-upload sweep (ddb-service's expire_stale_pending_uploads,
  // scheduled in functions.ts) is what fails it closed instead of leaving
  // it stuck forever.
  const timestamp = Math.floor(Date.now() / 1000);
  const documentRecord = {
    iepId: iepId,
    childId: body.childId,
    userId: userId,
    documentUrl: `s3://${BUCKET}/${s3Key}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: 'PENDING_UPLOAD',
    summaries: {}
  };

  // TODO(product): the replaced document is deleted here, before the new
  // record is written and before the new upload has succeeded. If the PUT
  // never lands, the child is left with no IEP until a new upload. Moving
  // this after the upload is a pending product decision, so the order is
  // deliberately unchanged.
  await deleteExistingDocuments(body.childId, userId);

  try {
    await ddb.send(new PutCommand({
      TableName: IEP_DOCUMENTS_TABLE,
      Item: documentRecord
    }));
  } catch (error) {
    console.error('Failed to write IEP document record:', error?.name ?? 'unknown error');
    return respond(503, { error: 'Failed to save document record, please try again' });
  }

  // documentUrl is deliberately NOT returned. It is `s3://{BUCKET}/{key}`,
  // so returning it hands every client the bucket name, and no caller
  // reads it: the browser needs the presigned URL to PUT to and the
  // iepId to poll on, and nothing else.
  //
  // It stays in the DynamoDB row above, where it is load-bearing. Three
  // things parse it as `s3://bucket/key`:
  // ddb-service's _cleanup_unredacted_artifacts (which is what purges the
  // unredacted original), user-profile-handler, and
  // scripts/purge-orphaned-artifacts.py. Dropping the persisted field
  // would leave unredacted uploads behind, so only the response changes.
  return respond(200, { signedUrl, iepId });
};

// Non-upload (download) operations: enforce that the requested S3 key belongs
// to the authenticated user. S3 keys are always laid out as
// `{userId}/{childId}/{iepId}/{filename}` (see the upload branch above), so
// the user prefix is the authoritative ownership boundary. A key outside it
// is answered as not found, the same as a key that does not exist, so the
// response does not reveal whose keys exist.
const handleDownload = async (body, userId) => {
  const expectedPrefix = `${userId}/`;
  const keySegments = body.fileName.split('/');
  if (!body.fileName.startsWith(expectedPrefix) || keySegments.includes('..')) {
    // The key itself stays out of the log: it can carry a filename.
    return reject(404, 'Not found', 'download key is outside the caller\'s prefix or has a ".." segment');
  }

  let signedUrl;
  try {
    signedUrl = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: BUCKET,
      Key: body.fileName,
    }), { expiresIn: URL_EXPIRATION_SECONDS });
  } catch (error) {
    console.error('Failed to presign download URL:', error?.name ?? 'unknown error');
    return respond(500, { error: 'Failed to generate signed URL' });
  }
  return respond(200, { signedUrl });
};
