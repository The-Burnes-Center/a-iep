/**
 * define-auth-challenge decides, from the session history alone, whether to
 * issue a challenge, issue tokens, or fail authentication. These tests pin
 * the whole state machine, including the userNotFound guard from the 2026-07
 * OTP incident (PR #51): with PreventUserExistenceErrors ENABLED, Cognito
 * invokes the triggers for unknown numbers instead of throwing, and the
 * handler must fail fast so the frontend's sign-up fallback fires.
 */
const { handler } = require('../../../lib/chatbot-api/functions/phone-otp-auth/define-auth-challenge');

const baseEvent = (session, extra = {}) => ({
    userName: 'test-user',
    request: { userAttributes: { phone_number: '+15555550100' }, session, ...extra },
    response: {},
});

const HANDSHAKE_PASS = {
    challengeName: 'CUSTOM_CHALLENGE',
    challengeResult: true,
    challengeMetadata: 'LANGUAGE_HANDSHAKE',
};
const OTP_PASS = {
    challengeName: 'CUSTOM_CHALLENGE',
    challengeResult: true,
    challengeMetadata: '{"code":"123456"}',
};
const OTP_FAIL = {
    challengeName: 'CUSTOM_CHALLENGE',
    challengeResult: false,
    challengeMetadata: '{"code":"123456"}',
};

describe('define-auth-challenge', () => {
    test('unknown user (userNotFound) fails authentication immediately', async () => {
        const event = await handler(baseEvent([], { userNotFound: true, userAttributes: {} }));
        expect(event.response.failAuthentication).toBe(true);
        expect(event.response.issueTokens).toBe(false);
        expect(event.response.challengeName).toBeUndefined();
    });

    test('first round issues a custom challenge, no tokens', async () => {
        const event = await handler(baseEvent([], { userNotFound: false }));
        expect(event.response.challengeName).toBe('CUSTOM_CHALLENGE');
        expect(event.response.issueTokens).toBe(false);
        expect(event.response.failAuthentication).toBe(false);
    });

    test('passed language handshake issues the next challenge, never tokens', async () => {
        const event = await handler(baseEvent([HANDSHAKE_PASS]));
        expect(event.response.challengeName).toBe('CUSTOM_CHALLENGE');
        expect(event.response.issueTokens).toBe(false);
        expect(event.response.failAuthentication).toBe(false);
    });

    test('passed OTP round issues tokens', async () => {
        const event = await handler(baseEvent([HANDSHAKE_PASS, OTP_PASS]));
        expect(event.response.issueTokens).toBe(true);
        expect(event.response.failAuthentication).toBe(false);
    });

    test('failed OTP within the limit issues a retry challenge', async () => {
        const event = await handler(baseEvent([HANDSHAKE_PASS, OTP_FAIL, OTP_FAIL]));
        expect(event.response.challengeName).toBe('CUSTOM_CHALLENGE');
        expect(event.response.issueTokens).toBe(false);
        expect(event.response.failAuthentication).toBe(false);
    });

    test('three failed OTP rounds fail authentication', async () => {
        const event = await handler(baseEvent([HANDSHAKE_PASS, OTP_FAIL, OTP_FAIL, OTP_FAIL]));
        expect(event.response.failAuthentication).toBe(true);
        expect(event.response.issueTokens).toBe(false);
    });

    test('the handshake round does not count toward the OTP attempt limit', async () => {
        // Two OTP failures plus the handshake is three session entries, but
        // only OTP rounds count, so the user still gets their third try.
        const event = await handler(baseEvent([HANDSHAKE_PASS, OTP_FAIL, OTP_FAIL]));
        expect(event.response.failAuthentication).toBe(false);
        expect(event.response.challengeName).toBe('CUSTOM_CHALLENGE');
    });

    test('a malformed session entry fails closed instead of throwing', async () => {
        // Reading challengeResult off a null round throws inside the
        // handler's try; the catch must fail authentication, not leak.
        const event = await handler(baseEvent([null]));
        expect(event.response.failAuthentication).toBe(true);
        expect(event.response.issueTokens).toBe(false);
    });
});
