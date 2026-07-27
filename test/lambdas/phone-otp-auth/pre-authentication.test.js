/**
 * pre-authentication stamps the sign-in screen's UI language onto the
 * existing profile row (loginLanguage) so create-auth-challenge can localize
 * the OTP SMS: Cognito forwards InitiateAuth ClientMetadata here (as
 * validationData) but not to the SMS-composing trigger. Best-effort by
 * design; nothing on this path may ever block authentication.
 */
const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: { from: () => ({ send: (...args) => mockDdbSend(...args) }) },
    UpdateCommand: class {
        constructor(input) { this.input = input; }
    },
}), { virtual: true });

const { handler } = require('../../../lib/chatbot-api/functions/phone-otp-auth/pre-authentication');

const authEvent = ({ validationData, clientMetadata } = {}) => ({
    userName: 'user-1',
    request: {
        userAttributes: { phone_number: '+15555550100' },
        ...(validationData ? { validationData } : {}),
        ...(clientMetadata ? { clientMetadata } : {}),
    },
    response: {},
});

describe('pre-authentication', () => {
    beforeEach(() => {
        process.env.USER_PROFILES_TABLE = 'test-profiles-table';
        mockDdbSend.mockResolvedValue({});
    });

    test('stamps loginLanguage from InitiateAuth validationData, existing rows only', async () => {
        const event = await handler(authEvent({ validationData: { language: 'zh' } }));
        expect(event.response).toEqual({});

        expect(mockDdbSend).toHaveBeenCalledTimes(1);
        const update = mockDdbSend.mock.calls[0][0].input;
        expect(update.TableName).toBe('test-profiles-table');
        expect(update.Key).toEqual({ userId: 'user-1' });
        expect(update.UpdateExpression).toBe('SET loginLanguage = :lang');
        // Brand-new users have no profile row yet; the condition keeps this
        // from creating a bogus one.
        expect(update.ConditionExpression).toBe('attribute_exists(userId)');
        expect(update.ExpressionAttributeValues).toEqual({ ':lang': 'zh' });
    });

    test('falls back to clientMetadata for admin-initiated flows', async () => {
        await handler(authEvent({ clientMetadata: { language: 'es' } }));
        expect(mockDdbSend.mock.calls[0][0].input.ExpressionAttributeValues).toEqual({ ':lang': 'es' });
    });

    test('an unsupported language writes nothing', async () => {
        await handler(authEvent({ validationData: { language: 'xx' } }));
        expect(mockDdbSend).not.toHaveBeenCalled();
    });

    test('no configured profiles table writes nothing', async () => {
        delete process.env.USER_PROFILES_TABLE;
        await handler(authEvent({ validationData: { language: 'es' } }));
        expect(mockDdbSend).not.toHaveBeenCalled();
    });

    test('a missing profile row (condition failure) is quietly skipped', async () => {
        const conditionError = new Error('conditional failed');
        conditionError.name = 'ConditionalCheckFailedException';
        mockDdbSend.mockRejectedValue(conditionError);
        const event = await handler(authEvent({ validationData: { language: 'es' } }));
        expect(event).toBeDefined();
    });

    test('any other DynamoDB failure still returns the event to Cognito', async () => {
        mockDdbSend.mockRejectedValue(new Error('DynamoDB down'));
        const event = await handler(authEvent({ validationData: { language: 'es' } }));
        expect(event.userName).toBe('user-1');
    });
});
