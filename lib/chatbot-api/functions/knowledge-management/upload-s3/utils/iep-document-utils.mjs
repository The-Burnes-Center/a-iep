/**
 * Shared utilities for IEP document operations (ES Modules version)
 */
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, DeleteCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });

/**
 * Delete every object under a prefix, following the continuation token.
 * Returns the number removed.
 */
const deletePrefix = async (bucketName, prefix) => {
  let deleted = 0;
  let token;
  do {
    const listed = await s3.send(new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix,
      ContinuationToken: token,
    }));
    for (const object of listed.Contents ?? []) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: object.Key }));
      console.log(`Deleted S3 object: ${object.Key}`);
      deleted++;
    }
    token = listed.NextContinuationToken;
  } while (token);
  return deleted;
};

/**
 * Purge every S3 artifact derived from one IEP document record.
 *
 * Must run BEFORE the row is deleted: contentS3Reference is the only pointer
 * to the summary object, so dropping the row first strands it. This path runs
 * on EVERY upload (one active IEP per child means the previous one is
 * replaced), so a miss here leaks on the most common action in the app, not
 * on some rare admin operation. Measured on 2026-08-10: 40 content and 18
 * audio directories in staging, 20 content in prod, with no row pointing at
 * any of them.
 *
 * Mirrors _delete_document_artifacts in user-profile-handler; the two delete
 * paths must strip the same three artifact shapes.
 */
const deleteDocumentArtifacts = async (bucketName, doc) => {
  let deleted = 0;
  const ref = doc.contentS3Reference ?? {};

  if (ref.s3Key) {
    try {
      await s3.send(new DeleteObjectCommand({
        Bucket: ref.bucket ?? bucketName,
        Key: ref.s3Key,
      }));
      console.log(`Deleted S3 content: ${ref.s3Key}`);
      deleted++;
    } catch (error) {
      console.error(`Error deleting S3 content ${ref.s3Key}:`, error);
    }
  }

  if (doc.iepId && doc.childId) {
    // The legacy layout, and a no-op when contentS3Reference already pointed
    // here. DeleteObject succeeds on a key that never existed.
    try {
      deleted += await deletePrefix(bucketName, `iep-data/${doc.iepId}/${doc.childId}/`);
      deleted += await deletePrefix(bucketName, `iep-audio/${doc.iepId}/${doc.childId}/`);
    } catch (error) {
      console.error(`Error purging derived artifacts for ${doc.iepId}:`, error);
    }
  }

  return deleted;
};

/**
 * Delete all IEP-related data for a specific child
 * This includes:
 * 1. S3 files (actual IEP documents)
 * 2. Records in IEP documents table
 * 3. IEP references in the user's profile
 * 
 * @param {string} userId - The user ID
 * @param {string} childId - The child ID
 * @param {string} bucketName - The S3 bucket name
 * @param {string} iepDocumentsTableName - The IEP documents table name
 * @param {string} userProfilesTableName - The user profiles table name
 * @returns {Promise<Object>} - Result object with deletion counts
 */
export const deleteIepDocumentsForChild = async (userId, childId, bucketName, iepDocumentsTableName, userProfilesTableName) => {
  const result = {
    s3ObjectsDeleted: 0,
    documentsDeleted: 0,
    profileUpdated: false
  };

  // 1. Delete the child's raw uploads (originals live under userId/childId/).
  //    Derived artifacts are NOT under this prefix; step 2 handles those.
  try {
    const prefix = `${userId}/${childId}/`;
    console.log(`Listing S3 objects with prefix: ${prefix} in bucket: ${bucketName}`);
    result.s3ObjectsDeleted += await deletePrefix(bucketName, prefix);
    console.log(`Deleted ${result.s3ObjectsDeleted} raw upload object(s) for childId: ${childId}`);
  } catch (s3Error) {
    console.error('Error deleting S3 objects:', s3Error);
    // Continue with other deletions even if S3 deletion fails
  }

  // 2. Delete the document rows, and the S3 artifacts derived from each one.
  //    Order matters: the row carries the only pointer to its summary object.
  try {
    // Query documents by childId, following LastEvaluatedKey. A single page
    // caps at 1MB and these rows can carry inline summaries, so an
    // unpaginated read leaves the overflow rows and their artifacts behind.
    const documents = [];
    let startKey;
    do {
      const response = await ddb.send(new QueryCommand({
        TableName: iepDocumentsTableName,
        IndexName: 'byChildId',
        KeyConditionExpression: 'childId = :childId',
        ExpressionAttributeValues: {':childId': childId},
        ExclusiveStartKey: startKey,
      }));
      documents.push(...(response.Items ?? []));
      startKey = response.LastEvaluatedKey;
    } while (startKey);

    // Delete each document record that belongs to this user
    for (const doc of documents) {
      if (!doc.userId || doc.userId === userId) {
        result.s3ObjectsDeleted += await deleteDocumentArtifacts(bucketName, doc);

        await ddb.send(new DeleteCommand({
          TableName: iepDocumentsTableName,
          Key: {
            iepId: doc.iepId,
            childId: doc.childId
          }
        }));
        console.log(`Deleted IEP document record with iepId: ${doc.iepId} for childId: ${childId}`);
        result.documentsDeleted++;
      }
    }

  } catch (ddbError) {
    console.error('Error deleting document records:', ddbError);
    // Continue with profile update even if document deletion fails
  }
  
  // 3. Update the user profile to remove any IEP document references for this child
  try {
    // First get the current user profile
    const userProfileResponse = await ddb.send(new QueryCommand({
      TableName: userProfilesTableName,
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {':userId': userId}
    }));
    
    if (userProfileResponse.Items && userProfileResponse.Items.length > 0) {
      const userProfile = userProfileResponse.Items[0];
      let updated = false;
      
      // Check if there are children in the profile
      if (userProfile.children && Array.isArray(userProfile.children)) {
        const children = userProfile.children;
        
        // Find the child and remove any IEP document references
        for (let i = 0; i < children.length; i++) {
          if (children[i].childId === childId) {
            // Remove any IEP document data if present
            if (children[i].iepDocument) {
              delete children[i].iepDocument;
              updated = true;
              console.log(`Removed IEP document reference from child ${childId} in user profile`);
            }
          }
        }
        
        // Update the profile if changes were made
        if (updated) {
          const now = new Date();
          const timestamp = Math.floor(now.getTime());
          const datetimeISO = now.toISOString();
          
          await ddb.send(new UpdateCommand({
            TableName: userProfilesTableName,
            Key: {userId: userId},
            UpdateExpression: 'SET #children = :children, updatedAt = :updatedAt, updatedAtISO = :updatedAtISO',
            ExpressionAttributeNames: {'#children': 'children'},
            ExpressionAttributeValues: {
              ':children': children,
              ':updatedAt': timestamp,
              ':updatedAtISO': datetimeISO
            }
          }));
          console.log(`Updated user profile to remove IEP document references`);
          result.profileUpdated = true;
        }
      }
    }
    
  } catch (profileError) {
    console.error('Error updating user profile:', profileError);
    // Continue even if profile update fails
  }
  
  return result;
}; 