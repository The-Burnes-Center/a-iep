/**
 * create-auth-challenge issues the language-handshake round, then generates
 * and texts the OTP. The AWS SDK v3 modules are provided by the Lambda
 * runtime and not vendored in the repo, so they are mocked as virtual
 * modules here.
 *
 * The error-shape test is the contract from the 2026-07 OTP incident: when
 * SMS delivery fails, publicChallengeParameters.error must carry a message
 * the frontend surfaces (before the fix it was silently swallowed while the
 * UI claimed "code sent").
 *
 * The DynamoDB mock serves two consumers: messages.js resolves the user's
 * language (GetCommand on the profiles table) and the handler counts SMS
 * sends against the hourly per-phone budget (UpdateCommand on the
 * OTP_RATE_LIMIT_TABLE counter).
 *
 * The SSM mock serves the staging-only E2E backdoor: allowlisted
 * NANP-fictional numbers get their OTP written to Parameter Store instead
 * of texted (see the 'staging test-number backdoor' describe).
 */
const mockSnsSend = jest.fn();
const mockDdbSend = jest.fn();
const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-sns', () => ({
    SNSClient: class {
        send(...args) { return mockSnsSend(...args); }
    },
    PublishCommand: class {
        constructor(input) { this.input = input; }
    },
}), { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
    SSMClient: class {
        send(...args) { return mockSsmSend(...args); }
    },
    PutParameterCommand: class {
        constructor(input) { this.input = input; }
    },
}), { virtual: true });

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => {
    class GetCommand {
        constructor(input) { this.input = input; }
    }
    class UpdateCommand {
        constructor(input) { this.input = input; }
    }
    return {
        GetCommand,
        UpdateCommand,
        DynamoDBDocumentClient: { from: () => ({ send: (...args) => mockDdbSend(...args) }) },
    };
}, { virtual: true });

const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { PutParameterCommand } = require('@aws-sdk/client-ssm');
const { handler } = require('../../../lib/chatbot-api/functions/phone-otp-auth/create-auth-challenge');
const { getMessages } = require('../../../lib/chatbot-api/functions/phone-otp-auth/messages');

const PHONE = '+15555550100';

const HANDSHAKE_PASS = {
    challengeName: 'CUSTOM_CHALLENGE',
    challengeResult: true,
    challengeMetadata: 'LANGUAGE_HANDSHAKE',
};

const baseEvent = (session, extra = {}) => ({
    userName: 'test-user',
    request: { userAttributes: { phone_number: PHONE }, session, ...extra },
    response: {},
});

const otpMetadata = (code, ageMs = 0) => JSON.stringify({
    code,
    timestamp: new Date(Date.now() - ageMs).toISOString(),
    phoneNumber: PHONE,
    attempt: 2,
});

const ERROR_SHAPE = {
    error: 'Failed to send verification code. Please try again.',
};

const RATE_LIMITED_SHAPE = {
    error: 'Too many verification codes requested. Please wait an hour and try again.',
};

