/**
 * Verify Auth Challenge Response Lambda Trigger for Phone OTP Authentication
 * This function validates the OTP code entered by the user against the generated code
 * and creates a user profile if authentication succeeds for the first time
 * 
 * Based on AWS Cognito Custom Authentication Challenge best practices:
 * - Secure OTP validation with timing attack protection
 * - Proper error handling and logging
 * - User profile creation for new phone-based users
 * - Session management and security
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { randomUUID } = require('crypto');
const { sanitizeCognitoEvent } = require('./sanitize');
const { normalizeLanguage } = require('./messages');

// Initialize DynamoDB client
const dynamodbClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(dynamodbClient);

// Configuration constants
// Must match create-auth-challenge (which stamps issuedAt and whose SMS copy
// quotes this number) and the pool client's authSessionValidity.
const OTP_EXPIRY_MINUTES = 5;

exports.handler = async (event) => {
    console.log('Verify Auth Challenge Event:', JSON.stringify(sanitizeCognitoEvent(event), null, 2));

    const expectedAnswer = event.request.privateChallengeParameters.secretLoginCode;
    const challengeAnswer = event.request.challengeAnswer;
    const userId = event.userName;

    try {
        console.log(`Verifying OTP for user: ${userId}`);

        // Language handshake round always passes: its only purpose is to
        // carry the client's UI language (RespondToAuthChallenge
        // clientMetadata) into the next round, where the OTP SMS is sent.
        // Safe because define-auth-challenge never issues tokens for a
        // handshake round.
        if (expectedAnswer === 'LANGUAGE_HANDSHAKE') {
            console.log('Language handshake round acknowledged');
            event.response.answerCorrect = true;
            return event;
        }

        // Handle error cases from create challenge
        if (expectedAnswer === 'ERROR') {
            console.error('Previous challenge had an error, failing verification');
            event.response.answerCorrect = false;
            return event;
        }
        
        // Validate inputs
        if (!challengeAnswer || !expectedAnswer) {
            console.error('Missing challenge answer or expected answer');
            event.response.answerCorrect = false;
            return event;
        }
        
        // Check if OTP has expired. This trigger never receives the session
        // array, so the issuance time rides in privateChallengeParameters:
        // create-auth-challenge stamps issuedAt on first issuance and carries
        // the ORIGINAL stamp through in-session reuse rounds, so retries
        // cannot slide the window. A missing or garbled stamp (an in-flight
        // session from an older deploy) skips the check rather than lock the
        // user out; the pool client's authSessionValidity still bounds it.
        const issuedAt = event.request.privateChallengeParameters.issuedAt;
        if (issuedAt) {
            const issuedAtMs = new Date(issuedAt).getTime();
            if (!Number.isNaN(issuedAtMs) && Date.now() - issuedAtMs > OTP_EXPIRY_MINUTES * 60 * 1000) {
                console.error(`OTP expired for user: ${userId}`);
                event.response.answerCorrect = false;
                return event;
            }
        }

        // Validate the OTP using timing-safe comparison
        const isValid = secureCompare(challengeAnswer.trim(), expectedAnswer.trim());
        
        if (isValid) {
            console.log(`OTP verification successful for user: ${userId}`);
            event.response.answerCorrect = true;
            
            // Create user profile if this is the first successful authentication
            try {
                const uiLanguage = normalizeLanguage(event.request.clientMetadata?.language);
                await createUserProfileIfNotExists(userId, uiLanguage);
            } catch (error) {
                console.error('Error creating user profile:', error);
                // Don't fail authentication if profile creation fails
                // The user can still sign in and profile can be created later
            }
        } else {
            console.log(`OTP verification failed for user: ${userId}`);
            event.response.answerCorrect = false;
        }
        
    } catch (error) {
        console.error('Error in Verify Auth Challenge:', error);
        // On any error, fail the verification for security
        event.response.answerCorrect = false;
    }
    
    console.log(`Verify Auth Challenge result for user ${userId}: answerCorrect=${event.response.answerCorrect}`);
    return event;
};

/**
 * Timing-safe string comparison to prevent timing attacks
 */
function secureCompare(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    
    return result === 0;
}

/**
 * Create a user profile if one doesn't already exist
 * This function is called after successful phone OTP verification
 */
async function createUserProfileIfNotExists(userId, uiLanguage) {
    const userProfilesTable = process.env.USER_PROFILES_TABLE;
    
    if (!userProfilesTable) {
        console.log('USER_PROFILES_TABLE environment variable not set');
        return;
    }
    
    try {
        // Check if profile already exists
        const getCommand = new GetCommand({
            TableName: userProfilesTable,
            Key: { userId: userId }
        });
        
        const existingProfile = await docClient.send(getCommand);
        
        if (existingProfile.Item) {
            console.log(`Profile already exists for user ${userId}, skipping creation`);
            return;
        }
        
        // Create timestamp
        const currentTime = Math.floor(Date.now() / 1000);
        const currentDateTime = new Date().toISOString();
        
        // Create default child for IEP document functionality
        const defaultChild = {
            childId: randomUUID(),
            name: 'My Child',
            schoolCity: 'Not specified',
            createdAt: currentTime,
            updatedAt: currentTime
        };
        
        // Create default profile for phone-based user
        const newProfile = {
            userId: userId,
            createdAt: currentTime,
            createdAtISO: currentDateTime,
            updatedAt: currentTime,
            updatedAtISO: currentDateTime,
            children: [defaultChild],  // Initialize with default child
            consentGiven: false,  // Default consent to false
            // The onboarding gate checks showOnboarding === true strictly, so
            // this fallback creator must set it or users created here would
            // silently skip onboarding (including the consent form)
            showOnboarding: true,
            authMethod: 'phone',  // Track authentication method
            phoneVerified: true,  // Phone is verified through OTP process
            // Seed the language preference from the UI language used at sign-in
            // so SMS/translations match before the user opens their profile
            ...(uiLanguage && { secondaryLanguage: uiLanguage })
        };
        
        // Use put_item with condition to prevent overwriting
        const putCommand = new PutCommand({
            TableName: userProfilesTable,
            Item: newProfile,
            ConditionExpression: 'attribute_not_exists(userId)'
        });
        
        await docClient.send(putCommand);
        console.log(`Created default profile for phone user ${userId}`);
        
    } catch (error) {
        if (error.name === 'ConditionalCheckFailedException') {
            console.log(`Profile already exists for user ${userId}, no action needed`);
        } else {
            console.error(`Error creating user profile for ${userId}:`, error);
            throw error;
        }
    }
} 