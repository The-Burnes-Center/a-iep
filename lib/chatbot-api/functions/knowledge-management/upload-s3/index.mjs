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

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });

// Main Lambda entry point
export const handler = async (event) => {
  return await getUploadURL(event);
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

//Helper function to generate a presigned upload URL for S3
const getUploadURL = async function (event) {
  const body = JSON.parse(event.body); //Parse the incoming request body
  const fileName = body.fileName; //Retrieve the file name
  const fileType = body.fileType; //Retrieve the file type
  const operation = body.operation; //Retrieve the operation type
  const childId = body.childId; // Get the childId for linking

  // Get user information from Cognito claims
  const userId = event.requestContext.authorizer.jwt.claims.sub;

  if (!fileName || !operation || !childId) {
    return {
      statusCode: 400,
      headers: {
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ message: 'fileName, operation, and childId are required' }),
    };
  }

  // Use the global S3 client defined at the top of the file
  let params;
  if (operation === 'upload') {
    if (!fileType) {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ message: 'fileType is required for upload' }),
      };
    }

    // Generate unique IEP document ID
    const iepId = `iep-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    const s3Key = `${userId}/${childId}/${iepId}/${fileName}`;

    params = {
      Bucket: BUCKET,
      Key: s3Key,
      ContentType: fileType,
    };

    const command = new PutObjectCommand(params);
    try {
      const signedUrl = await getSignedUrl(s3, command, {
        expiresIn: URL_EXPIRATION_SECONDS,
      });

      // Create document record in DynamoDB
      const timestamp = Math.floor(Date.now() / 1000);
      const documentRecord = {
        iepId: iepId,
        childId: childId,
        userId: userId,
        documentUrl: `s3://${BUCKET}/${s3Key}`,
        createdAt: timestamp,
        updatedAt: timestamp,
        summaries: {}
      };

      // Delete any existing IEP documents for this child BEFORE adding the new one
      await deleteExistingDocuments(childId, userId);

      // Add the new document record
      await ddb.send(new PutCommand({
        TableName: IEP_DOCUMENTS_TABLE,
        Item: documentRecord
      }));

      return {
        statusCode: 200,
        headers: {
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ 
          signedUrl,
          iepId,
          documentUrl: `s3://${BUCKET}/${s3Key}`
        }),
      };
    } catch (err) {
      console.error('Error:', err);
      return {
        statusCode: 500,
        headers: {
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ error: 'Failed to generate signed URL or save document record' }),
      };
    }
  }

  // Non-upload (download) operations: enforce that the requested S3 key belongs
  // to the authenticated user. S3 keys are always laid out as
  // `{userId}/{childId}/{iepId}/{filename}` (see the upload branch above), so
  // the user prefix is the authoritative ownership boundary.
  const expectedPrefix = `${userId}/`;
  const keySegments = fileName.split('/');
  if (!fileName.startsWith(expectedPrefix) || keySegments.includes('..')) {
    console.warn(`Access denied: user ${userId} attempted to access key ${fileName}`);
    return {
      statusCode: 403,
      headers: {
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ message: 'Access denied: cannot access files belonging to other users' }),
    };
  }

  params = {
    Bucket: BUCKET,
    Key: fileName,
  };
  const command = new GetObjectCommand(params);
  try {
    const signedUrl = await getSignedUrl(s3, command, {
      expiresIn: URL_EXPIRATION_SECONDS,
    });
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ signedUrl }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ error: 'Failed to generate signed URL' }),
    };
  }
};


