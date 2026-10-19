/**
 * The AUTH_TIMING line.
 *
 * It is written on every sign-in request in staging, next to a destination, a
 * code, a handle and a source address that must never reach it. So the tests
 * that matter most here assert what the line does NOT contain, by feeding the
 * wrapper those values everywhere it could pick one up: the event, the SDK
 * command's input, the response, and the error thrown.
 */
const DESTINATION = '+15550123456';
const EMAIL = 'parent@example.org';
const CODE = '482913';
const TOKEN = 'tok_SECRET_handle_value';
const IP = '203.0.113.77';

const EVENT = {
    requestContext: { http: { sourceIp: IP } },
    body: JSON.stringify({ destination: DESTINATION, email: EMAIL, code: CODE, session: TOKEN }),
};

let logSpy;

function load(enabled) {
    jest.resetModules();
    if (enabled) {
        process.env.AUTH_TIMING = '1';
    } else {
        delete process.env.AUTH_TIMING;
    }
    // eslint-disable-next-line global-require
    return require('../../../lib/chatbot-api/functions/phone-otp-auth/auth-timing');
}

function timingLines() {
    return logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('AUTH_TIMING'));
}

/** A client whose commands carry sensitive input and return sensitive output. */
function fakeClient() {
    return {
        send: jest.fn(async (command) => ({ echoed: command.input, token: TOKEN })),
    };
}

class UpdateCommand { constructor(input) { this.input = input; } }
class GetParameterCommand { constructor(input) { this.input = input; } }

beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    logSpy.mockRestore();
    delete process.env.AUTH_TIMING;
});

describe('when AUTH_TIMING is not 1', () => {
    test('logs nothing and leaves the handler and the client alone', async () => {
        const { withTiming, instrumentClient, timeStep } = load(false);
        const client = fakeClient();
        const originalSend = client.send;
        expect(instrumentClient(client, 'ddb').send).toBe(originalSend);

        const handler = withTiming('auth-start', async () => timeStep('step', async () => 'ok'));
        await expect(handler(EVENT)).resolves.toBe('ok');
        expect(timingLines()).toEqual([]);
    });

    test('any other value than 1 is off', async () => {
        const { withTiming } = load(false);
        process.env.AUTH_TIMING = 'true';
        await withTiming('auth-start', async () => 'ok')(EVENT);
        expect(timingLines()).toEqual([]);
    });
});

