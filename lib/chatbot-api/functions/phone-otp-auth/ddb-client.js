/**
 * The one DynamoDB document client every module in this directory shares.
 *
 * Built when the module loads, not on first use. Loading the SDK and opening
 * the first TLS connection are CPU-bound, and the Lambda Init phase runs with
 * a CPU burst that the handler does not get, so doing the work here moves it
 * out of a parent's wait. It is shared rather than built per module because
 * each client opens its own connection: one lambda reaching DynamoDB from
 * three modules would otherwise pay three handshakes.
 */
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

const docClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' })
);

module.exports = { docClient };
