/**
 * The staging-only Cognito custom SMS sender. Assigning this trigger turns off
 * the pool's own SMS delivery, so the handler owns BOTH paths and both are
 * pinned here:
 *
 *   - allowlisted NANP-fictional test numbers -> the decrypted code lands in
 *     SSM (that is the only way an E2E run can complete a real signup, since
 *     Cognito — not create-auth-challenge — mints the signup code);
 *   - every other number -> a real SNS publish carrying the same wording the
 *     pool's smsVerificationMessage / smsAuthenticationMessage templates would
 *     have sent. A regression here silently stops texting real staging users.
 *
 * The AWS SDK v3 clients come from the Lambda runtime and the AWS Encryption
 * SDK is installed at deploy time by the CDK bundling step, so neither
 * resolves from this test's directory: all three are virtual-module mocks.
 */
const mockSnsSend = jest.fn();
const mockSsmSend = jest.fn();
const mockDecrypt = jest.fn();
const mockKeyringArgs = [];

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

// Mirrors the real @aws-crypto/client-node surface the handler uses:
// buildDecrypt(policy) -> { decrypt }, plus the KmsKeyringNode constructor.
jest.mock('@aws-crypto/client-node', () => ({
    buildDecrypt: () => ({ decrypt: (...args) => mockDecrypt(...args) }),
    CommitmentPolicy: { REQUIRE_ENCRYPT_ALLOW_DECRYPT: 'REQUIRE_ENCRYPT_ALLOW_DECRYPT' },
    KmsKeyringNode: class {
        constructor(config) { mockKeyringArgs.push(config); }
    },
}), { virtual: true });

const { PublishCommand } = require('@aws-sdk/client-sns');
const { PutParameterCommand } = require('@aws-sdk/client-ssm');
const { handler } = require('../../../lib/chatbot-api/functions/custom-sms-sender/index');

const KEY_ARN = 'arn:aws:kms:us-east-1:111122223333:key/1example-2222-3333-4444-999example';
const PARAM_PREFIX = '/a-iep/staging/test-otp';

// Allowlisted AND inside the NANP-fictional 555-01XX block: the backdoor path.
const TEST_PHONE = '+15555550113';
// Neither allowlisted nor fictional: an ordinary staging user.
const REAL_PHONE = '+12065550147';
// In the allowlist but NOT fictional — the second lock must still send SMS.
const ALLOWLISTED_NON_FICTIONAL = '+12065550188';

const CODE = '123456';
const ENCRYPTED_CODE = Buffer.from('cognito-encryption-sdk-blob').toString('base64');

// The pool's copy, duplicated from lib/authorization/new-auth.ts exactly as
// the handler duplicates it; this pins the two in sync.
const VERIFICATION_SMS = `Your OTP from The GovLab AIEP is: ${CODE}. Do not share this code. Msg & data rates may apply.`;
const AUTHENTICATION_SMS = `Your login code for The GovLab AIEP is: ${CODE}. Do not share this code.`;

const SMS_ATTRIBUTES = {
    'AWS.SNS.SMS.SenderID': { DataType: 'String', StringValue: 'GovLab-AIEP' },
    'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' },
    'AWS.SNS.SMS.MaxPrice': { DataType: 'String', StringValue: '0.50' },
};

const senderEvent = (triggerSource, phoneNumber, overrides = {}) => ({
    version: '1',
    triggerSource,
    region: 'us-east-1',
    userPoolId: 'us-east-1_teststaging',
    userName: 'test-user',
    request: {
        type: 'customSMSSenderRequestV1',
        code: ENCRYPTED_CODE,
        userAttributes: { phone_number: phoneNumber },
        ...overrides,
    },
    response: {},
});

let logged;

