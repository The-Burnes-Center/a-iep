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
const mockSsmSend = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => ({
    SSMClient: class {
        send(...args) { return mockSsmSend(...args); }
    },
    GetParameterCommand: class {
        constructor(input) { this.input = input; }
    },
}), { virtual: true });

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
            // E.164, but not a NANP number: nothing could ever text it.
            ['a +1 area code starting 0', '+10185551234'],
            ['a +1 N11 area code', '+19115551234'],
            ['a +1 exchange starting 0', '+12020551234'],
            ['a +1 number one digit short', '+1617555123'],
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

describe('Turnstile: the signup abuse control', () => {
    // This only works because it runs in the trigger. The 2026-09-09 run never
    // loaded the site, it called the public SignUp API directly, so anything
    // enforced in the browser was simply not in its path.
    const withToken = (token) => signUpEvent(
        { phone_number: PHONE },
        { request: { userAttributes: { phone_number: PHONE }, clientMetadata: { turnstileToken: token } } },
    );

    const secretIs = (value) => mockSsmSend.mockResolvedValue({ Parameter: { Value: value } });

    const verifyReturns = (body, ok = true) => {
        global.fetch = jest.fn().mockResolvedValue({
            ok,
            status: ok ? 200 : 500,
            json: async () => body,
        });
    };

    beforeEach(() => {
        jest.resetModules();
        mockSsmSend.mockReset();
        process.env.TURNSTILE_SECRET_PARAM = '/a-iep/prod/turnstile/secret';
        delete global.fetch;
    });

    afterEach(() => {
        delete process.env.TURNSTILE_SECRET_PARAM;
        delete global.fetch;
    });

    /** A fresh module, so the secret cache does not leak between cases. */
    const freshHandler = () => {
        let mod;
        jest.isolateModules(() => {
            mod = require('../../../lib/chatbot-api/functions/phone-otp-auth/pre-sign-up');
        });
        return mod.handler;
    };

    test('a valid token lets the signup through', async () => {
        secretIs('sec');
        verifyReturns({ success: true });

        const event = await freshHandler()(withToken('good-token'));

        expect(event.response.autoConfirmUser).toBe(true);
    });

    test('a missing token is refused', async () => {
        secretIs('sec');

        await expect(freshHandler()(signUpEvent({ phone_number: PHONE })))
            .rejects.toThrow(/Sign-up could not be completed/);
    });

    test('a token Cloudflare rejects is refused', async () => {
        secretIs('sec');
        verifyReturns({ success: false, 'error-codes': ['invalid-input-response'] });

        await expect(freshHandler()(withToken('forged')))
            .rejects.toThrow(/did not pass/);
    });

    test('Cloudflare being unreachable fails CLOSED', async () => {
        // The whole point. Failing open means anyone who can cause a
        // Cloudflare outage walks straight through.
        secretIs('sec');
        global.fetch = jest.fn().mockRejectedValue(new Error('network down'));

        await expect(freshHandler()(withToken('good-token')))
            .rejects.toThrow(/could not be run/);
    });

    test('a non-200 from siteverify fails CLOSED', async () => {
        secretIs('sec');
        verifyReturns({}, false);

        await expect(freshHandler()(withToken('good-token')))
            .rejects.toThrow(/could not be run/);
    });

    test('an SSM failure fails CLOSED once a secret is expected', async () => {
        mockSsmSend.mockRejectedValue(new Error('SSM unavailable'));

        await expect(freshHandler()(withToken('good-token')))
            .rejects.toThrow(/could not be run/);
    });

    test('no secret parameter yet means not configured, and signups continue', async () => {
        // The rollout state. A secret cannot live in a public repo, so the
        // parameter is created out of band; failing closed on a parameter that
        // does not exist yet would break every signup between the deploy and
        // someone remembering to create it.
        const notFound = new Error('not found');
        notFound.name = 'ParameterNotFound';
        mockSsmSend.mockRejectedValue(notFound);

        const event = await freshHandler()(signUpEvent({ phone_number: PHONE }));

        expect(event.response.autoConfirmUser).toBe(true);
    });

    test('no configured parameter name means the check is off entirely', async () => {
        delete process.env.TURNSTILE_SECRET_PARAM;

        const event = await freshHandler()(signUpEvent({ phone_number: PHONE }));

        expect(event.response.autoConfirmUser).toBe(true);
        expect(mockSsmSend).not.toHaveBeenCalled();
    });

    test('admin-created users are never challenged', async () => {
        // They never reach a browser, so a browser challenge would only ever
        // block a legitimate admin action.
        secretIs('sec');

        const event = await freshHandler()(signUpEvent(
            { phone_number: PHONE },
            { triggerSource: 'PreSignUp_AdminCreateUser' },
        ));

        expect(event.response.autoConfirmUser).toBeUndefined();
        expect(mockSsmSend).not.toHaveBeenCalled();
    });

    test('the refusal never logs the token', async () => {
        secretIs('sec');
        verifyReturns({ success: false, 'error-codes': ['invalid-input-response'] });
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(freshHandler()(withToken('secret-token-value'))).rejects.toThrow();

        const out = logged.mock.calls.map((a) => a.join(' ')).join('\n');
        expect(out).toContain('TURNSTILE_REJECTED');
        expect(out).not.toContain('secret-token-value');
        logged.mockRestore();
    });
});