const updateCalls = () => mockDdbSend.mock.calls.filter(([cmd]) => cmd instanceof UpdateCommand);
// Per-phone rows are keyed by sha256(phone) + hour bucket; the global budget
// rows on the same table are keyed 'GLOBAL#...'.
const perPhoneUpdates = () => updateCalls().filter(([cmd]) => /^[0-9a-f]{64}#\d+$/.test(cmd.input.Key.pk));

describe('create-auth-challenge', () => {
    beforeEach(() => {
        mockSnsSend.mockResolvedValue({ MessageId: 'msg-1' });
        mockSsmSend.mockResolvedValue({ Version: 1 });
        // Profile lookups miss; the rate-limit counter reports a first send.
        mockDdbSend.mockImplementation(async (cmd) => {
            if (cmd instanceof UpdateCommand) return { Attributes: { smsCount: 1 } };
            return {};
        });
        process.env.OTP_RATE_LIMIT_TABLE = 'test-otp-rate-limit';
        delete process.env.USER_PROFILES_TABLE;
        // The backdoor must not exist unless a test opts in explicitly.
        delete process.env.TEST_PHONE_NUMBERS;
        delete process.env.TEST_OTP_PARAM_PREFIX;
    });

    test('round 1 is a language handshake and sends no SMS', async () => {
        const event = await handler(baseEvent([]));
        expect(event.response.publicChallengeParameters).toEqual({
            challengeType: 'LANGUAGE_HANDSHAKE',
            phone_number: PHONE,
        });
        expect(event.response.privateChallengeParameters.secretLoginCode).toBe('LANGUAGE_HANDSHAKE');
        expect(event.response.challengeMetadata).toBe('LANGUAGE_HANDSHAKE');
        expect(mockSnsSend).not.toHaveBeenCalled();
        // A round that sends nothing must not consume the SMS budget either.
        expect(mockDdbSend).not.toHaveBeenCalled();
    });

    test('round 2 generates a 6-digit OTP and texts it once', async () => {
        const event = await handler(baseEvent([HANDSHAKE_PASS]));

        const code = event.response.privateChallengeParameters.secretLoginCode;
        expect(code).toMatch(/^\d{6}$/);
        expect(mockSnsSend).toHaveBeenCalledTimes(1);

        const publish = mockSnsSend.mock.calls[0][0].input;
        expect(publish.PhoneNumber).toBe(PHONE);
        expect(publish.Message).toContain(code);
        expect(publish.MessageAttributes['AWS.SNS.SMS.SMSType'].StringValue).toBe('Transactional');
        // Was '0.50', which permitted essentially every destination on earth
        // and so bounded nothing. '0.05' clears US (~$0.006) and Canadian
        // (~$0.021) traffic with headroom while SNS itself refuses the
        // premium international routes that SMS pumping monetizes.
        expect(publish.MessageAttributes['AWS.SNS.SMS.MaxPrice'].StringValue).toBe('0.05');

        // Metadata must round-trip for the reuse/expiry logic downstream.
        const metadata = JSON.parse(event.response.challengeMetadata);
        expect(metadata.code).toBe(code);
        expect(metadata.attempt).toBe(2);
        expect(new Date(metadata.timestamp).getTime()).not.toBeNaN();
        // verify-auth-challenge enforces the 5-minute expiry from this stamp
        // (it never sees the session array, so it must ride here).
        expect(event.response.privateChallengeParameters.issuedAt).toBe(metadata.timestamp);
        expect(event.response.publicChallengeParameters).toEqual({ phone_number: PHONE });
    });

    test('the OTP SMS is localized from RespondToAuthChallenge clientMetadata', async () => {
        const event = await handler(baseEvent([HANDSHAKE_PASS], { clientMetadata: { language: 'es' } }));
        const code = event.response.privateChallengeParameters.secretLoginCode;
        const expected = getMessages('es').otpLoginSms.replace('{code}', code).replace('{minutes}', 5);
        expect(mockSnsSend.mock.calls[0][0].input.Message).toBe(expected);
    });

    test('falls back to English when no language is resolvable', async () => {
        const event = await handler(baseEvent([HANDSHAKE_PASS]));
        const code = event.response.privateChallengeParameters.secretLoginCode;
        const expected = getMessages('en').otpLoginSms.replace('{code}', code).replace('{minutes}', 5);
        expect(mockSnsSend.mock.calls[0][0].input.Message).toBe(expected);
    });

    test('reuses the previous OTP inside the 5-minute window without re-texting', async () => {
        const previous = otpMetadata('654321', 60 * 1000);
        const event = await handler(baseEvent([HANDSHAKE_PASS, {
            challengeName: 'CUSTOM_CHALLENGE',
            challengeResult: false,
            challengeMetadata: previous,
        }]));
        expect(event.response.privateChallengeParameters.secretLoginCode).toBe('654321');
        expect(mockSnsSend).not.toHaveBeenCalled();

        // The reuse round must carry the ORIGINAL issuance stamp: re-stamping
        // would slide the expiry window on every retry. And a round that
        // texts nothing must not consume the SMS budget.
        const originalTimestamp = JSON.parse(previous).timestamp;
        expect(event.response.privateChallengeParameters.issuedAt).toBe(originalTimestamp);
        expect(JSON.parse(event.response.challengeMetadata).timestamp).toBe(originalTimestamp);
        expect(updateCalls()).toHaveLength(0);
    });

    test('generates and texts a fresh OTP once the previous one expired', async () => {
        const event = await handler(baseEvent([HANDSHAKE_PASS, {
            challengeName: 'CUSTOM_CHALLENGE',
            challengeResult: false,
            challengeMetadata: otpMetadata('654321', 6 * 60 * 1000),
        }]));
        expect(event.response.privateChallengeParameters.secretLoginCode).not.toBe('654321');
        expect(event.response.privateChallengeParameters.secretLoginCode).toMatch(/^\d{6}$/);
        expect(mockSnsSend).toHaveBeenCalledTimes(1);
    });

    test('each fresh OTP counts against the per-phone AND both global budgets', async () => {
        await handler(baseEvent([HANDSHAKE_PASS]));

        // Selected by key shape, not by index: the per-phone row is no longer
        // the only counter, and asserting on ordering would make this test
        // fail for a reason that has nothing to do with what it checks.
        const keys = updateCalls().map(([cmd]) => cmd.input.Key.pk);
        const perPhone = keys.filter((pk) => /^[0-9a-f]{64}#\d+$/.test(pk));

        expect(perPhone).toHaveLength(1);
        expect(keys).toEqual(expect.arrayContaining([
            expect.stringMatching(/^GLOBAL#H#\d+$/),
            expect.stringMatching(/^GLOBAL#D#\d+$/),
        ]));

        for (const [cmd] of updateCalls()) {
            const { TableName, UpdateExpression, Key } = cmd.input;
            expect(TableName).toBe('test-otp-rate-limit');
            expect(UpdateExpression).toContain('ADD smsCount');
            // Raw numbers never hit the table, on any row.
            expect(Key.pk).not.toContain(PHONE.slice(1));
        }
    });

    test('an exhausted SMS budget blocks the send with the rate-limit error shape', async () => {
        mockDdbSend.mockImplementation(async (cmd) => {
            if (cmd instanceof UpdateCommand) return { Attributes: { smsCount: 6 } };
            return {};
        });
        const event = await handler(baseEvent([HANDSHAKE_PASS]));
        expect(mockSnsSend).not.toHaveBeenCalled();
        expect(event.response.publicChallengeParameters).toEqual(RATE_LIMITED_SHAPE);
        expect(event.response.privateChallengeParameters.secretLoginCode).toBe('ERROR');
    });

    test('the budget boundary: the 5th send of the hour still goes out', async () => {
        mockDdbSend.mockImplementation(async (cmd) => {
            if (cmd instanceof UpdateCommand) return { Attributes: { smsCount: 5 } };
            return {};
        });
        const event = await handler(baseEvent([HANDSHAKE_PASS]));
        expect(mockSnsSend).toHaveBeenCalledTimes(1);
        expect(event.response.privateChallengeParameters.secretLoginCode).toMatch(/^\d{6}$/);
    });

    // Inverted deliberately, and this is the sharpest trade-off in the file.
    // It used to assert the SMS still goes out during a DynamoDB outage, on
    // the reasoning that an outage must not lock everyone out of login. The
    // global budget now fails CLOSED, so it does lock login. That is the
    // right way round: an unmetered send window is what 2026-09-09 cost, and
    // DynamoDB already holds the profiles and documents the whole app runs
    // on, so during its outage there is no working product to log in to. A
    // DynamoDB outage costs minutes; a drained SNS budget costs every family
    // their login until the calendar month rolls over.
    test('a DynamoDB outage fails CLOSED: no unmetered SMS goes out', async () => {
        mockDdbSend.mockImplementation(async (cmd) => {
            if (cmd instanceof UpdateCommand) throw new Error('DynamoDB unavailable');
            return {};
        });
        const event = await handler(baseEvent([HANDSHAKE_PASS]));
        expect(mockSnsSend).not.toHaveBeenCalled();
        expect(event.response.privateChallengeParameters.secretLoginCode).toBe('ERROR');
        expect(event.response.publicChallengeParameters).toEqual({
            error: 'Text messaging is temporarily unavailable. Please try again in a little while.',
        });
    });

    // This pin was inverted deliberately. It used to assert that a missing
    // table still texts, which was true of the per-phone limiter alone. The
    // global budget now runs first and fails CLOSED, so an unmetered send is
    // no longer reachable: without the counter there is nothing bounding
    // spend, and 2026-09-09 is what unbounded spend costs. CDK always sets
    // this env var on both stacks, so a missing table is a deploy fault and
    // should be loud rather than quietly unmetered.
    test('no rate-limit table configured refuses to send rather than texting unmetered', async () => {
        delete process.env.OTP_RATE_LIMIT_TABLE;
        const event = await handler(baseEvent([HANDSHAKE_PASS]));
        expect(updateCalls()).toHaveLength(0);
        expect(mockSnsSend).not.toHaveBeenCalled();
        expect(event.response.privateChallengeParameters.secretLoginCode).toBe('ERROR');
    });

    test('SNS failure produces the error challenge shape instead of throwing', async () => {
        mockSnsSend.mockRejectedValue(new Error('SNS is down'));
        const event = await handler(baseEvent([HANDSHAKE_PASS]));
        expect(event.response.publicChallengeParameters).toEqual(ERROR_SHAPE);
        expect(event.response.privateChallengeParameters.secretLoginCode).toBe('ERROR');
        expect(JSON.parse(event.response.challengeMetadata).error).toBe('SNS is down');
    });

    test('a phone number not in E.164 format is rejected before any SMS', async () => {
        const event = await handler(baseEvent([HANDSHAKE_PASS], { userAttributes: { phone_number: '5551234567' } }));
        expect(event.response.publicChallengeParameters).toEqual(ERROR_SHAPE);
        expect(mockSnsSend).not.toHaveBeenCalled();
    });

    test('a missing phone number is rejected before any SMS', async () => {
        const event = await handler(baseEvent([HANDSHAKE_PASS], { userAttributes: {} }));
        expect(event.response.publicChallengeParameters).toEqual(ERROR_SHAPE);
        expect(event.response.privateChallengeParameters.secretLoginCode).toBe('ERROR');
        expect(mockSnsSend).not.toHaveBeenCalled();
    });

    describe('global SMS budget', () => {
        // The control that bounds total spend. The per-phone limiter cannot:
        // on 2026-09-09, 1,024 numbers each used once meant it never fired.
        //
        // It is sized to bind BEFORE the account's SNS monthly cap, because
        // SNS does not throw once that cap is hit. Publish returns a
        // MessageId and drops the message, so the handler logs success and a
        // parent is told a code is coming that will never arrive. Refusing
        // here is what turns a silent drop into an error someone can act on.
        const BUDGET_SHAPE = {
            error: 'Text messaging is temporarily unavailable. Please try again in a little while.',
        };

        // Counts every UpdateCommand for a given key prefix as its own window,
        // so the hourly and daily ceilings can be driven independently.
        const countsBy = (counts) => {
            mockDdbSend.mockImplementation(async (cmd) => {
                if (!(cmd instanceof UpdateCommand)) return {};
                const pk = cmd.input.Key.pk;
                const match = Object.keys(counts).find((prefix) => pk.startsWith(prefix));
                return { Attributes: { smsCount: match ? counts[match] : 1 } };
            });
        };

        afterEach(() => {
            delete process.env.MAX_SMS_PER_HOUR_GLOBAL;
            delete process.env.MAX_SMS_PER_DAY_GLOBAL;
        });

        test('the hourly ceiling stops a run that never repeats a number', async () => {
            // The exact 2026-09-09 shape: a first-ever send for this phone, so
            // the per-phone counter reads 1 and would happily allow it.
            countsBy({ 'GLOBAL#H#': 101, 'GLOBAL#D#': 101 });

            const event = await handler(baseEvent([HANDSHAKE_PASS]));

            expect(mockSnsSend).not.toHaveBeenCalled();
            expect(event.response.publicChallengeParameters).toEqual(BUDGET_SHAPE);
            expect(event.response.privateChallengeParameters.secretLoginCode).toBe('ERROR');
        });

        test('the daily ceiling stops a run spread thin enough to clear the hourly one', async () => {
            countsBy({ 'GLOBAL#H#': 5, 'GLOBAL#D#': 201 });

            const event = await handler(baseEvent([HANDSHAKE_PASS]));

            expect(mockSnsSend).not.toHaveBeenCalled();
            expect(event.response.publicChallengeParameters).toEqual(BUDGET_SHAPE);
        });

        test('the boundary: the 100th hourly and 200th daily send still go out', async () => {
            countsBy({ 'GLOBAL#H#': 100, 'GLOBAL#D#': 200 });

            const event = await handler(baseEvent([HANDSHAKE_PASS]));

            expect(mockSnsSend).toHaveBeenCalledTimes(1);
            expect(event.response.privateChallengeParameters.secretLoginCode).toMatch(/^\d{6}$/);
        });

        test('the ceilings are overridable for incident response', async () => {
            process.env.MAX_SMS_PER_HOUR_GLOBAL = '3';
            countsBy({ 'GLOBAL#H#': 4, 'GLOBAL#D#': 4 });

            const event = await handler(baseEvent([HANDSHAKE_PASS]));

            expect(mockSnsSend).not.toHaveBeenCalled();
            expect(event.response.publicChallengeParameters).toEqual(BUDGET_SHAPE);
        });

        test('an unparseable override falls back to the compiled ceiling, it does not disable it', async () => {
            process.env.MAX_SMS_PER_HOUR_GLOBAL = 'unlimited';
            countsBy({ 'GLOBAL#H#': 101, 'GLOBAL#D#': 101 });

            const event = await handler(baseEvent([HANDSHAKE_PASS]));

            expect(mockSnsSend).not.toHaveBeenCalled();
            expect(event.response.publicChallengeParameters).toEqual(BUDGET_SHAPE);
        });

        test('the global counters carry a TTL so a spent window expires', async () => {
            await handler(baseEvent([HANDSHAKE_PASS]));

            const globals = updateCalls().filter(([cmd]) => cmd.input.Key.pk.startsWith('GLOBAL#'));
            expect(globals).toHaveLength(2);
            for (const [cmd] of globals) {
                expect(cmd.input.ExpressionAttributeValues[':expiry'])
                    .toBeGreaterThan(Math.floor(Date.now() / 1000));
            }
        });

        test('the backdoor test path draws on no budget, because it sends no SMS', async () => {
            process.env.TEST_PHONE_NUMBERS = '+15555550111';
            process.env.TEST_OTP_PARAM_PREFIX = '/a-iep/staging/e2e-otp';
            countsBy({ 'GLOBAL#H#': 101, 'GLOBAL#D#': 101 });

            const event = await handler(
                baseEvent([HANDSHAKE_PASS], { userAttributes: { phone_number: '+15555550111' } })
            );

            expect(updateCalls()).toHaveLength(0);
            expect(mockSsmSend).toHaveBeenCalledTimes(1);
            expect(event.response.privateChallengeParameters.secretLoginCode).toMatch(/^\d{6}$/);
        });
    });

    describe('destination allowlist', () => {
        // The control that stops SMS-pumping fraud. On 2026-09-09 an attacker
        // texted 1,024 numbers, each exactly once, across a dozen high-cost
        // country codes; MAX_SMS_PER_HOUR never fired because it keys on a
        // single phone number, and the account's $50 monthly SNS budget was
        // gone in 13 minutes, taking login down in prod AND staging.
        //
        // Every test here asserts the thing that must NOT happen: no SNS
        // publish, and no draw on the rate-limit counter.
        const TANZANIA = '+255712345678';

        const eventTo = (phone, session = [HANDSHAKE_PASS]) =>
            baseEvent(session, { userAttributes: { phone_number: phone } });

        afterEach(() => {
            delete process.env.SMS_ALLOWED_COUNTRY_CODES;
        });

        test('a non-+1 destination is refused before SNS or the rate-limit counter', async () => {
            const event = await handler(eventTo(TANZANIA));

            expect(mockSnsSend).not.toHaveBeenCalled();
            expect(updateCalls()).toHaveLength(0);
            expect(event.response.privateChallengeParameters.secretLoginCode).toBe('ERROR');
        });

        test('the refusal tells the caller why, rather than "try again"', async () => {
            const event = await handler(eventTo(TANZANIA));

            // Retrying an unsupported country never succeeds, so the generic
            // failure copy would be a lie.
            expect(event.response.publicChallengeParameters).toEqual({
                error: 'This phone number is not supported. A-IEP can only send codes to United States numbers.',
            });
        });

        test('an unset env var fails CLOSED to +1, it does not allow everything', async () => {
            delete process.env.SMS_ALLOWED_COUNTRY_CODES;

            const blocked = await handler(eventTo(TANZANIA));
            expect(mockSnsSend).not.toHaveBeenCalled();
            expect(blocked.response.privateChallengeParameters.secretLoginCode).toBe('ERROR');

            const allowed = await handler(eventTo(PHONE));
            expect(mockSnsSend).toHaveBeenCalledTimes(1);
            expect(allowed.response.privateChallengeParameters.secretLoginCode).toMatch(/^\d{6}$/);
        });

        test('an empty or whitespace env var also fails CLOSED to +1', async () => {
            process.env.SMS_ALLOWED_COUNTRY_CODES = ' , ';

            const blocked = await handler(eventTo(TANZANIA));
            expect(mockSnsSend).not.toHaveBeenCalled();
            expect(blocked.response.privateChallengeParameters.secretLoginCode).toBe('ERROR');

            const allowed = await handler(eventTo(PHONE));
            expect(mockSnsSend).toHaveBeenCalledTimes(1);
        });

        test('the allowlist is configurable, so a new country needs no code change', async () => {
            process.env.SMS_ALLOWED_COUNTRY_CODES = '+1, +255';

            const event = await handler(eventTo(TANZANIA));

            expect(mockSnsSend).toHaveBeenCalledTimes(1);
            expect(mockSnsSend.mock.calls[0][0].input.PhoneNumber).toBe(TANZANIA);
            expect(event.response.privateChallengeParameters.secretLoginCode).toMatch(/^\d{6}$/);
        });

        test('narrowing the allowlist blocks even the E2E backdoor number', async () => {
            // The check sits ahead of the isTestNumber branch on purpose, so
            // the allowlist still holds if the fictional-block regex widens.
            process.env.TEST_PHONE_NUMBERS = '+15555550111';
            process.env.TEST_OTP_PARAM_PREFIX = '/a-iep/staging/e2e-otp';
            process.env.SMS_ALLOWED_COUNTRY_CODES = '+44';

            const event = await handler(eventTo('+15555550111'));

            expect(mockSnsSend).not.toHaveBeenCalled();
            expect(mockSsmSend).not.toHaveBeenCalled();
            expect(event.response.privateChallengeParameters.secretLoginCode).toBe('ERROR');
        });

        test('the refusal logs the country code but never the full number', async () => {
            const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

            await handler(eventTo(TANZANIA));

            const messages = logged.mock.calls.map((args) => args.join(' ')).join('\n');
            expect(messages).toContain('+255');
            expect(messages).not.toContain(TANZANIA);
            logged.mockRestore();
        });

        test('the language handshake round is unaffected: it sends nothing anyway', async () => {
            const event = await handler(eventTo(TANZANIA, []));

            expect(event.response.challengeMetadata).toBe('LANGUAGE_HANDSHAKE');
            expect(mockSnsSend).not.toHaveBeenCalled();
        });
    });

    describe('staging test-number backdoor', () => {
        // Staging (lib/authorization/new-auth.ts) allowlists NANP-fictional
        // numbers whose OTPs are stashed in SSM Parameter Store for the E2E
        // runner instead of texted. Both locks are exercised here: the env
        // var allowlist AND the hard-coded fictional-block regex. The
        // allowlist below carries stray spaces on purpose (entries must be
        // trimmed) and omits the smoke user +15555550101 (smoke asserts the
        // real, non-backdoored SMS contract).
        const TEST_PHONE = '+15555550111';
        const PARAM_PREFIX = '/a-iep/staging/test-otp';

        const armBackdoor = () => {
            process.env.TEST_PHONE_NUMBERS = ' +15555550111 , +15555550112';
            process.env.TEST_OTP_PARAM_PREFIX = PARAM_PREFIX;
        };

        const eventFor = (phone, extra = {}) =>
            baseEvent([HANDSHAKE_PASS], { userAttributes: { phone_number: phone }, ...extra });

        test('an allowlisted fictional number gets its OTP stashed in SSM, never texted', async () => {
            armBackdoor();
            const event = await handler(eventFor(TEST_PHONE, { clientMetadata: { language: 'es' } }));

            // No SMS, and no draw on the hourly SMS budget: the rate-limit
            // counter meters SMS spend and nothing was transmitted.
            expect(mockSnsSend).not.toHaveBeenCalled();
            expect(updateCalls()).toHaveLength(0);

            expect(mockSsmSend).toHaveBeenCalledTimes(1);
            const put = mockSsmSend.mock.calls[0][0];
            expect(put).toBeInstanceOf(PutParameterCommand);
            // SSM parameter names forbid '+', so the E.164 prefix is
            // stripped; the E2E runner reads the same '+'-less name.
            expect(put.input.Name).toBe(`${PARAM_PREFIX}/15555550111`);
            expect(put.input.Type).toBe('String');
            expect(put.input.Overwrite).toBe(true);

            // The stash must carry the exact code the verify round will
            // accept, plus the resolved language and the issuance stamp.
            const payload = JSON.parse(put.input.Value);
            expect(payload.code).toBe(event.response.privateChallengeParameters.secretLoginCode);
            expect(payload.code).toMatch(/^\d{6}$/);
            expect(payload.language).toBe('es');
            expect(payload.issuedAt).toBe(event.response.privateChallengeParameters.issuedAt);
        });

        test('an allowlisted but NON-fictional number is still texted (the regex is the second lock)', async () => {
            // A lying/compromised allowlist must never divert a real
            // subscriber's OTP into Parameter Store.
            process.env.TEST_PHONE_NUMBERS = '+15551234567';
            process.env.TEST_OTP_PARAM_PREFIX = PARAM_PREFIX;
            const event = await handler(eventFor('+15551234567'));

            expect(mockSsmSend).not.toHaveBeenCalled();
            expect(mockSnsSend).toHaveBeenCalledTimes(1);
            expect(mockSnsSend.mock.calls[0][0].input.PhoneNumber).toBe('+15551234567');
            // The real send pays the SMS budget as usual: the per-phone
            // counter, plus the two global windows.
            expect(perPhoneUpdates()).toHaveLength(1);
            expect(updateCalls()).toHaveLength(3);
            expect(event.response.privateChallengeParameters.secretLoginCode).toMatch(/^\d{6}$/);
        });

        test('a fictional number outside the allowlist takes the normal SMS path (the smoke users)', async () => {
            armBackdoor();
            // +15555550101 is the permanent staging smoke user: fictional but
            // deliberately not allowlisted, so smoke exercises the real path.
            const event = await handler(eventFor('+15555550101'));

            expect(mockSsmSend).not.toHaveBeenCalled();
            expect(mockSnsSend).toHaveBeenCalledTimes(1);
            expect(event.response.privateChallengeParameters.secretLoginCode).toMatch(/^\d{6}$/);
        });

        test('with no backdoor env vars (production) even a fictional number is texted normally', async () => {
            // beforeEach deleted both env vars; this is the production shape.
            const event = await handler(eventFor(TEST_PHONE));

            expect(mockSsmSend).not.toHaveBeenCalled();
            expect(mockSnsSend).toHaveBeenCalledTimes(1);
            expect(perPhoneUpdates()).toHaveLength(1);
            expect(updateCalls()).toHaveLength(3);
            expect(event.response.privateChallengeParameters.secretLoginCode).toMatch(/^\d{6}$/);
        });

        test('an allowlisted number with no TEST_OTP_PARAM_PREFIX fails loud with the error shape', async () => {
            process.env.TEST_PHONE_NUMBERS = TEST_PHONE;
            // TEST_OTP_PARAM_PREFIX deliberately unset: misconfiguration must
            // fail the round, not silently text a fictional number.
            const event = await handler(eventFor(TEST_PHONE));

            expect(event.response.publicChallengeParameters).toEqual(ERROR_SHAPE);
            expect(event.response.privateChallengeParameters.secretLoginCode).toBe('ERROR');
            expect(mockSnsSend).not.toHaveBeenCalled();
            expect(mockSsmSend).not.toHaveBeenCalled();
        });

        test('an SSM write failure surfaces the same error shape as an SNS failure', async () => {
            armBackdoor();
            mockSsmSend.mockRejectedValue(new Error('SSM is down'));
            const event = await handler(eventFor(TEST_PHONE));

            expect(event.response.publicChallengeParameters).toEqual(ERROR_SHAPE);
            expect(event.response.privateChallengeParameters.secretLoginCode).toBe('ERROR');
            expect(mockSnsSend).not.toHaveBeenCalled();
        });
    });
});
