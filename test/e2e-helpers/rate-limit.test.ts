/**
 * The E2E runner's staging-only reset of the per-destination wrong-code
 * counter (e2e/helpers/rate-limit.ts).
 *
 * Two things carry the weight. The guard: production's OTP rate-limit table
 * lives in the same AWS account as staging's and the runner's credentials can
 * delete from it, so a name that is not the staging table must be refused
 * BEFORE any delete is sent. And the key: the reset is worthless if it deletes
 * a row the lambda does not read, so it is pinned against the key auth-store.js
 * really looks up, not against a copy of the format.
 */
const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/lib-dynamodb', () => {
    class GetCommand { input: unknown; constructor(input: unknown) { this.input = input; } }
    class UpdateCommand { input: unknown; constructor(input: unknown) { this.input = input; } }
    return {
        GetCommand,
        UpdateCommand,
        PutCommand: class {},
        DeleteCommand: class {},
        DynamoDBDocumentClient: { from: () => ({ send: (...args: unknown[]) => mockDdbSend(...args) }) },
    };
});

import {
    assertStagingRateLimitTable,
    failureCounterKey,
    resetFailedCodeCounters,
} from '../../e2e/helpers/rate-limit';

const STAGING_TABLE = 'AIEPStagingStack-NewAuthorizationstagingOtpRateLimitTable9068E1B9-1REOIRL91822J';
const PROD_TABLE = 'AIEPStack-NewAuthorizationOtpRateLimitTableDB20666D-1K03HR4HNB25I';
const NOW = Date.UTC(2026, 9, 19, 23, 30, 0);

describe('assertStagingRateLimitTable', () => {
    it('accepts the staging OTP rate-limit table', () => {
        expect(() => assertStagingRateLimitTable(STAGING_TABLE)).not.toThrow();
    });

    it.each([
        ['the production rate-limit table', PROD_TABLE],
        ['a staging table that is not the rate-limit table', 'AIEPStagingStack-NewAuthorizationstagingAuthSessionTable1A2B3C4D-ABCDEF123456'],
        ['a production-stack name that merely mentions staging', 'AIEPStack-StagingOtpRateLimitTable-ABC'],
        ['a lookalike with a prefix in front', `x${STAGING_TABLE}`],
        ['a lookalike with a suffix behind', `${STAGING_TABLE}/../prod`],
        ['an empty name', ''],
    ])('refuses %s', (_label, name) => {
        expect(() => assertStagingRateLimitTable(name)).toThrow(/Refusing to reset/);
    });
});

describe('failureCounterKey', () => {
    it('is the row auth-store.js reads for the same destination and hour', async () => {
        const { destinationKey } = require('../../lib/chatbot-api/functions/phone-otp-auth/destination');
        const { isDestinationLockedOut } = require('../../lib/chatbot-api/functions/phone-otp-auth/auth-store');
        process.env.OTP_RATE_LIMIT_TABLE = STAGING_TABLE;
        mockDdbSend.mockResolvedValue({ Item: { failures: 10 } });
        jest.useFakeTimers().setSystemTime(NOW);
        try {
            await isDestinationLockedOut(destinationKey('+15555550125'));
        } finally {
            jest.useRealTimers();
        }

        const lookedUp = mockDdbSend.mock.calls[0][0].input.Key.pk;
        expect(failureCounterKey('+15555550125', NOW)).toBe(lookedUp);
    });

    it('moves to a new row when the clock hour changes, and stays put within one', () => {
        const hourStart = Date.UTC(2026, 9, 19, 23, 0, 0);
        expect(failureCounterKey('+15555550125', hourStart))
            .toBe(failureCounterKey('+15555550125', hourStart + 3_599_999));
        expect(failureCounterKey('+15555550125', hourStart))
            .not.toBe(failureCounterKey('+15555550125', hourStart + 3_600_000));
    });

    it('keeps the raw number out of the key', () => {
        expect(failureCounterKey('+15555550125', NOW)).not.toContain('5555550125');
    });
});

describe('resetFailedCodeCounters', () => {
    const send = jest.fn();

    beforeEach(() => send.mockReset().mockResolvedValue({}));

    it('deletes exactly one row per destination from the staging table', async () => {
        const keys = await resetFailedCodeCounters(
            { send }, STAGING_TABLE, ['+15555550112', '+15555550125'], NOW,
        );

        expect(send).toHaveBeenCalledTimes(2);
        const inputs = send.mock.calls.map(([command]) => command.input);
        expect(inputs.map((i) => i.TableName)).toEqual([STAGING_TABLE, STAGING_TABLE]);
        expect(inputs.map((i) => i.Key.pk.S)).toEqual(keys);
        expect(keys).toEqual([
            failureCounterKey('+15555550112', NOW),
            failureCounterKey('+15555550125', NOW),
        ]);
    });

    it('sends nothing at all to the production table', async () => {
        await expect(
            resetFailedCodeCounters({ send }, PROD_TABLE, ['+15555550125'], NOW),
        ).rejects.toThrow(/Refusing to reset/);
        expect(send).not.toHaveBeenCalled();
    });

    it('lets a DynamoDB failure surface instead of swallowing it', async () => {
        send.mockRejectedValue(new Error('AccessDeniedException'));
        await expect(
            resetFailedCodeCounters({ send }, STAGING_TABLE, ['+15555550125'], NOW),
        ).rejects.toThrow('AccessDeniedException');
    });
});
