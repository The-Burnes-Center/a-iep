/**
 * sanitizeCognitoEvent is the only thing standing between the OTP secret /
 * user PII and CloudWatch (every trigger logs the sanitized event). These
 * tests enumerate each sensitive field and pin that the original event is
 * never mutated, since handlers still need the real values afterwards.
 */
const {
    sanitizeCognitoEvent,
    REDACTED,
} = require('../../../lib/chatbot-api/functions/phone-otp-auth/sanitize');

const fullEvent = () => ({
    userName: 'user-1',
    request: {
        userAttributes: {
            phone_number: '+15555550100',
            email: 'parent@example.com',
            name: 'Jane Parent',
            locale: 'es',
        },
        privateChallengeParameters: { secretLoginCode: '123456' },
        challengeAnswer: '123456',
        challengeMetadata: '{"code":"123456"}',
        session: [
            { challengeName: 'CUSTOM_CHALLENGE', challengeMetadata: '{"code":"111111","phoneNumber":"+15555550100"}' },
        ],
    },
    response: {
        publicChallengeParameters: { challengeType: 'LANGUAGE_HANDSHAKE', phone_number: '+15555550100' },
        privateChallengeParameters: { secretLoginCode: '123456' },
        challengeMetadata: '{"code":"123456"}',
    },
});

describe('sanitizeCognitoEvent', () => {
    test('redacts every secret and PII field on request and response', () => {
        const safe = sanitizeCognitoEvent(fullEvent());

        expect(safe.request.privateChallengeParameters).toBe(REDACTED);
        expect(safe.request.challengeAnswer).toBe(REDACTED);
        expect(safe.request.challengeMetadata).toBe(REDACTED);
        expect(safe.request.userAttributes.phone_number).toBe(REDACTED);
        expect(safe.request.userAttributes.email).toBe(REDACTED);
        expect(safe.request.userAttributes.name).toBe(REDACTED);
        expect(safe.request.session[0].challengeMetadata).toBe(REDACTED);

        expect(safe.response.privateChallengeParameters).toBe(REDACTED);
        expect(safe.response.challengeMetadata).toBe(REDACTED);
        expect(safe.response.publicChallengeParameters.phone_number).toBe(REDACTED);
    });

    test('nothing redacted ever survives serialization', () => {
        const logged = JSON.stringify(sanitizeCognitoEvent(fullEvent()));
        expect(logged).not.toContain('123456');
        expect(logged).not.toContain('111111');
        expect(logged).not.toContain('+15555550100');
        expect(logged).not.toContain('parent@example.com');
        expect(logged).not.toContain('Jane Parent');
    });

    test('keeps the non-sensitive fields handlers need to debug', () => {
        const safe = sanitizeCognitoEvent(fullEvent());
        expect(safe.userName).toBe('user-1');
        expect(safe.request.userAttributes.locale).toBe('es');
        expect(safe.response.publicChallengeParameters.challengeType).toBe('LANGUAGE_HANDSHAKE');
        expect(safe.request.session[0].challengeName).toBe('CUSTOM_CHALLENGE');
    });

    test('never mutates the original event', () => {
        const event = fullEvent();
        const before = JSON.parse(JSON.stringify(event));
        sanitizeCognitoEvent(event);
        expect(event).toEqual(before);
    });

    test('a non-serializable event is dropped with a note instead of thrown', () => {
        const circular = { request: {} };
        circular.request.self = circular;
        expect(sanitizeCognitoEvent(circular)).toEqual({
            note: 'event omitted from logs (not serializable)',
        });
    });
});
