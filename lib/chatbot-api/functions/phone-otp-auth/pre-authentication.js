/**
 * Pre Authentication Lambda Trigger
 *
 * Stamps the sign-in screen's UI language onto the user's profile row so the
 * OTP SMS can be sent in that language. This is the only way the login
 * screen's language can reach the SMS: Cognito forwards InitiateAuth
 * ClientMetadata to the pre-authentication trigger (as validationData) but
 * NOT to the create-auth-challenge trigger that composes the SMS.
 * Pre-authentication completes before create-auth-challenge runs, so the
 * stamped value is always fresh for the current sign-in.
 *
 * Best-effort by design: any failure here must never block authentication.
 */

const { normalizeLanguage } = require('./messages');

let docClient = null;
function getDocClient() {
    if (!docClient) {
        const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
        const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
        const dynamodbClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
        docClient = DynamoDBDocumentClient.from(dynamodbClient);
    }
    return docClient;
}

exports.handler = async (event) => {
    try {
        // InitiateAuth (and AdminInitiateAuth) ClientMetadata arrives as
        // validationData on this trigger; PreAuthentication events carry no
        // clientMetadata field.
        const language = normalizeLanguage(event.request?.validationData?.language);
        const userProfilesTable = process.env.USER_PROFILES_TABLE;
        const userId = event.userName;

        if (language && userProfilesTable && userId) {
            const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
            // Only update existing profiles: brand-new users have no row yet
            // and are covered by the signup-time 'locale' attribute fallback.
            await getDocClient().send(new UpdateCommand({
                TableName: userProfilesTable,
                Key: { userId: userId },
                UpdateExpression: 'SET loginLanguage = :lang',
                ConditionExpression: 'attribute_exists(userId)',
                ExpressionAttributeValues: { ':lang': language },
            }));
            console.log(`Stamped loginLanguage=${language} for user ${userId}`);
        }
    } catch (error) {
        if (error.name === 'ConditionalCheckFailedException') {
            console.log('No profile row yet; skipping loginLanguage stamp');
        } else {
            console.warn('loginLanguage stamp failed (non-blocking):', error.message);
        }
    }
    return event;
};
