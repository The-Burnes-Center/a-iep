/**
 * Staging-only way past the bot check, for the E2E runner and nobody else.
 *
 * One implementation, for the reason turnstile.js gives about itself: two
 * copies of a security check drift, and the copy that drifts is the one nobody
 * is looking at. This was lifted out of signup-endpoint.js when /auth/start
 * needed the same gate for email as well as phone; signup-endpoint.js now
 * delegates here, so there is still exactly one.
 *
 * Turnstile refuses automated browsers. That is the entire product, and it
 * means the real widget and an automated sign-in cannot both work. Losing the
 * journey is the worse trade: it is the coverage that caught a phone signup
 * bug which had been broken for over a month. So staging keeps the REAL widget
 * for anyone testing by hand, and only the E2E runner has a way past it.
 *
 * Double-guarded, deliberately:
 *
 *   1. `E2E_BYPASS_PARAM` is set by CDK only when getEnvironment() !== 'prod',
 *      so production has no env var, no SSM grant, and no reachable path here.
 *      test/infra pins its absence from the production template.
 *   2. The destination must be one of the fictional test destinations the
 *      caller passes in -- the NANP 555-01XX block for phones, the reserved
 *      `a-iep.invalid` domain for email -- checked independently of the env
 *      var. A leaked token is therefore useless against any destination a real
 *      person could receive a message on.
 *
 * Rate limits still apply: this skips the bot check and nothing else.
 * Compared in constant time, because a byte-by-byte comparison on a shared
 * token is a free oracle.
 */

const crypto = require('crypto');

let bypassToken;

/** Test seam: drop the cached token so the next call re-reads it. */
function resetBypassCache() {
    bypassToken = undefined;
}

/**
 * @param token        the value the caller sent in place of a Turnstile token
 * @param isAllowed    () => boolean, the caller's own destination allowlist
 *                     check. A function rather than a list so each endpoint
 *                     keeps its own hard-coded second lock.
 * @param marker       the log marker, so each endpoint's alarms keep working
 */
async function isE2EBypass(token, isAllowed, marker) {
    const parameterName = process.env.E2E_BYPASS_PARAM;
    if (!parameterName || typeof token !== 'string' || token.length === 0) {
        return false;
    }
    if (!isAllowed()) {
        return false;
    }
    if (bypassToken === undefined) {
        try {
            const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
            const ssm = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
            const result = await ssm.send(new GetParameterCommand({
                Name: parameterName,
                WithDecryption: true,
            }));
            bypassToken = result.Parameter?.Value || null;
        } catch {
            // Not configured, or unreadable. Either way the real check runs.
            bypassToken = null;
        }
    }
    if (!bypassToken) {
        return false;
    }
    const given = Buffer.from(token);
    const expected = Buffer.from(bypassToken);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        return false;
    }
    console.log(`${marker} the bot check was skipped for a test destination`);
    return true;
}

module.exports = { isE2EBypass, resetBypassCache };
