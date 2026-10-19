/**
 * Whether the connection is one where a background download should wait.
 *
 * A parent on Data Saver, or on a connection the browser rates as 3G or slower,
 * should not have the other four language dictionaries pulled down while they
 * are reading. Those fetches are speculative: the switch path loads a language
 * on demand anyway.
 */

/** effectiveType values the Network Information API reports as slow. */
const SLOW_EFFECTIVE_TYPES: ReadonlySet<string> = new Set(['slow-2g', '2g', '3g']);

export interface NetworkConnectionHints {
  saveData?: boolean;
  effectiveType?: string;
}

/** The Network Information API is Chromium-only; elsewhere this is undefined. */
export function readNetworkConnection(): NetworkConnectionHints | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as Navigator & { connection?: NetworkConnectionHints }).connection;
}

/** A missing connection object (Safari, Firefox) means "not known to be slow". */
export function isConstrainedConnection(
  connection: NetworkConnectionHints | null | undefined
): boolean {
  if (!connection) return false;
  if (connection.saveData === true) return true;
  return SLOW_EFFECTIVE_TYPES.has(connection.effectiveType ?? '');
}
