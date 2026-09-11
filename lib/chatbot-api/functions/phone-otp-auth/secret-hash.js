/**
 * SECRET_HASH for the confidential app client.
 *
 * The backend talks to Cognito through an app client that HAS a client
 * secret, which the browser's client does not. That is the whole point of the
 * split: `InitiateAuth` from a browser then fails at Cognito no matter what
 * the caller knows, so Turnstile is genuinely in front of every OTP rather
 * than in front of account creation only.
 *
 * The price is that every single call on that client has to carry a computed
 * SECRET_HASH, including each CUSTOM_CHALLENGE round. Omit it and the FIRST
 * backend call throws NotAuthorizedException with nothing in the message
 * pointing at why. The design doc this was built from never mentioned it.
 *
 * Verified against AWS's own documentation rather than recalled:
 *
 *   "The secret hash value is a Base 64-encoded keyed-hash message
 *    authentication code (HMAC) calculated using the secret key of a user
 *    pool client and username plus the client ID in the message."
 *
 *        Base64 ( HMAC_SHA256 ( "Client Secret Key", "Username" + "Client Id" ) )
 *
 *   -- Amazon Cognito Developer Guide, "Computing secret hash values"
 *      https://docs.aws.amazon.com/cognito/latest/developerguide/
 *      signing-up-users-in-your-app.html#cognito-user-pools-computing-secret-hash
 *
 * So: the KEY is the client secret, the MESSAGE is username THEN client id,
 * concatenated with no separator, and the output is standard base64 (not
 * base64url). Getting the order backwards, or keying with the client id, is
 * the usual mistake and produces a hash Cognito rejects identically to no
 * hash at all.
 *
 * Where it goes, also from AWS:
 *
 *   AdminInitiateAuth           -> AuthParameters.SECRET_HASH
 *     "Add a SECRET_HASH parameter if your app client has a client secret."
 *   AdminRespondToAuthChallenge -> ChallengeResponses.SECRET_HASH
 *     "You must provide a SECRET_HASH parameter in all challenge responses to
 *      an app client that has a client secret."
 *
 *   -- API Reference, API_AdminInitiateAuth and API_AdminRespondToAuthChallenge
 *
 * "all challenge responses" includes CUSTOM_CHALLENGE, which is every round of
 * this service's login: the language handshake and the OTP answer both need
 * it.
 */

const crypto = require('crypto');

/**
 * The hash for one call.
 *
 * `username` must be the value being passed as USERNAME in the same request.
 * For A-IEP that is the E.164 phone number or the email address, because the
 * signup path uses the destination as the Cognito Username.
 */
function computeSecretHash(username, clientId, clientSecret) {
    if (!username || !clientId || !clientSecret) {
        // Loud rather than a silently wrong hash: a wrong hash and a missing
        // one fail identically at Cognito, so the only way to tell them apart
        // afterwards is for one of them to have said something here.
        throw new Error('computeSecretHash needs a username, a client id and a client secret');
    }
    return crypto
        .createHmac('sha256', clientSecret)
        .update(username + clientId)
        .digest('base64');
}

// The secret does not change for the life of a container, and reading it is a
// Cognito API call on the login path.
let cachedSecret;

/**
 * The confidential client's secret, read at runtime.
 *
 * Deliberately NOT passed in as a Lambda environment variable. CDK can hand
 * out `userPoolClient.userPoolClientSecret`, but doing so creates an
 * AwsCustomResource whose DescribeUserPoolClient response CloudFormation then
 * stores, which puts the live client secret into stack state and into the
 * custom resource's own logs. Reading it here instead means the secret exists
 * in exactly two places: Cognito, and the memory of a function that already
 * holds every token it protects.
 *
 * Fails CLOSED. A client secret we cannot read is a login we cannot perform,
 * and there is no degraded mode worth having: calling Cognito without the
 * hash just produces NotAuthorizedException one hop later.
 */
async function loadClientSecret(cognito, DescribeUserPoolClientCommand, userPoolId, clientId) {
    if (cachedSecret) {
        return cachedSecret;
    }
    const result = await cognito.send(new DescribeUserPoolClientCommand({
        UserPoolId: userPoolId,
        ClientId: clientId,
    }));
    const secret = result?.UserPoolClient?.ClientSecret;
    if (!secret) {
        // The client exists but carries no secret, which means the two-client
        // split has been undone. That is a security regression, not a
        // transient fault, so it says so in the one place a person will look.
        throw new Error('AUTH_CLIENT_MISCONFIGURED the backend app client has no client secret');
    }
    cachedSecret = secret;
    return cachedSecret;
}

/** Test seam: drop the cached secret so the next call re-reads it. */
function resetClientSecretCache() {
    cachedSecret = undefined;
}

module.exports = { computeSecretHash, loadClientSecret, resetClientSecretCache };
