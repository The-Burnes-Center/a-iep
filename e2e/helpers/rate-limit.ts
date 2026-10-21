/**
 * Staging-only reset of the per-destination wrong-code counter.
 *
 * /auth/verify counts wrong codes per DESTINATION per CALENDAR HOUR and locks
 * the destination at 10 (auth-store.js, MAX_FAILED_VERIFICATIONS_PER_HOUR).
 * The lockout journeys deliberately submit wrong codes for fixed numbers, so
 * several runs inside one hour (every staging deploy, plus its retries) used
 * to exhaust the budget and fail a journey that had nothing wrong with it.
 * Clearing the counter row for those numbers before the suite starts makes the
 * journeys independent of how often staging is deployed.
 *
 * Production protection is untouched: this is a direct DynamoDB delete by the
 * runner's own credentials, not a hook in the product, so there is no new
 * lambda, route or env var for anyone else to reach. The table lives in the
 * same AWS account as production's, which is why the guard below is strict.
 */
import { createHash } from 'crypto';
import { DeleteItemCommand } from '@aws-sdk/client-dynamodb';

const HOUR_MS = 60 * 60 * 1000;

/** Physical names are `<stack>-<logical id>-<suffix>`; this is the staging stack's. */
const STAGING_TABLE_NAME = /^AIEPStagingStack-[A-Za-z0-9]*OtpRateLimitTable[A-Za-z0-9]*-[A-Za-z0-9]+$/;

/** The only thing the reset needs from a DynamoDB client. */
export interface DeleteItemSender {
  send(command: DeleteItemCommand): Promise<unknown>;
}

/**
 * Refuse any table that is not the STAGING OTP rate-limit table. Production's
 * table (AIEPStack-...) sits in the same account and the runner's credentials
 * could delete from it, so the name is checked here rather than trusted.
 */
export function assertStagingRateLimitTable(tableName: string): void {
  if (!STAGING_TABLE_NAME.test(tableName)) {
    throw new Error(
      `Refusing to reset wrong-code counters in "${tableName}": it is not the ` +
      'AIEPStagingStack OTP rate-limit table.'
    );
  }
}

/**
 * The row auth-store.js keeps for `destination`'s wrong codes in the hour
 * containing `nowMs`: AUTHFAIL#sha256(destination)#<hours since epoch>.
 * Phones are keyed as typed in E.164, which is what /auth/start normalizes to.
 */
export function failureCounterKey(destination: string, nowMs: number): string {
  const destinationKey = createHash('sha256').update(destination).digest('hex');
  return `AUTHFAIL#${destinationKey}#${Math.floor(nowMs / HOUR_MS)}`;
}

/**
 * Delete this hour's wrong-code counter for each destination. Deleting an
 * absent row is a no-op, so this is safe on a clean hour. Returns the keys it
 * deleted, for the setup log (hashes, never the numbers).
 */
export async function resetFailedCodeCounters(
  client: DeleteItemSender,
  tableName: string,
  destinations: readonly string[],
  nowMs: number = Date.now(),
): Promise<string[]> {
  assertStagingRateLimitTable(tableName);
  const keys = destinations.map((destination) => failureCounterKey(destination, nowMs));
  for (const key of keys) {
    await client.send(new DeleteItemCommand({ TableName: tableName, Key: { pk: { S: key } } }));
  }
  return keys;
}
