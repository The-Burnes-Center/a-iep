/**
 * The one SSM client every module in this directory shares.
 *
 * Built at module load for the same reason as ddb-client.js: SDK load and the
 * first TLS handshake belong in Init, not in a parent's wait, and one client
 * means one connection however many modules read parameters.
 */
const { SSMClient } = require('@aws-sdk/client-ssm');
const { instrumentClient } = require('./auth-timing');

const ssmClient = instrumentClient(
    new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' }),
    'ssm',
);

module.exports = { ssmClient };