describe('custom-sms-sender', () => {
    beforeEach(() => {
        logged = [];
        const capture = (...args) => { logged.push(args.map(String).join(' ')); };
        jest.spyOn(console, 'log').mockImplementation(capture);
        jest.spyOn(console, 'error').mockImplementation(capture);

        mockDecrypt.mockResolvedValue({ plaintext: Buffer.from(CODE, 'utf-8'), messageHeader: {} });
        mockSnsSend.mockResolvedValue({ MessageId: 'msg-1' });
        mockSsmSend.mockResolvedValue({ Version: 1 });

        process.env.KMS_KEY_ARN = KEY_ARN;
        process.env.TEST_PHONE_NUMBERS = [TEST_PHONE, ALLOWLISTED_NON_FICTIONAL, '+15555550114'].join(',');
        process.env.TEST_OTP_PARAM_PREFIX = PARAM_PREFIX;
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('test number on signup: code stashed in SSM, no SMS', async () => {
        await handler(senderEvent('CustomSMSSender_SignUp', TEST_PHONE));

        expect(mockSnsSend).not.toHaveBeenCalled();
        expect(mockSsmSend).toHaveBeenCalledTimes(1);

        const [command] = mockSsmSend.mock.calls[0];
        expect(command).toBeInstanceOf(PutParameterCommand);
        // The '+' is illegal in an SSM parameter name; the E2E runner strips it
        // the same way when it reads the code back.
        expect(command.input.Name).toBe(`${PARAM_PREFIX}/15555550113`);
        expect(command.input.Type).toBe('String');
        expect(command.input.Overwrite).toBe(true);

        const payload = JSON.parse(command.input.Value);
        expect(payload.code).toBe(CODE);
        // A single test number can hold a signup code and a login code minutes
        // apart; source is how the runner tells them apart.
        expect(payload.source).toBe('cognito-CustomSMSSender_SignUp');
        expect(Number.isNaN(Date.parse(payload.issuedAt))).toBe(false);

        // Same discipline as the phone-otp-auth lambdas: the code is never logged.
        expect(logged.join('\n')).not.toContain(CODE);
        expect(logged.join('\n')).toContain('test number: Cognito code stashed to SSM (source: CustomSMSSender_SignUp)');
    });

    test('the ciphertext is base64-decoded and decrypted against the pool key', async () => {
        await handler(senderEvent('CustomSMSSender_SignUp', TEST_PHONE));

        expect(mockDecrypt).toHaveBeenCalledTimes(1);
        const [keyring, ciphertext] = mockDecrypt.mock.calls[0];
        expect(Buffer.isBuffer(ciphertext)).toBe(true);
        expect(ciphertext.toString('utf-8')).toBe('cognito-encryption-sdk-blob');
        expect(keyring).toBeDefined();
        // Decrypt-only keyring pinned to the pool's customSenderKmsKey.
        expect(mockKeyringArgs[0]).toEqual({ keyIds: [KEY_ARN] });
    });

    test('real number on signup: SMS uses the verification template, nothing hits SSM', async () => {
        await handler(senderEvent('CustomSMSSender_SignUp', REAL_PHONE));

        expect(mockSsmSend).not.toHaveBeenCalled();
        expect(mockSnsSend).toHaveBeenCalledTimes(1);

        const [command] = mockSnsSend.mock.calls[0];
        expect(command).toBeInstanceOf(PublishCommand);
        expect(command.input.PhoneNumber).toBe(REAL_PHONE);
        expect(command.input.Message).toBe(VERIFICATION_SMS);
        expect(command.input.Message).toContain(CODE);
        expect(command.input.MessageAttributes).toEqual(SMS_ATTRIBUTES);
    });

    test.each([
        'CustomSMSSender_ResendCode',
        'CustomSMSSender_VerifyUserAttribute',
    ])('%s also uses the verification template', async (triggerSource) => {
        await handler(senderEvent(triggerSource, REAL_PHONE));
        expect(mockSnsSend.mock.calls[0][0].input.Message).toBe(VERIFICATION_SMS);
    });

    test('real number on authentication: SMS uses the authentication template', async () => {
        await handler(senderEvent('CustomSMSSender_Authentication', REAL_PHONE));

        expect(mockSsmSend).not.toHaveBeenCalled();
        expect(mockSnsSend.mock.calls[0][0].input.Message).toBe(AUTHENTICATION_SMS);
    });

    test('forgot password falls back to the authentication template', async () => {
        await handler(senderEvent('CustomSMSSender_ForgotPassword', REAL_PHONE));
        expect(mockSnsSend.mock.calls[0][0].input.Message).toBe(AUTHENTICATION_SMS);
    });

    // The second lock: the allowlist alone must never divert a code. A real
    // subscriber's number added to TEST_PHONE_NUMBERS by mistake still gets
    // texted, and its code never lands in a readable parameter.
    test('an allowlisted but non-fictional number is texted, not stashed', async () => {
        await handler(senderEvent('CustomSMSSender_SignUp', ALLOWLISTED_NON_FICTIONAL));

        expect(mockSsmSend).not.toHaveBeenCalled();
        expect(mockSnsSend).toHaveBeenCalledTimes(1);
        expect(mockSnsSend.mock.calls[0][0].input.PhoneNumber).toBe(ALLOWLISTED_NON_FICTIONAL);
    });

    // Production semantics: with no backdoor env vars there is no backdoor at
    // all, even for a fictional number. Production never wires this trigger,
    // but the handler must not depend on that.
    test('with no allowlist env vars every number takes the SMS path', async () => {
        delete process.env.TEST_PHONE_NUMBERS;
        delete process.env.TEST_OTP_PARAM_PREFIX;

        await handler(senderEvent('CustomSMSSender_SignUp', TEST_PHONE));

        expect(mockSsmSend).not.toHaveBeenCalled();
        expect(mockSnsSend).toHaveBeenCalledTimes(1);
        expect(mockSnsSend.mock.calls[0][0].input.PhoneNumber).toBe(TEST_PHONE);
    });

    // This lambda IS the pool's SMS delivery: swallowing an error would let
    // Cognito report a code as sent when no message exists.
    test('a decrypt failure throws and delivers nothing', async () => {
        mockDecrypt.mockRejectedValue(new Error('KMS decrypt denied'));

        await expect(handler(senderEvent('CustomSMSSender_SignUp', TEST_PHONE)))
            .rejects.toThrow('KMS decrypt denied');

        expect(mockSsmSend).not.toHaveBeenCalled();
        expect(mockSnsSend).not.toHaveBeenCalled();
        expect(logged.join('\n')).not.toContain(CODE);
    });

    test('an SNS publish failure throws', async () => {
        mockSnsSend.mockRejectedValue(new Error('SNS unavailable'));

        await expect(handler(senderEvent('CustomSMSSender_SignUp', REAL_PHONE)))
            .rejects.toThrow('SNS unavailable');
    });

    test('an allowlisted number with no param prefix fails loudly instead of texting', async () => {
        delete process.env.TEST_OTP_PARAM_PREFIX;

        await expect(handler(senderEvent('CustomSMSSender_SignUp', TEST_PHONE)))
            .rejects.toThrow(/TEST_OTP_PARAM_PREFIX is not set/);

        expect(mockSnsSend).not.toHaveBeenCalled();
    });

    test('an event with no code throws before any delivery', async () => {
        await expect(handler(senderEvent('CustomSMSSender_SignUp', TEST_PHONE, { code: undefined })))
            .rejects.toThrow(/no code to deliver/);

        expect(mockSsmSend).not.toHaveBeenCalled();
        expect(mockSnsSend).not.toHaveBeenCalled();
    });

    test('an event with no phone number throws before decrypting', async () => {
        const event = senderEvent('CustomSMSSender_SignUp', undefined);
        event.request.userAttributes = {};

        await expect(handler(event)).rejects.toThrow(/No phone_number user attribute/);

        expect(mockDecrypt).not.toHaveBeenCalled();
        expect(mockSsmSend).not.toHaveBeenCalled();
        expect(mockSnsSend).not.toHaveBeenCalled();
    });
});
