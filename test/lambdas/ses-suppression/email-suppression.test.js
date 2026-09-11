/**
 * The send side: the do-not-email check, the two ceilings, and the one
 * function every SendEmail has to go through.
 *
 * Lives under test/lambdas/ses-suppression/ with the rest of the suppression
 * work, though the module it exercises ships in the phone-otp-auth asset.
 *
 * The tests that earn their keep here are the direction-of-failure ones. Each
 * control fails a specific way on purpose and the reasoning is in the
 * module's docblock; flipping any of them looks harmless in a diff:
 *
 *   suppression check      CLOSED  mailing a known-bad address is how the
 *                                  identity gets suspended
 *   global ceiling         CLOSED  an unmetered window is unbounded
 *   per-recipient ceiling  OPEN    a DynamoDB blip must not lock everyone out
 */
const mockDdbSend = jest.fn();

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

const {
    EMAIL_MARKERS,
    MAX_EMAILS_PER_RECIPIENT_PER_HOUR,
    MAX_EMAILS_PER_HOUR_GLOBAL,
    MAX_EMAILS_PER_DAY_GLOBAL,
    addressKey,
    assertNotSuppressed,
    enforceGlobalEmailBudget,
    enforceEmailRateLimit,
    buildOtpEmailParams,
    isDeliberateEmailRefusal,
    reportEmailSendFailure,
} = require('../../../lib/chatbot-api/functions/phone-otp-auth/email-suppression');

const SUPPRESSION_TABLE = 'email-suppression-test';
const RATE_TABLE = 'otp-rate-limit-test';
const ADDRESS = 'parent@example.com';

const inputs = () => mockDdbSend.mock.calls.map(([command]) => command.input);
const loggedErrors = () => errorSpy.mock.calls.map((args) => args.join(' ')).join('\n');

let errorSpy;
let warnSpy;

beforeEach(() => {
    mockDdbSend.mockReset();
    process.env.EMAIL_SUPPRESSION_TABLE = SUPPRESSION_TABLE;
    process.env.OTP_RATE_LIMIT_TABLE = RATE_TABLE;
    process.env.SES_CONFIGURATION_SET = 'a-iep-auth-staging';
    process.env.SES_FROM_ADDRESS = 'no-reply@a-iep.org';
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
});

// ── The markers ─────────────────────────────────────────────────────────

describe('the markers are the literals the metric filters read', () => {
    // Written out rather than compared to the constant: a metric filter in
    // lib/chatbot-api/email/email-identity.ts matches these exact strings and
    // nothing else connects the two. Reword one end and the alarm goes quiet.
    test('every marker string is pinned', () => {
        expect(EMAIL_MARKERS).toEqual({
            SUPPRESSED_DESTINATION: 'EMAIL_SUPPRESSED_DESTINATION',
            SUPPRESSION_UNAVAILABLE: 'EMAIL_SUPPRESSION_UNAVAILABLE',
            BUDGET_EXHAUSTED: 'EMAIL_BUDGET_EXHAUSTED',
            SEND_FAILED: 'EMAIL_SEND_FAILED',
        });
    });
});

// ── The do-not-email check ──────────────────────────────────────────────

describe('an address on the list is refused', () => {
    test('a suppressed row refuses, and says so in the marker', async () => {
        mockDdbSend.mockResolvedValue({
            Item: { addressHash: addressKey(ADDRESS), suppressedAt: '2026-09-01T00:00:00Z', reason: 'complaint' },
        });

        await expect(assertNotSuppressed(ADDRESS)).rejects.toThrow(/cannot send codes/);
        expect(loggedErrors()).toContain('EMAIL_SUPPRESSED_DESTINATION');
        expect(loggedErrors()).toContain('domain=example.com');
    });

    test('the refusal is a deliberate one, so it never counts as a broken send', async () => {
        mockDdbSend.mockResolvedValue({ Item: { suppressedAt: '2026-09-01T00:00:00Z' } });

        const error = await assertNotSuppressed(ADDRESS).catch((e) => e);
        expect(isDeliberateEmailRefusal(error)).toBe(true);
    });

    test('the address itself never reaches the log', async () => {
        mockDdbSend.mockResolvedValue({ Item: { suppressedAt: '2026-09-01T00:00:00Z' } });

        await assertNotSuppressed('Someone.Specific@school-district.example').catch(() => {});

        expect(loggedErrors()).toContain('school-district.example');
        expect(loggedErrors().toLowerCase()).not.toContain('someone.specific');
    });
});

