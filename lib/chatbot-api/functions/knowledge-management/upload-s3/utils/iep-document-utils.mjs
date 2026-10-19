/**
 * Shared utilities for IEP document operations (ES Modules version)
 */
import { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });

// S3 DeleteObjects accepts at most 1000 keys per request.
const DELETE_BATCH_SIZE = 1000;

// Keys under these prefixes are built from ids alone, so they are safe to log
// whole. A raw upload is userId/childId/iepId/<filename>, and parents
// routinely name the file after their child.
const ID_ONLY_PREFIXES = ['iep-data/', 'iep-audio/'];

const safeKey = (key) => {
  if (ID_ONLY_PREFIXES.some((prefix) => key.startsWith(prefix))) return key;
  const slash = key.lastIndexOf('/');
  return slash === -1 ? '...' : `${key.slice(0, slash)}/...`;
};

const chunk = (items, size) => {
  const batches = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
};

/**
 * One DeleteObjects call for a batch of {Key, VersionId} entries.
 *
 * Per-key failures come back in the body of a successful response, so they
 * are thrown here. Without that check a version that failed to delete would
 * look deleted, and the caller would go on to drop the row that points at it.
 */
const deleteVersionBatch = async (bucketName, entries) => {
  const response = await s3.send(new DeleteObjectsCommand({
    Bucket: bucketName,
    Delete: {
      Objects: entries.map(({ Key, VersionId }) => ({ Key, VersionId })),
      Quiet: true,
    },
  }));
  if (response.Errors?.length) {
    // The error code is an S3 code (AccessDenied, InternalError); the key is
    // left out because it can carry a filename.
    throw new Error(`DeleteObjects left ${response.Errors.length} version(s) in place `
      + `(first error code: ${response.Errors[0].Code})`);
  }
};

/**
 * Permanently delete every version and delete marker under a prefix.
 *
 * The bucket is versioned, so DeleteObject without a VersionId only writes a
 * delete marker: the bytes stay retrievable by version id until the 1-day
 * noncurrent lifecycle rule reaches them, which measured 1 to 3 days on
 * staging (2026-10-14). Deleting each version by id is immediate and final.
 * Entries go out in DeleteObjects batches of up to 1000 keys.
 * JS twin of _delete_every_version in the Python delete paths.
 *
 * exact takes only the one key named by prefix: version listing is by prefix,
 * so report.pdf would otherwise also take report.pdf2.
 *
 * Returns the keys that had a current version, so callers count real
 * deletions rather than markers and superseded versions.
 */
const deleteEveryVersion = async (bucketName, prefix, { exact = false } = {}) => {
  const visible = [];
  let keyMarker;
  let versionIdMarker;
  let truncated;
  do {
    const listed = await s3.send(new ListObjectVersionsCommand({
      Bucket: bucketName,
      Prefix: prefix,
      KeyMarker: keyMarker,
      VersionIdMarker: versionIdMarker,
    }));
    const versions = listed.Versions ?? [];
    const matches = (entry) => !exact || entry.Key === prefix;
    const entries = [...versions, ...(listed.DeleteMarkers ?? [])].filter(matches);
    for (const batch of chunk(entries, DELETE_BATCH_SIZE)) {
      await deleteVersionBatch(bucketName, batch);
    }
    visible.push(...versions.filter((v) => v.IsLatest && matches(v)).map((v) => v.Key));
    truncated = listed.IsTruncated;
    keyMarker = listed.NextKeyMarker;
    versionIdMarker = listed.NextVersionIdMarker;
  } while (truncated);
  return visible;
};

/**
 * Delete every object under a prefix, every version of it.
 * Returns the number of objects that were current.
 */
const deletePrefix = async (bucketName, prefix) => {
  const deleted = await deleteEveryVersion(bucketName, prefix);
  for (const key of deleted) console.log(`Deleted S3 object: ${safeKey(key)}`);
  return deleted.length;
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
      const removed = await deleteEveryVersion(ref.bucket ?? bucketName, ref.s3Key, { exact: true });
      console.log(`Deleted S3 content: ${safeKey(ref.s3Key)}`);
      deleted += removed.length;
    } catch (error) {
      console.error(`Error deleting S3 content for iepId ${doc.iepId}:`, error);
    }
  }

  if (doc.iepId && doc.childId) {
    // The legacy layout, and a no-op when contentS3Reference already pointed
    // here: a key already purged above is simply not listed. The two sweeps
    // cover disjoint prefixes, so they run concurrently.
    const sweeps = await Promise.allSettled([
      deletePrefix(bucketName, `iep-data/${doc.iepId}/${doc.childId}/`),
      deletePrefix(bucketName, `iep-audio/${doc.iepId}/${doc.childId}/`),
    ]);
    for (const outcome of sweeps) {
      if (outcome.status === 'fulfilled') {
        deleted += outcome.value;
      } else {
        console.error(`Error purging derived artifacts for ${doc.iepId}:`, outcome.reason);
      }
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
