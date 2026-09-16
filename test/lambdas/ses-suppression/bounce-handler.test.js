/**
 * The handler that keeps the do-not-email list current.
 *
 * Three things here would each break the list silently, so each has its own
 * test and each is worth more than the happy path:
 *
 *  - A suppression row that keeps a TTL expires after 30 days and the address
 *    becomes mailable again, with nothing anywhere saying so. The promotion
 *    from tally to suppression must REMOVE expiresAt.
 *  - A tally write on an already-suppressed row would re-add that TTL through
 *    if_not_exists. The condition expression is the only thing stopping it.
 *  - A write failure that does not log SES_SUPPRESSION_WRITE_FAILED is a
 *    bounce we were told about, lost, and cannot see that we lost.
 *
 * The AWS SDK v3 modules come from the Lambda runtime and are not vendored,
 * so they are mocked as virtual modules.
 */
const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => {
    class UpdateCommand {
        constructor(input) { this.input = input; }
    }
    return {
        UpdateCommand,
        DynamoDBDocumentClient: { from: () => ({ send: (...args) => mockDdbSend(...args) }) },
    };
}, { virtual: true });

const {
    handler,
    SUPPRESSION_WRITE_FAILED,
} = require('../../../lib/chatbot-api/functions/ses-suppression/bounce-handler');
const { addressKey } = require('../../../lib/chatbot-api/functions/ses-suppression/suppression-key');

const TABLE = 'email-suppression-test';
const ADDRESS = 'parent@example.com';

const snsEvent = (notification) => ({
    Records: [{ Sns: { Message: JSON.stringify(notification) } }],
});

const bounce = (bounceType, address = ADDRESS) => snsEvent({
    eventType: 'Bounce',
    bounce: {
        bounceType,
        bounceSubType: 'General',
        bouncedRecipients: [{ emailAddress: address, action: 'failed', status: '5.1.1' }],
        timestamp: '2026-09-10T12:00:00.000Z',
    },
    mail: { source: 'no-reply@a-iep.org' },
});

const complaint = (address = ADDRESS) => snsEvent({
    eventType: 'Complaint',
    complaint: {
        complainedRecipients: [{ emailAddress: address }],
        complaintFeedbackType: 'abuse',
        timestamp: '2026-09-10T12:00:00.000Z',
    },
    mail: { source: 'no-reply@a-iep.org' },
});

/** Every UpdateCommand input the handler sent, in order. */
const writes = () => mockDdbSend.mock.calls.map(([command]) => command.input);

let logSpy;
let errorSpy;

beforeEach(() => {
    mockDdbSend.mockReset();
    mockDdbSend.mockResolvedValue({ Attributes: { transientBounces: 1 } });
    process.env.EMAIL_SUPPRESSION_TABLE = TABLE;
    process.env.TRANSIENT_BOUNCES_BEFORE_SUPPRESSION = '3';
    process.env.TRANSIENT_BOUNCE_TTL_DAYS = '30';
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
});

describe('a permanent bounce is suppressed at once', () => {
    test('one write, keyed by the hash, never by the address', async () => {
        await handler(bounce('Permanent'));

        expect(writes()).toHaveLength(1);
        const [write] = writes();
        expect(write.TableName).toBe(TABLE);
        expect(write.Key).toEqual({ addressHash: addressKey(ADDRESS) });
        expect(JSON.stringify(write)).not.toContain('parent@example.com');
        expect(write.ExpressionAttributeValues[':reason']).toBe('hard-bounce');
    });

    // The single most breakable line in this handler. A suppression row that
    // inherits a tally's TTL disappears in 30 days and the address quietly
    // becomes mailable again.
    test('the suppression row is stripped of any TTL it had', async () => {
        await handler(bounce('Permanent'));

        const [write] = writes();
        expect(write.UpdateExpression).toContain('REMOVE expiresAt');
        expect(write.UpdateExpression).toContain('suppressedAt');
        expect(write.ExpressionAttributeValues[':expiry']).toBeUndefined();
    });
});