describe('an address not on the list is allowed through', () => {
    test('no row means no suppression', async () => {
        mockDdbSend.mockResolvedValue({});

        await expect(assertNotSuppressed(ADDRESS)).resolves.toBeUndefined();
    });

    // A row exists for every transient-bounce tally too. A count is not a
    // decision, and treating it as one would lock out a parent whose inbox
    // was full twice.
    test('a transient-bounce tally is not a suppression', async () => {
        mockDdbSend.mockResolvedValue({ Item: { addressHash: 'x', transientBounces: 2, expiresAt: 1 } });

        await expect(assertNotSuppressed(ADDRESS)).resolves.toBeUndefined();
    });

    test('the lookup is by hash, strongly consistent, and names no address', async () => {
        mockDdbSend.mockResolvedValue({});

        await assertNotSuppressed(ADDRESS);

        const [read] = inputs();
        expect(read.TableName).toBe(SUPPRESSION_TABLE);
        expect(read.Key).toEqual({ addressHash: addressKey(ADDRESS) });
        // An eventually-consistent read here is a message we promised never
        // to send, sent because the write had not landed yet.
        expect(read.ConsistentRead).toBe(true);
        expect(JSON.stringify(read)).not.toContain('parent@example.com');
    });
});

describe('the do-not-email check fails CLOSED', () => {
    // The single most important direction in this file. Mailing an address
    // SES has already told us is bad is how the identity gets suspended, and
    // a suspension ends email sign-in for every family until AWS accepts an
    // appeal. One parent retrying is the cheaper failure by a wide margin.
    test('a DynamoDB error refuses the send', async () => {
        mockDdbSend.mockRejectedValue(Object.assign(new Error('throttled'), {
            name: 'ProvisionedThroughputExceededException',
        }));

        await expect(assertNotSuppressed(ADDRESS)).rejects.toThrow(/temporarily unavailable/);
        expect(loggedErrors()).toContain('EMAIL_SUPPRESSION_UNAVAILABLE');
        expect(loggedErrors()).toContain('reason=lookup-failed');
    });

    test('a missing table refuses rather than skipping the check', async () => {
        delete process.env.EMAIL_SUPPRESSION_TABLE;

        await expect(assertNotSuppressed(ADDRESS)).rejects.toThrow(/temporarily unavailable/);
        expect(loggedErrors()).toContain('EMAIL_SUPPRESSION_UNAVAILABLE');
        expect(loggedErrors()).toContain('reason=no-table');
        expect(mockDdbSend).not.toHaveBeenCalled();
    });

    test('an empty address never reaches SES', async () => {
        await expect(assertNotSuppressed('  ')).rejects.toThrow();
    });

    // The parent did nothing wrong and we do not currently know whether their
    // address is fine, so the copy must not blame it.
    test('the copy does not tell a parent their address is bad', async () => {
        delete process.env.EMAIL_SUPPRESSION_TABLE;

        const error = await assertNotSuppressed(ADDRESS).catch((e) => e);
        expect(error.message).not.toMatch(/address/i);
        expect(error.message).toMatch(/try again/i);
    });
});

// ── The global ceiling ──────────────────────────────────────────────────

