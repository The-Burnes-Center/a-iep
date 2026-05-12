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

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(result),
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