describe('a complaint is suppressed at once', () => {
    test('somebody who marked us as spam is never emailed again', async () => {
        await handler(complaint());

        expect(writes()).toHaveLength(1);
        expect(writes()[0].ExpressionAttributeValues[':reason']).toBe('complaint');
        expect(writes()[0].UpdateExpression).toContain('REMOVE expiresAt');
    });
});

describe('a transient bounce is counted, not acted on', () => {
    // Suppressing the first would lock a parent out of their own account
    // because their inbox was full on a Tuesday.
    test('the first one only tallies', async () => {
        mockDdbSend.mockResolvedValue({ Attributes: { transientBounces: 1 } });
        await handler(bounce('Transient'));

        expect(writes()).toHaveLength(1);
        const [write] = writes();
        expect(write.UpdateExpression).toContain('ADD transientBounces :one');
        expect(write.UpdateExpression).not.toContain('suppressedAt = ');
        expect(write.ConditionExpression).toBe('attribute_not_exists(suppressedAt)');
    });

    test('the tally carries the TTL, and it is the configured window', async () => {
        const before = Math.floor(Date.now() / 1000);
        await handler(bounce('Transient'));

        const expiry = writes()[0].ExpressionAttributeValues[':expiry'];
        expect(expiry).toBeGreaterThanOrEqual(before + 30 * 86400);
        expect(expiry).toBeLessThanOrEqual(before + 30 * 86400 + 5);
    });

    test('the third one inside the window suppresses', async () => {
        mockDdbSend.mockResolvedValueOnce({ Attributes: { transientBounces: 3 } });
        mockDdbSend.mockResolvedValueOnce({});

        await handler(bounce('Transient'));

        expect(writes()).toHaveLength(2);
        expect(writes()[1].UpdateExpression).toContain('REMOVE expiresAt');
        expect(writes()[1].ExpressionAttributeValues[':reason']).toBe('transient-bounce-repeated');
    });

    // An ambiguous bounce is not grounds for locking a parent out.
    test('Undetermined is treated as transient', async () => {
        await handler(bounce('Undetermined'));

        expect(writes()[0].UpdateExpression).toContain('ADD transientBounces :one');
    });

    // if_not_exists(expiresAt) on an already-suppressed row would give that
    // row a TTL. The condition is what stops it; this is the path where it
    // fires.
    test('an already-suppressed address is left alone, and nothing throws', async () => {
        const conditionFailed = new Error('The conditional request failed');
        conditionFailed.name = 'ConditionalCheckFailedException';
        mockDdbSend.mockRejectedValueOnce(conditionFailed);

        await expect(handler(bounce('Transient'))).resolves.toBeDefined();

        expect(writes()).toHaveLength(1);
        expect(errorSpy).not.toHaveBeenCalledWith(
            expect.stringContaining(SUPPRESSION_WRITE_FAILED),
        );
    });
});

describe('events that say nothing about the address write nothing', () => {
    // Reject and DeliveryDelay arrive on the same subscription. Alarms watch
    // them; the list must not.
    test.each([
        ['Reject', { eventType: 'Reject', reject: { reason: 'Bad content' } }],
        ['DeliveryDelay', {
            eventType: 'DeliveryDelay',
            deliveryDelay: { delayedRecipients: [{ emailAddress: ADDRESS }] },
        }],
    ])('%s', async (_label, notification) => {
        await handler(snsEvent(notification));

        expect(mockDdbSend).not.toHaveBeenCalled();
    });
});

