/**
 * pre-sign-up decides whether a brand-new account skips Cognito's own signup
 * verification code, which is what collapses phone signup from two SMS to one.
 *
 * The security-relevant assertions here are the NEGATIVE ones: an email signup
 * must never be auto-confirmed (the emailed code is the only proof that anyone
 * owns that address), and autoVerifyEmail must never be set on any path. A
 * phone signup is safe to auto-confirm only because the login OTP still proves
 * possession on every sign-in AND because cognito_trigger.py rotates the
 * client-chosen password away in PostConfirmation.
 */
const { handler } = require('../../../lib/chatbot-api/functions/phone-otp-auth/pre-sign-up');

const PHONE = '+15555550111';

const signUpEvent = (userAttributes, overrides = {}) => ({
    userName: 'test-user',
    triggerSource: 'PreSignUp_SignUp',
    request: { userAttributes, validationData: {} },
    response: {},
    ...overrides,
});

describe('pre-sign-up', () => {
    describe('phone-only self-service signup', () => {
        test('auto-confirms the account and verifies the phone', async () => {
            const event = await handler(signUpEvent({ phone_number: PHONE }));

            expect(event.response.autoConfirmUser).toBe(true);
            expect(event.response.autoVerifyPhone).toBe(true);
        });

        test('never auto-verifies an email address it was not given', async () => {
            const event = await handler(signUpEvent({ phone_number: PHONE }));

            expect(event.response.autoVerifyEmail).toBeUndefined();
        });

        test('accepts a non-US E.164 number', async () => {
            const event = await handler(signUpEvent({ phone_number: '+442071234567' }));

            expect(event.response.autoConfirmUser).toBe(true);
        });
    });

    describe('signups that must keep the standard confirmation flow', () => {
        test('an email signup is not auto-confirmed', async () => {
            // The emailed code is the ONLY ownership proof for an email
            // account, so skipping it would let anyone register any address.
            const event = await handler(signUpEvent({ email: 'parent@example.com' }));

            expect(event.response.autoConfirmUser).toBeUndefined();
            expect(event.response.autoVerifyEmail).toBeUndefined();
            expect(event.response.autoVerifyPhone).toBeUndefined();
        });

        test('a signup carrying BOTH email and phone is not auto-confirmed', async () => {
            const event = await handler(signUpEvent({ email: 'parent@example.com', phone_number: PHONE }));

            expect(event.response.autoConfirmUser).toBeUndefined();
            expect(event.response.autoVerifyEmail).toBeUndefined();
        });

        test('an admin-created user is not auto-confirmed', async () => {
            const event = await handler(
                signUpEvent({ phone_number: PHONE }, { triggerSource: 'PreSignUp_AdminCreateUser' })
            );

            expect(event.response.autoConfirmUser).toBeUndefined();
        });

        test('a federated user is not auto-confirmed', async () => {
            const event = await handler(
                signUpEvent({ phone_number: PHONE }, { triggerSource: 'PreSignUp_ExternalProvider' })
            );

            expect(event.response.autoConfirmUser).toBeUndefined();
        });

        test('a signup with no phone number is not auto-confirmed', async () => {
            const event = await handler(signUpEvent({}));

            expect(event.response.autoConfirmUser).toBeUndefined();
        });

        test.each([
            ['not E.164 (no plus)', '15555550111'],
            ['letters', '+1555555phone'],
            ['too short', '+1555'],
            ['leading zero after the plus', '+05555550111'],
            ['blank', '   '],
        ])('a phone number that is %s is not auto-confirmed', async (_label, phone_number) => {
            const event = await handler(signUpEvent({ phone_number }));

            expect(event.response.autoConfirmUser).toBeUndefined();
        });
    });

    describe('failure handling', () => {
        test('a malformed event returns without throwing and without confirming', async () => {
            // Cognito fails the whole signup if this trigger throws, so the
            // handler must swallow and fall back to the two-code flow.
            const event = await handler({ triggerSource: 'PreSignUp_SignUp', response: {} });

            expect(event.response.autoConfirmUser).toBeUndefined();
        });

        test('returns the event object Cognito needs back', async () => {
            const input = signUpEvent({ phone_number: PHONE });
            const output = await handler(input);

            expect(output).toBe(input);
        });
    });

    describe('logging', () => {
        test('the phone number is redacted from logs', async () => {
            const logged = [];
            const spy = jest.spyOn(console, 'log').mockImplementation((...args) => {
                logged.push(args.join(' '));
            });

            try {
                await handler(signUpEvent({ phone_number: PHONE }));
            } finally {
                spy.mockRestore();
            }

            expect(logged.join('\n')).not.toContain(PHONE);
        });

        test('a refusal to auto-confirm says why', async () => {
            // An unlogged skip here would make "why did this user get two
            // texts?" undiagnosable.
            const logged = [];
            const spy = jest.spyOn(console, 'log').mockImplementation((...args) => {
                logged.push(args.join(' '));
            });

            try {
                await handler(signUpEvent({ email: 'parent@example.com' }));
            } finally {
                spy.mockRestore();
            }

            expect(logged.join('\n')).toMatch(/Not auto-confirming .*email/);
        });
    });
});