describe('when AUTH_TIMING=1', () => {
    test('writes exactly one line per request, cold only on the first', async () => {
        const { withTiming } = load(true);
        const handler = withTiming('auth-start', async () => ({ statusCode: 200 }));

        await handler(EVENT);
        await handler(EVENT);

        const lines = timingLines();
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatch(/^AUTH_TIMING fn=auth-start cold=1 total=\d+ boot=\d+ steps=$/);
        expect(lines[1]).toMatch(/^AUTH_TIMING fn=auth-start cold=0 total=\d+ steps=$/);
    });

    test('records each client call by service and operation, marking the first per client', async () => {
        const { withTiming, instrumentClient } = load(true);
        const ddb = instrumentClient(fakeClient(), 'ddb');
        const ssm = instrumentClient(fakeClient(), 'ssm');

        const handler = withTiming('auth-start', async () => {
            await ddb.send(new UpdateCommand({ Key: 'a' }));
            await ssm.send(new GetParameterCommand({ Name: 'p' }));
            await ddb.send(new UpdateCommand({ Key: 'b' }));
        });
        await handler(EVENT);

        const [line] = timingLines();
        const steps = line.split('steps=')[1].split(',').map((s) => s.replace(/=\d+$/, ''));
        expect(steps).toEqual(['ddb.Update.first', 'ssm.GetParameter.first', 'ddb.Update']);
    });

    test('a later request does not repeat .first for a client that already sent', async () => {
        const { withTiming, instrumentClient } = load(true);
        const ddb = instrumentClient(fakeClient(), 'ddb');
        const handler = withTiming('auth-session', async () => { await ddb.send(new UpdateCommand({})); });

        await handler(EVENT);
        await handler(EVENT);

        const [, second] = timingLines();
        expect(second).toMatch(/steps=ddb\.Update=\d+$/);
    });

    test('times a named step', async () => {
        const { withTiming, timeStep } = load(true);
        await withTiming('auth-dispatch', async () => {
            await timeStep('send-code', async () => 'x');
        })(EVENT);

        expect(timingLines()[0]).toMatch(/steps=send-code=\d+$/);
    });

    test('still returns the result, and the SDK call still gets its own command', async () => {
        const { withTiming, instrumentClient } = load(true);
        const client = fakeClient();
        const originalSend = client.send;
        const ddb = instrumentClient(client, 'ddb');
        const command = new UpdateCommand({ Key: 'a' });

        const result = await withTiming('auth-start', () => ddb.send(command))(EVENT);

        expect(originalSend).toHaveBeenCalledWith(command);
        expect(result.echoed).toEqual({ Key: 'a' });
    });

    test('logs the line and rethrows when the handler fails', async () => {
        const { withTiming, instrumentClient } = load(true);
        const ddb = instrumentClient({
            send: async () => { throw Object.assign(new Error(`failed for ${DESTINATION}`), { name: 'Boom' }); },
        }, 'ddb');

        const handler = withTiming('auth-verify', async () => { await ddb.send(new UpdateCommand({})); });

        await expect(handler(EVENT)).rejects.toThrow('failed for');
        const lines = timingLines();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/steps=ddb\.Update\.first=\d+$/);
    });

    test('a step recorded after its request ended goes nowhere and breaks nothing', async () => {
        const { withTiming, instrumentClient } = load(true);
        const ddb = instrumentClient(fakeClient(), 'ddb');
        let late;

        await withTiming('auth-start', async () => {
            late = (async () => { await new Promise((r) => setTimeout(r, 5)); await ddb.send(new UpdateCommand({})); })();
        })(EVENT);
        await withTiming('auth-start', async () => 'next')(EVENT);
        await late;

        const lines = timingLines();
        expect(lines).toHaveLength(2);
        expect(lines[1]).toMatch(/steps=$/);
    });

    test('the line never carries a destination, code, token, address or error text', async () => {
        const { withTiming, instrumentClient, timeStep } = load(true);
        const ddb = instrumentClient(fakeClient(), 'ddb');
        const ssm = instrumentClient({
            send: async () => { throw new Error(`bad ${DESTINATION} ${EMAIL} ${CODE} ${TOKEN} ${IP}`); },
        }, 'ssm');

        const handler = withTiming('auth-start', async (event) => {
            await ddb.send(new UpdateCommand({
                Key: { pk: `AUTHSTART#IP#${IP}`, destination: DESTINATION, email: EMAIL },
                code: CODE,
                handle: TOKEN,
            }));
            await timeStep('put-challenge', async () => ({ body: event.body }));
            try { await ssm.send(new GetParameterCommand({ Name: TOKEN })); } catch { /* the point is the log */ }
            throw new Error(`refused ${DESTINATION} ${CODE} ${TOKEN} ${IP} ${EMAIL}`);
        });

        await expect(handler(EVENT)).rejects.toThrow();

        const everything = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        for (const secret of [DESTINATION, '5550123456', EMAIL, 'example.org', CODE, TOKEN, 'SECRET', IP, '203.0.113']) {
            expect(everything).not.toContain(secret);
        }
        expect(timingLines()).toHaveLength(1);
    });

    test('every field is a name or a number, even if a caller passes something hostile', async () => {
        const { withTiming, timeStep } = load(true);
        const hostile = `step ${DESTINATION}\n${EMAIL}; rm -rf ${TOKEN}`;

        await withTiming(`fn ${CODE}\nINJECTED`, async () => {
            await timeStep(hostile, async () => 'x');
        })(EVENT);

        const [line] = timingLines();
        expect(line.split('\n')).toHaveLength(1);
        expect(line).toMatch(/^AUTH_TIMING fn=[A-Za-z0-9_.-]+ cold=[01] total=\d+( boot=\d+)? steps=[A-Za-z0-9_.,=-]*$/);
    });

    test('names the SDK command only by its operation, never by its input', async () => {
        const { withTiming, instrumentClient } = load(true);
        const client = instrumentClient(fakeClient(), 'cognito');
        class AdminRespondToAuthChallengeCommand { constructor(input) { this.input = input; } }

        await withTiming('auth-verify', () => client.send(new AdminRespondToAuthChallengeCommand({
            ChallengeResponses: { USERNAME: DESTINATION, ANSWER: CODE },
        })))(EVENT);

        expect(timingLines()[0]).toMatch(/steps=cognito\.AdminRespondToAuthChallenge\.first=\d+$/);
    });
});