describe('a write that fails is loud and is retried', () => {
    test('the exact marker is logged', async () => {
        mockDdbSend.mockRejectedValue(Object.assign(
            new Error('throughput exceeded'),
            { name: 'ProvisionedThroughputExceededException' },
        ));

        await expect(handler(complaint())).rejects.toThrow(/suppression write/);

        // The literal, not a paraphrase: a metric filter in
        // email-identity.ts reads exactly this string.
        expect(SUPPRESSION_WRITE_FAILED).toBe('SES_SUPPRESSION_WRITE_FAILED');
        const logged = errorSpy.mock.calls.map((args) => args.join(' ')).join('\n');
        expect(logged).toContain('SES_SUPPRESSION_WRITE_FAILED');
    });

    // SNS retries a failed invocation; a DynamoDB blip is exactly what that
    // retry is for, and swallowing the error would lose the bounce forever.
    test('the invocation fails so SNS redelivers it', async () => {
        mockDdbSend.mockRejectedValue(new Error('boom'));

        await expect(handler(complaint())).rejects.toThrow();
    });

    test('a missing table is the same failure, before any event is read', async () => {
        delete process.env.EMAIL_SUPPRESSION_TABLE;

        await expect(handler(complaint())).rejects.toThrow(/EMAIL_SUPPRESSION_TABLE/);

        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('SES_SUPPRESSION_WRITE_FAILED'),
        );
        expect(mockDdbSend).not.toHaveBeenCalled();
    });
});

describe('a payload we cannot read is dropped, not retried forever', () => {
    test('malformed JSON does not throw', async () => {
        await expect(handler({ Records: [{ Sns: { Message: 'not json{' } }] }))
            .resolves.toEqual({ recordsProcessed: 1 });

        expect(mockDdbSend).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalled();
    });

    test.each([
        ['no records', {}],
        ['empty records', { Records: [] }],
        ['a bounce naming nobody', snsEvent({ eventType: 'Bounce', bounce: { bounceType: 'Permanent' } })],
        ['a recipient with no address', snsEvent({
            eventType: 'Bounce',
            bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: '' }] },
        })],
    ])('%s does not throw', async (_label, event) => {
        await expect(handler(event)).resolves.toBeDefined();
        expect(mockDdbSend).not.toHaveBeenCalled();
    });
});

describe('no address ever reaches CloudWatch', () => {
    // The domain does, and on purpose: "every bounce is one provider" and
    // "every bounce is a different invented domain" are different incidents.
    test('the domain is logged and the local part is not', async () => {
        await handler(bounce('Permanent', 'Someone.Specific@school-district.example'));

        const all = [...logSpy.mock.calls, ...errorSpy.mock.calls]
            .map((args) => args.join(' ')).join('\n');
        expect(all).toContain('school-district.example');
        expect(all.toLowerCase()).not.toContain('someone.specific');
    });

    test('a failed write logs the domain and not the address either', async () => {
        mockDdbSend.mockRejectedValue(new Error('boom'));

        await expect(handler(complaint('Someone.Specific@school-district.example'))).rejects.toThrow();

        const all = errorSpy.mock.calls.map((args) => args.join(' ')).join('\n');
        expect(all).toContain('school-district.example');
        expect(all.toLowerCase()).not.toContain('someone.specific');
    });
});

describe('the thresholds come from the construct, not from here', () => {
    test('a garbage env var falls back rather than disabling the tally', async () => {
        process.env.TRANSIENT_BOUNCES_BEFORE_SUPPRESSION = 'not-a-number';
        mockDdbSend.mockResolvedValueOnce({ Attributes: { transientBounces: 3 } });
        mockDdbSend.mockResolvedValueOnce({});

        await handler(bounce('Transient'));

        // Still suppresses on the third: the fallback is the CDK's 3, not
        // Infinity, so a misconfigured env var narrows nothing.
        expect(writes()).toHaveLength(2);
    });

    test('a lower configured threshold is honoured', async () => {
        process.env.TRANSIENT_BOUNCES_BEFORE_SUPPRESSION = '2';
        mockDdbSend.mockResolvedValueOnce({ Attributes: { transientBounces: 2 } });
        mockDdbSend.mockResolvedValueOnce({});

        await handler(bounce('Transient'));

        expect(writes()).toHaveLength(2);
        expect(writes()[1].ExpressionAttributeValues[':reason']).toBe('transient-bounce-repeated');
    });
});
