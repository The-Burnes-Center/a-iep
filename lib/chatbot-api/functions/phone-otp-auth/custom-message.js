/**
 * Custom Message Lambda Trigger
 *
 * Localizes the SMS and email messages Cognito sends for sign-up
 * verification, attribute verification, forgot password, and SMS
 * authentication, based on the user's UI language (see messages.js for
 * the resolution order).
 *
 * For unhandled trigger sources the event is returned unchanged so
 * Cognito falls back to the user pool defaults.
 */

const { sanitizeCognitoEvent } = require('./sanitize');
const { getMessages, resolveLanguage } = require('./messages');

exports.handler = async (event) => {
    console.log('Custom Message Event:', JSON.stringify(sanitizeCognitoEvent(event), null, 2));

    try {
        const language = await resolveLanguage(event);
        const messages = getMessages(language);

        switch (event.triggerSource) {
            case 'CustomMessage_SignUp':
            case 'CustomMessage_ResendCode':
                // Cognito picks smsMessage or emailMessage depending on how
                // the user signed up (phone vs email); set both.
                event.response.smsMessage = messages.verificationSms;
                event.response.emailSubject = messages.signUpEmailSubject;
                event.response.emailMessage = messages.signUpEmailBody;
                break;

            case 'CustomMessage_VerifyUserAttribute':
            case 'CustomMessage_UpdateUserAttribute':
                event.response.smsMessage = messages.verificationSms;
                event.response.emailSubject = messages.signUpEmailSubject;
                event.response.emailMessage = messages.signUpEmailBody;
                break;

            case 'CustomMessage_ForgotPassword':
                event.response.smsMessage = messages.verificationSms;
                event.response.emailSubject = messages.forgotPasswordEmailSubject;
                event.response.emailMessage = messages.forgotPasswordEmailBody;
                break;

            case 'CustomMessage_Authentication':
                event.response.smsMessage = messages.authenticationSms;
                break;

            default:
                console.log(`Unhandled trigger source ${event.triggerSource}, using pool defaults`);
                break;
        }

        console.log(`Custom message localized to '${language}' for ${event.triggerSource}`);
    } catch (error) {
        // Never block the auth flow over localization: returning the event
        // unchanged makes Cognito send its default (English) message.
        console.error('Error localizing custom message, using pool defaults:', error);
    }

    return event;
};
