// Pending referral code, held between the first visit on a shared link and
// the moment the visitor signs up. First touch wins: while an unexpired code
// is stored, later codes do not overwrite it. Kept in localStorage; Safari
// may purge it after 7 days without a visit, which just shortens the window.
const PENDING_KEY = 'aiep-pending-ref';
const PENDING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Mirrors the backend's code shape (lowercase slug, max 32 chars)
const CODE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function normalizeReferralCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const code = value.trim().toLowerCase();
  return CODE_PATTERN.test(code) ? code : null;
}

// The id the server records a click under. Its own pattern, mirrored from the
// backend's: 16-64 URL-safe characters, unguessable because it is random.
const CLICK_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * A fresh random click id. Minted here because the click beacon is
 * fire-and-forget (sendBeacon cannot read a response), so the client has to
 * choose the id it will later present to /referral/attribute. The server, not
 * the client, decides WHEN that click happened.
 */
export function newClickId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface PendingReferralCapture {
  code: string;
  // Presented to /referral/attribute. The backend looks up the time it
  // recorded this click and ignores any client-side clock, so there is
  // nothing for a caller to back-date.
  clickId: string;
}

function readPendingCapture(): PendingReferralCapture | null {
  try {
    const raw = window.localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed.at !== 'number' ||
      Date.now() - parsed.at > PENDING_MAX_AGE_MS
    ) {
      window.localStorage.removeItem(PENDING_KEY);
      return null;
    }
    const code = normalizeReferralCode(parsed.code);
    // A capture stored before click ids existed has none, and the backend no
    // longer attributes without one, so keeping it would only fail later.
    // Dropping it lets the next visit to a shared link capture afresh.
    if (!code || typeof parsed.clickId !== 'string' || !CLICK_ID_PATTERN.test(parsed.clickId)) {
      window.localStorage.removeItem(PENDING_KEY);
      return null;
    }
    return { code, clickId: parsed.clickId };
  } catch {
    return null;
  }
}

export function getPendingReferral(): string | null {
  return readPendingCapture()?.code ?? null;
}

export function getPendingReferralCapture(): PendingReferralCapture | null {
  return readPendingCapture();
}

/**
 * Store a newly seen code. Returns the capture (with the click id to report to
 * the server) only when this call stored it, so callers can count the click
 * exactly once per capture; null when a code was already pending or the value
 * is not a code.
 */
export function storePendingReferral(value: string): PendingReferralCapture | null {
  const code = normalizeReferralCode(value);
  if (!code) return null;
  if (getPendingReferral()) return null;
  const clickId = newClickId();
  try {
    // `at` is only for expiring a stale capture locally; it is never sent.
    window.localStorage.setItem(PENDING_KEY, JSON.stringify({ code, at: Date.now(), clickId }));
    return { code, clickId };
  } catch {
    return null;
  }
}

export function clearPendingReferral(): void {
  try {
    window.localStorage.removeItem(PENDING_KEY);
  } catch {
    // storage unavailable: nothing to clear
  }
}
