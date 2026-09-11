// Import necessary modules
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
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
    console.warn('Rejected list request: no JWT sub on the request context');
    return {
      statusCode: 401,
      headers: corsHeaders,
      body: JSON.stringify({ message: 'Unauthorized' }),
    };
  }

  // Accept continuationToken either from a direct invoke event or from an HTTP body.
  let continuationToken = event?.continuationToken;
  if (!continuationToken && typeof event?.body === 'string') {
    try {
      const parsed = JSON.parse(event.body);
      continuationToken = parsed?.continuationToken;
    } catch {
      // Ignore body parse errors; treat as no continuation token.
    }
  }

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
    console.error('Get S3 Bucket data failed:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ message: 'Get S3 Bucket data failed- Internal Server Error' }),
    };
  }
};
