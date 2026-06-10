/**
 * Create Auth Challenge Lambda Trigger for Phone OTP Authentication
 * This function generates a random OTP and sends it via SMS using AWS SNS
 * 
 * Based on AWS Cognito Custom Authentication Challenge best practices:
 * - Implement rate limiting and abuse protection
 * - Use secure OTP generation
 * - Proper error handling and logging
 * - SMS delivery via SNS for verified numbers
 */

const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { sanitizeCognitoEvent } = require('./sanitize');
const { getMessages, resolveLanguage } = require('./messages');

// Initialize AWS clients
const snsClient = new SNSClient({ region: process.env.AWS_REGION || 'us-east-1' });

// Configuration constants
const OTP_LENGTH = 6;
const OTP_EXPIRY_MINUTES = 5;
const MAX_SMS_PER_HOUR = 5; // Rate limiting

exports.handler = async (event) => {
    console.log('Create Auth Challenge Event:', JSON.stringify(sanitizeCognitoEvent(event), null, 2));
    
    const phoneNumber = event.request.userAttributes.phone_number;
    const userName = event.userName;
    const session = event.request.session || [];
    
    try {
        // Validate required parameters
        if (!phoneNumber) {
            console.error('Phone number not found in user attributes');
            throw new Error('Phone number is required for SMS authentication');
        }
        
        // Basic E.164 format validation
        validatePhoneNumberFormat(phoneNumber);
        
        // Check for rate limiting (basic protection)
        if (session.length > 0) {
            const recentAttempts = session.filter(s => 
                s.challengeName === 'CUSTOM_CHALLENGE' && 
                new Date() - new Date(s.challengeMetadata?.timestamp || 0) < 60 * 60 * 1000 // 1 hour
            );
            
            if (recentAttempts.length >= MAX_SMS_PER_HOUR) {
                console.error(`Rate limit exceeded for user: ${userName}`);
                throw new Error('Too many SMS requests. Please try again later.');
            }
        }
        
        let secretLoginCode;
        
        // Check if this is a retry of the same session
        if (session.length > 0) {
            const lastChallenge = session[session.length - 1];
            if (lastChallenge.challengeMetadata) {
                try {
                    const metadata = JSON.parse(lastChallenge.challengeMetadata);
                    const timeDiff = new Date() - new Date(metadata.timestamp);
                    
                    // Reuse OTP if within expiry window (5 minutes)
                    if (timeDiff < OTP_EXPIRY_MINUTES * 60 * 1000 && metadata.code) {
                        secretLoginCode = metadata.code;
                        console.log(`Reusing existing OTP for user: ${userName}`);
                    }
                } catch (parseError) {
                    console.log('Could not parse previous challenge metadata, generating new OTP');
                }
            }
        }
        
        // Generate new OTP if not reusing
        if (!secretLoginCode) {
            secretLoginCode = generateSecureOTP();
            console.log(`Generated new OTP for user: ${userName}`);

            // Send SMS in the user's language (clientMetadata -> profile -> English)
            const language = await resolveLanguage(event);
            await sendSMS(phoneNumber, secretLoginCode, language);
            console.log(`SMS sent successfully (language: ${language})`);
        }
        
        // Set challenge parameters
        event.response.publicChallengeParameters = {
            phone_number: phoneNumber
        };
        
        event.response.privateChallengeParameters = {
            secretLoginCode: secretLoginCode
        };
        
        // Store metadata for retry logic and expiry
        event.response.challengeMetadata = JSON.stringify({
            code: secretLoginCode,
            timestamp: new Date().toISOString(),
            phoneNumber: phoneNumber,
            attempt: session.length + 1
        });
        
        console.log('Create Auth Challenge Response successful');
        
    } catch (error) {
        console.error('Error in Create Auth Challenge:', error);
        
        // Set error response that will be handled by the client
        event.response.publicChallengeParameters = {
            error: 'Failed to send verification code. Please try again.'
        };
        
        // Still need to set private parameters to avoid Lambda errors
        event.response.privateChallengeParameters = {
            secretLoginCode: 'ERROR'
        };
        
        event.response.challengeMetadata = JSON.stringify({
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
    
    return event;
};

/**
 * Generate a cryptographically secure OTP
 */
function generateSecureOTP() {
    // Use crypto.randomInt for better security than Math.random
    const crypto = require('crypto');
    const min = Math.pow(10, OTP_LENGTH - 1);
    const max = Math.pow(10, OTP_LENGTH) - 1;
    return crypto.randomInt(min, max + 1).toString();
}

/**
 * Basic phone number format validation for E.164 format
 */
function validatePhoneNumberFormat(phoneNumber) {
    // Basic E.164 format validation
    const e164Regex = /^\+[1-9]\d{1,14}$/;
    if (!e164Regex.test(phoneNumber)) {
        throw new Error('Phone number must be in E.164 format (e.g., +1234567890)');
    }
    
    console.log('Phone number format validation passed');
}

/**
 * Send SMS using AWS SNS with enhanced security
 */
async function sendSMS(phoneNumber, otpCode, language = 'en') {
    const message = getMessages(language).otpLoginSms
        .replace('{code}', otpCode)
        .replace('{minutes}', OTP_EXPIRY_MINUTES);

    const publishParams = {
        Message: message,
        PhoneNumber: phoneNumber,
        MessageAttributes: {
            'AWS.SNS.SMS.SenderID': {
                DataType: 'String',
                StringValue: 'GovLab-AIEP'
            },
            'AWS.SNS.SMS.SMSType': {
                DataType: 'String',
                StringValue: 'Transactional'
            },
            'AWS.SNS.SMS.MaxPrice': {
                DataType: 'String',
                StringValue: '0.50' // Prevent high-cost SMS abuse
            }
        }
    };
    
    const command = new PublishCommand(publishParams);
    const result = await snsClient.send(command);
    
    console.log(`SMS sent successfully. MessageId: ${result.MessageId}`);
    return result;
} 