// The signup flood alarm counts SIGNUP_ATTEMPT destination=reachable only. A
// fictional destination (the NANP 555-01XX block, the reserved a-iep.invalid
// domain) can never receive a message, so an account on one costs nothing and
// reaches no one, whoever created it. Counting every attempt paged a
// "flood" on 2026-10-20 that was 32 test accounts and zero texts.
describe('counting signup attempts for the flood alarm', () => {
    const markersFor = async (event) => {
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        try {
            await handler(event).catch(() => {});
            return log.mock.calls.map((args) => args.join(' '))
                .filter((line) => line.startsWith('SIGNUP_ATTEMPT'));
        } finally {
            log.mockRestore();
        }
    };

    test('a real phone number is counted as reachable, once', async () => {
        expect(await markersFor(signUpEvent({ phone_number: '+16175550123' })))
            .toEqual(['SIGNUP_ATTEMPT destination=reachable']);
    });

    test('a fictional 555-01XX number is not counted as reachable', async () => {
        expect(await markersFor(signUpEvent({ phone_number: '+15555550111' })))
            .toEqual(['SIGNUP_ATTEMPT destination=fictional']);
    });

    test('a reserved a-iep.invalid test address is not counted as reachable', async () => {
        expect(await markersFor(signUpEvent({ email: 'e2e-documents@a-iep.invalid' })))
            .toEqual(['SIGNUP_ATTEMPT destination=fictional']);
    });

    test('numbers and addresses that only look fictional are reachable', async () => {
        // 555-0200 is outside the fictional block, and a domain that merely
        // contains a-iep.invalid is a real, registrable domain.
        for (const attributes of [
            { phone_number: '+15555550200' },
            { phone_number: '+155555501111' },
            { phone_number: '+445555550111' },
            { email: 'e2e-documents@a-iep.invalid.example.com' },
            { email: 'someone@a-iep.invalid' },
        ]) {
            expect([attributes, await markersFor(signUpEvent(attributes))])
                .toEqual([attributes, ['SIGNUP_ATTEMPT destination=reachable']]);
        }
    });

    test('one reachable destination makes the whole attempt reachable', async () => {
        expect(await markersFor(signUpEvent({
            phone_number: '+15555550111',
            email: 'parent@example.com',
        }))).toEqual(['SIGNUP_ATTEMPT destination=reachable']);
    });

    test('an attempt with no destination at all is counted as reachable', async () => {
        expect(await markersFor(signUpEvent({}))).toEqual(['SIGNUP_ATTEMPT destination=reachable']);
    });

    test('admin-created accounts are counted too: the signup endpoint creates them that way', async () => {
        expect(await markersFor(signUpEvent(
            { phone_number: '+16175550123' },
            { triggerSource: 'PreSignUp_AdminCreateUser' },
        ))).toEqual(['SIGNUP_ATTEMPT destination=reachable']);
    });

    test('the marker never carries the number or the address', async () => {
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        try {
            await handler(signUpEvent({ phone_number: '+16175550123', email: 'parent@example.com' }));
            const marker = log.mock.calls.map((args) => args.join(' '))
                .find((line) => line.startsWith('SIGNUP_ATTEMPT'));
            expect(marker).not.toMatch(/6175550123|parent|example/);
        } finally {
            log.mockRestore();
        }
    });
});

describe('counting attempts the bot check refuses', () => {
    beforeEach(() => {
        jest.resetModules();
        mockSsmSend.mockReset();
        mockSsmSend.mockResolvedValue({ Parameter: { Value: 'sec' } });
        process.env.TURNSTILE_SECRET_PARAM = '/a-iep/prod/turnstile/secret';
    });

    afterEach(() => {
        delete process.env.TURNSTILE_SECRET_PARAM;
    });

    test('a refused attempt is still counted: refusals are the leading edge of a flood', async () => {
        let fresh;
        jest.isolateModules(() => {
            fresh = require('../../../lib/chatbot-api/functions/phone-otp-auth/pre-sign-up').handler;
        });
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await expect(fresh(signUpEvent({ phone_number: '+16175550123' })))
                .rejects.toThrow(/Sign-up could not be completed/);
            expect(log.mock.calls.map((args) => args.join(' ')))
                .toContain('SIGNUP_ATTEMPT destination=reachable');
        } finally {
            log.mockRestore();
            error.mockRestore();
        }
    });
});
