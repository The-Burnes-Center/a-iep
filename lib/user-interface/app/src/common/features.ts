// Single source of truth for the optional features the UI can offer.
//
// Which of these are actually live is controlled per environment via
// `enabledFeatures` in aws-exports.json (see common/types.ts,
// common/hooks/use-features.ts and the build/deploy config in vite.config.ts /
// lib/user-interface/index.ts) — the same mechanism as `enabledLanguages` in
// ./languages.ts. Production deploys all of this code but keeps these three
// features dark, exactly like Arabic: the backend (TTS lambda, referral table
// and routes) stays deployed and simply goes unused, so turning a feature on
// later is a config flip, not a release, and prod never runs a different build
// from staging.

export type Feature =
  // The TTS play buttons on the summary page. The audio lambda and its route
  // stay deployed either way; without the buttons nothing calls them.
  | 'tts'
  // The in-app entry point to the referral/invite flow. The `?ref=` capture
  // and the /r/:code redirect are unconditional and harmless while no codes
  // are issued, so only the entry point is gated.
  | 'referrals'
  // The onboarding redirect that forces a parent with no saved name to fill it
  // in before reaching the app. Only the referral console and referral links
  // display that name, so the prompt is pointless where referrals are dark.
  | 'parentNameGate';

// Master list, in a stable order. Add a feature here (plus the two build
// configs) to make it gateable app-wide.
export const ALL_FEATURES: Feature[] = ['tts', 'referrals', 'parentNameGate'];

export const isFeature = (feature: unknown): feature is Feature =>
  typeof feature === 'string' && (ALL_FEATURES as string[]).includes(feature);

/**
 * Normalize an `enabledFeatures` config value into a safe, ordered list of
 * known feature names. Unknown names are dropped, and the result follows the
 * master order.
 *
 * Note the deliberate difference from `resolveEnabledLanguages`: an EMPTY list
 * is honoured here instead of falling back to everything. `[]` is production's
 * real state (all three features dark), whereas a language list that resolved
 * to nothing would leave the UI with no language to display at all. Only a
 * missing/null field falls back to every feature, so a config written before
 * this flag existed (or a local dev build) behaves like dev/staging.
 */
export const resolveEnabledFeatures = (
  enabled: readonly string[] | undefined | null,
): Feature[] => {
  if (enabled === undefined || enabled === null) return ALL_FEATURES;
  const allowed = new Set(enabled.filter(isFeature));
  return ALL_FEATURES.filter((f) => allowed.has(f));
};
