// Import necessary modules
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

const reject = (statusCode, message, reason) => {
  console.warn(`Rejected list request (${statusCode}): ${reason}`);
  return { statusCode, headers: corsHeaders, body: JSON.stringify({ message }) };
};

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Returns { token } on success, or null when the HTTP body is not a JSON
// object or carries a token that is not a string.
const readContinuationToken = (event) => {
  if (event?.continuationToken) {
    return typeof event.continuationToken === 'string' ? { token: event.continuationToken } : null;
  }
  if (typeof event?.body !== 'string' || event.body === '') {
    return { token: undefined };
  }
  let parsed;
  try {
    parsed = JSON.parse(event.body);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (parsed.continuationToken !== undefined && typeof parsed.continuationToken !== 'string') return null;
  return { token: parsed.continuationToken };
};

export const handler = async (event) => {
  const s3Client = new S3Client();
  const s3Bucket = process.env.BUCKET;

  // Authenticated user identity from the JWT authorizer.
  const userId = event?.requestContext?.authorizer?.jwt?.claims?.sub;
  if (!userId) {
    // Logged, because a silent 4xx is undiagnosable. This one should be
    // unreachable: the route carries the JWT authorizer, so a request that
    // gets here without a sub means the authorizer changed, not that a
    // caller did something wrong. Ids only, never a token or a claim.
    return reject(401, 'Unauthorized', 'no JWT sub on the request context');
  }

  if (!s3Bucket) {
    console.error('Server misconfigured: BUCKET is not set');
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ message: 'Server configuration error' }) };
  }

  // Accept continuationToken either from a direct invoke event or from an HTTP body.
  const tokenResult = readContinuationToken(event);
  if (!tokenResult) {
    return reject(400, 'Request body must be a JSON object with a string continuationToken',
      'body is not a JSON object or continuationToken is not a string');
  }
  const { token: continuationToken } = tokenResult;

  // Always scope listing to the authenticated user's own prefix to prevent
  // cross-user enumeration of the knowledge bucket.
  const userPrefix = `${userId}/`;

  try {
    const command = new ListObjectsV2Command({
      Bucket: s3Bucket,
      Prefix: userPrefix,
      ContinuationToken: continuationToken,
    });

    const result = await s3Client.send(command);

    // Built field by field rather than returned whole. The raw
    // ListObjectsV2 output carries `Name` (the bucket), `Prefix`, and a
    // `$metadata` block with the request id, extended request id and HTTP
    // status: none of it is anything a parent's browser needs, and the
    // bucket name is the one piece of infrastructure naming a client should
    // never learn. Keys are safe because the listing is already scoped to
    // `${userId}/`, so every key returned starts with the caller's own id.
    //
    // The field names match the SDK's on purpose: nothing in the app calls
    // this endpoint today, and keeping `Contents` / `IsTruncated` means a
    // caller that appears later reads the same shape it would have before.
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        Contents: (result.Contents ?? []).map(({ Key, Size, LastModified }) => ({
          Key,
          Size,
          LastModified,
        })),
        IsTruncated: result.IsTruncated ?? false,
        NextContinuationToken: result.NextContinuationToken,
      }),
    };
  } catch (error) {
    // An S3 fault is the service's, not the caller's, so it is a retryable 503.
    // The SDK error can quote the bucket, so only its name is logged.
    console.error('Get S3 Bucket data failed:', error?.name ?? 'unknown error');
    return {
      statusCode: 503,
      headers: corsHeaders,
      body: JSON.stringify({ message: 'Could not list your documents, please try again' }),
    };
  }
};
