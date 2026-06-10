/**
 * Define Auth Challenge Lambda Trigger for Phone OTP Authentication
 * This function determines which challenges should be presented to the user
 * and when to issue tokens or fail authentication.
 * 
 * Based on AWS Cognito Custom Authentication Challenge best practices:
 * - Limit retry attempts to prevent abuse
 * - Provide clear authentication flow logic
 * - Handle edge cases properly
 */

const { sanitizeCognitoEvent } = require('./sanitize');

exports.handler = async (event) => {
    console.log('Define Auth Challenge Event:', JSON.stringify(sanitizeCognitoEvent(event), null, 2));
    
    const { session, triggerSource } = event.request;
    const userName = event.userName;
    
    try {
        // If no session exists or empty session, this is the first challenge
        if (!session || session.length === 0) {
            console.log(`First authentication attempt for user: ${userName}`);
            event.response.challengeName = 'CUSTOM_CHALLENGE';
            event.response.issueTokens = false;
            event.response.failAuthentication = false;
        } 
        // Check if user has successfully completed the most recent challenge
        else if (session.length > 0) {
            const lastChallenge = session[session.length - 1];
            // Round 1 is a language handshake (no SMS, auto-passes); it must
            // never issue tokens — only a passed OTP round may. Failed
            // attempts are counted on OTP rounds only.
            const lastWasHandshake = lastChallenge.challengeMetadata === 'LANGUAGE_HANDSHAKE';
            const failedOtpAttempts = session.filter(
                (s) => s.challengeMetadata !== 'LANGUAGE_HANDSHAKE' && s.challengeResult === false
            ).length;

            if (lastChallenge.challengeResult === true && !lastWasHandshake) {
                console.log(`Authentication successful for user: ${userName}`);
                event.response.issueTokens = true;
                event.response.failAuthentication = false;
            }
            // Check if user has exceeded maximum attempts (AWS recommends 3 attempts)
            else if (failedOtpAttempts >= 3) {
                console.log(`Maximum attempts exceeded for user: ${userName}. Failing authentication.`);
                event.response.issueTokens = false;
                event.response.failAuthentication = true;
            }
            // Handshake completed or wrong answer within the attempt limit:
            // issue the next challenge round (the OTP, or an OTP retry)
            else {
                console.log(`Authentication attempt ${session.length + 1} for user: ${userName}`);
                event.response.challengeName = 'CUSTOM_CHALLENGE';
                event.response.issueTokens = false;
                event.response.failAuthentication = false;
            }
        }
        
        console.log('Define Auth Challenge Response:', JSON.stringify(event.response, null, 2));
        
    } catch (error) {
        console.error('Error in Define Auth Challenge:', error);
        // On error, fail the authentication to prevent security issues
        event.response.issueTokens = false;
        event.response.failAuthentication = true;
    }
    
    return event;
}; 