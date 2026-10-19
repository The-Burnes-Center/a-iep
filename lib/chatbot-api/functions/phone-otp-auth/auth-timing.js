/**
 * Opt-in timing for the sign-in lambdas, to find where a cold request goes.
 *
 * Off unless AUTH_TIMING=1, which CDK sets in staging only. When on, each
 * request writes ONE line:
 *
 *   AUTH_TIMING fn=auth-start cold=1 total=3576 boot=366 steps=ddb.Update.first=1204,ssm.GetParameter.first=902,...
 *
 * `total` is the handler's wall time, `boot` (cold requests only) is how long
 * the process had been alive when the handler began, and each step is a name
 * and a duration in whole milliseconds. A `.first` suffix marks the first
 * send() a client made in this container, which is where connection set-up and
 * the SDK's lazy initialisation land.
 *
 * Content-free by construction: the only strings that reach the log are the
 * function name the caller passes, a service label, an SDK command class name
 * and numbers, each reduced to [A-Za-z0-9_.-]. No event, no destination, no
 * code, token, IP or error text is ever read here.
 */

const { performance } = require('perf_hooks');

const UNSAFE = /[^A-Za-z0-9_.-]/g;
const MAX_LABEL = 64;

/** Only the first request a container serves is cold. */
let isFirstRequest = true;
/** The request being timed. One at a time: these lambdas run one request per container. */
let current = null;

const isEnabled = () => process.env.AUTH_TIMING === '1';

const label = (value) => String(value).replace(UNSAFE, '').slice(0, MAX_LABEL) || 'unnamed';

/** Add a finished step to a request, if that request is still being timed. */
function record(request, name, startedAt) {
    if (!request) return;
    request.steps.push(`${label(name)}=${Math.round(performance.now() - startedAt)}`);
}

/** Time one awaited step of a handler. */
async function timeStep(name, work) {
    const request = current;
    if (!isEnabled() || !request) return work();
    const startedAt = performance.now();
    try {
        return await work();
    } finally {
        record(request, name, startedAt);
    }
}

/**
 * Time every send() on an AWS SDK client, labelled `<service>.<Operation>`,
 * with `.first` on the first one. Returns the same client so it can wrap a
 * constructor call in place. A no-op unless AUTH_TIMING=1 at load.
 */
function instrumentClient(client, service) {
    if (!isEnabled()) return client;
    const send = client.send.bind(client);
    let hasSent = false;
    client.send = async (command, ...rest) => {
        const request = current;
        const operation = String(command?.constructor?.name || 'Command').replace(/Command$/, '');
        const name = `${service}.${operation}${hasSent ? '' : '.first'}`;
        hasSent = true;
        const startedAt = performance.now();
        try {
            return await send(command, ...rest);
        } finally {
            record(request, name, startedAt);
        }
    };
    return client;
}

/** Wrap a handler so each request logs its AUTH_TIMING line. */
function withTiming(fn, handler) {
    return async (...args) => {
        if (!isEnabled()) return handler(...args);
        const cold = isFirstRequest;
        isFirstRequest = false;
        const request = { steps: [] };
        current = request;
        const startedAt = performance.now();
        const boot = Math.round(startedAt);
        try {
            return await handler(...args);
        } finally {
            if (current === request) current = null;
            const total = Math.round(performance.now() - startedAt);
            console.log(
                `AUTH_TIMING fn=${label(fn)} cold=${cold ? 1 : 0} total=${total}`
                + `${cold ? ` boot=${boot}` : ''} steps=${request.steps.join(',')}`,
            );
        }
    };
}

module.exports = { withTiming, timeStep, instrumentClient, isEnabled };