describe('the service-wide ceiling', () => {
    test('an ordinary send counts against both windows and passes', async () => {
        mockDdbSend.mockResolvedValue({ Attributes: { emailCount: 1 } });

        await expect(enforceGlobalEmailBudget()).resolves.toBeUndefined();

        const keys = inputs().map((i) => i.Key.pk);
        expect(keys).toHaveLength(2);
        expect(keys[0]).toMatch(/^EMAIL#GLOBAL#H#\d+$/);
        expect(keys[1]).toMatch(/^EMAIL#GLOBAL#D#\d+$/);
    });

    // Email and SMS must never draw on each other's budget: a busy SMS hour
    // would otherwise silently close email sign-in, and vice versa.
    test('the counters are keyed and named apart from the SMS ones', async () => {
        mockDdbSend.mockResolvedValue({ Attributes: { emailCount: 1 } });

        await enforceGlobalEmailBudget();

        for (const input of inputs()) {
            expect(input.TableName).toBe(RATE_TABLE);
            expect(input.UpdateExpression).toContain('ADD emailCount :one');
            expect(input.UpdateExpression).not.toContain('smsCount');
            expect(input.Key.pk.startsWith('EMAIL#')).toBe(true);
        }
    });

    test('past the hourly ceiling it refuses, loudly', async () => {
        mockDdbSend.mockResolvedValue({ Attributes: { emailCount: MAX_EMAILS_PER_HOUR_GLOBAL + 1 } });

        await expect(enforceGlobalEmailBudget()).rejects.toThrow(/temporarily unavailable/);
        expect(loggedErrors()).toContain('EMAIL_BUDGET_EXHAUSTED window=hourly reason=ceiling');
    });

    test('past the daily ceiling it refuses too', async () => {
        mockDdbSend.mockResolvedValueOnce({ Attributes: { emailCount: 1 } });
        mockDdbSend.mockResolvedValueOnce({ Attributes: { emailCount: MAX_EMAILS_PER_DAY_GLOBAL + 1 } });

        await expect(enforceGlobalEmailBudget()).rejects.toThrow();
        expect(loggedErrors()).toContain('EMAIL_BUDGET_EXHAUSTED window=daily reason=ceiling');
    });

    test('exactly at the ceiling is still allowed', async () => {
        mockDdbSend.mockResolvedValue({ Attributes: { emailCount: MAX_EMAILS_PER_HOUR_GLOBAL } });

        await expect(enforceGlobalEmailBudget()).resolves.toBeUndefined();
    });

    // Fails CLOSED: an unmetered window is unbounded, and unbounded is what
    // an abuse run needs.
    test('a DynamoDB error refuses the send', async () => {
        mockDdbSend.mockRejectedValue(new Error('boom'));

        await expect(enforceGlobalEmailBudget()).rejects.toThrow(/temporarily unavailable/);
        expect(loggedErrors()).toContain('EMAIL_BUDGET_EXHAUSTED window=hourly reason=unmeterable');
    });

    test('a missing table refuses rather than sending unmetered', async () => {
        delete process.env.OTP_RATE_LIMIT_TABLE;

        await expect(enforceGlobalEmailBudget()).rejects.toThrow(/temporarily unavailable/);
        expect(loggedErrors()).toContain('EMAIL_BUDGET_EXHAUSTED window=all reason=unmetered');
        expect(mockDdbSend).not.toHaveBeenCalled();
    });
});

// ── The per-recipient ceiling ───────────────────────────────────────────

describe('the per-recipient ceiling', () => {
    test('an ordinary send counts against this recipient and passes', async () => {
        mockDdbSend.mockResolvedValue({ Attributes: { emailCount: 1 } });

        await expect(enforceEmailRateLimit(ADDRESS)).resolves.toBeUndefined();

        expect(inputs()[0].Key.pk).toBe(`EMAIL#${addressKey(ADDRESS)}#${Math.floor(Date.now() / 3600000)}`);
        expect(JSON.stringify(inputs()[0])).not.toContain('parent@example.com');
    });

    test('past the hourly allowance it refuses', async () => {
        mockDdbSend.mockResolvedValue({
            Attributes: { emailCount: MAX_EMAILS_PER_RECIPIENT_PER_HOUR + 1 },
        });

        await expect(enforceEmailRateLimit(ADDRESS)).rejects.toThrow(/Too many verification codes/);
    });

    // Fails OPEN, and this asymmetry with the global ceiling is deliberate: a
    // DynamoDB blip must not be able to lock every family out of login. The
    // cost of getting this backwards is a total login outage.
    test('a DynamoDB error sends anyway', async () => {
        mockDdbSend.mockRejectedValue(new Error('boom'));

        await expect(enforceEmailRateLimit(ADDRESS)).resolves.toBeUndefined();
        expect(loggedErrors()).toContain('failing open');
    });

    test('a missing table sends anyway, and says so', async () => {
        delete process.env.OTP_RATE_LIMIT_TABLE;

        await expect(enforceEmailRateLimit(ADDRESS)).resolves.toBeUndefined();
        expect(warnSpy).toHaveBeenCalled();
        expect(mockDdbSend).not.toHaveBeenCalled();
    });
});

// ── The SendEmail parameters ────────────────────────────────────────────

describe('every send names the configuration set', () => {
    // This is the control, not a nicety. a-iep.org already carries a DEFAULT
    // configuration set belonging to another project in this shared account,
    // with zero event destinations, so a send that omits ConfigurationSetName
    // succeeds, counts against the shared account's reputation, and has its
    // bounces discarded. IAM cannot close this: ses:SendEmail has no
    // condition key for the configuration set.
    test('ConfigurationSetName is on the built parameters', () => {
        const params = buildOtpEmailParams({
            to: ADDRESS, subject: 'Your code', text: 'Your code is 123456',
        });

        expect(params.ConfigurationSetName).toBe('a-iep-auth-staging');
        expect(params.FromEmailAddress).toBe('no-reply@a-iep.org');
        expect(params.Destination.ToAddresses).toEqual([ADDRESS]);
    });

    test('it takes the set from the environment wireSender populates', () => {
        process.env.SES_CONFIGURATION_SET = 'a-iep-auth';

        expect(buildOtpEmailParams({ to: ADDRESS, subject: 's', text: 't' }).ConfigurationSetName)
            .toBe('a-iep-auth');
    });

    test.each(['SES_CONFIGURATION_SET', 'SES_FROM_ADDRESS'])(
        'without %s it refuses to build a send at all', (variable) => {
            delete process.env[variable];

            expect(() => buildOtpEmailParams({ to: ADDRESS, subject: 's', text: 't' }))
                .toThrow(/Failed to send verification code/);
        });

    // A misconfigured service is a broken send, not a control working, so it
    // must reach EMAIL_SEND_FAILED like any other outage.
    test('an unconfigured send is not a deliberate refusal', () => {
        delete process.env.SES_CONFIGURATION_SET;

        const error = (() => {
            try {
                buildOtpEmailParams({ to: ADDRESS, subject: 's', text: 't' });
            } catch (e) {
                return e;
            }
            throw new Error('expected a refusal');
        })();

        expect(isDeliberateEmailRefusal(error)).toBe(false);
        expect(reportEmailSendFailure(error)).toBe(true);
    });

    test('the plain-text body is always present; HTML is optional', () => {
        const textOnly = buildOtpEmailParams({ to: ADDRESS, subject: 's', text: 'code 123456' });
        expect(textOnly.Content.Simple.Body.Text.Data).toBe('code 123456');
        expect(textOnly.Content.Simple.Body.Html).toBeUndefined();

        const both = buildOtpEmailParams({ to: ADDRESS, subject: 's', text: 't', html: '<p>t</p>' });
        expect(both.Content.Simple.Body.Html.Data).toBe('<p>t</p>');
    });
});

// ── Reporting a broken send ─────────────────────────────────────────────

describe('a send that breaks is reported where an alarm can see it', () => {
    // create-auth-challenge reports a failed send through the challenge
    // parameter rather than raising, so Lambda Errors stays at zero through a
    // total outage. The marker is the only signal there is.
    test('a real failure logs EMAIL_SEND_FAILED with its kind', () => {
        expect(reportEmailSendFailure(Object.assign(new Error('no'), { name: 'MessageRejected' })))
            .toBe(true);
        expect(loggedErrors()).toContain('EMAIL_SEND_FAILED kind=MessageRejected');
    });

    test.each([
        'EmailSuppressedError',
        'EmailSuppressionUnavailableError',
        'EmailBudgetError',
        'EmailRateLimitError',
    ])('%s is a control working, so it does not log EMAIL_SEND_FAILED', (name) => {
        expect(reportEmailSendFailure(Object.assign(new Error('refused'), { name })))
            .toBe(false);
        expect(loggedErrors()).not.toContain('EMAIL_SEND_FAILED');
    });
});
