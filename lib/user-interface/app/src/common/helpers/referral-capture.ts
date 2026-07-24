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

export function getPendingReferral(): string | null {
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
    return normalizeReferralCode(parsed.code);
  } catch {
    return null;
  }
}

/**
 * Store a newly seen code. Returns true only when this call stored it, so
 * callers can count the click exactly once per capture.
 */
export function storePendingReferral(value: string): boolean {
  const code = normalizeReferralCode(value);
  if (!code) return false;
  if (getPendingReferral()) return false;
  try {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify({ code, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

export function clearPendingReferral(): void {
  try {
    window.localStorage.removeItem(PENDING_KEY);
  } catch {
    // storage unavailable: nothing to clear
  }
}
