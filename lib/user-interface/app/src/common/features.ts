// Single source of truth for the optional features the UI can offer.
//
// Which of these are actually live is controlled per environment via
// `enabledFeatures` in aws-exports.json (see common/types.ts,
// common/hooks/use-features.ts and the build/deploy config in vite.config.ts /
// lib/user-interface/index.ts) — the same mechanism as `enabledLanguages` in
// ./languages.ts. Production deploys all of this code but keeps most of these
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
  // The onboarding redirect that forces a parent with no saved, non-default
  // child name to fill one in before reaching the app. Checked FIRST,
  // ahead of parentNameGate below: the product's explicit call is student
  // name then parent name, never the reverse, so a parent missing both sees
  // the child form before the parent-name form. See isStudentNameMissing.
  // The pipeline that makes this name load-bearing (it becomes `{{S}}` in
  // every summary) is a separate change; this flag stays dark in production
  // until that half is verified there too.
  | 'studentNameGate'
  // The onboarding redirect that forces a parent with no saved name to fill it
  // in before reaching the app. Only the referral console and referral links
  // display that name, so the prompt is pointless where referrals are dark.
  | 'parentNameGate'
  // CustomLogin's identifier -> /auth/start -> /auth/verify flow (see
  // docs/AUTH_API_CONTRACT.md), replacing the client-side branch that called
  // Amplify signIn first and only fell back to /auth/signup on
  // UserNotFoundException/NotAuthorizedException. Both backends are live at
  // once (the old Amplify custom-auth path keeps working either way), so this
  // flag is what makes the rollout reversible: flipping it back puts every
  // parent on today's path with no backend deploy at all.
  | 'passwordlessAuth';

// Master list, in a stable order. Add a feature here (plus the two build
// configs) to make it gateable app-wide.
export const ALL_FEATURES: Feature[] = ['tts', 'referrals', 'studentNameGate', 'parentNameGate', 'passwordlessAuth'];

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

// --- studentNameGate ---------------------------------------------------

// The literal name `getProfile` and the PostConfirmation trigger stamped onto
// every child row before this gate existed. Real profiles carry it today, so
// it is treated exactly like an empty name everywhere "no name given" is
// decided: a parent who has only ever seen this placeholder has not, in the
// sense that matters here, given a name yet.
export const DEFAULT_CHILD_NAME = 'My Child';

/**
 * True for a name that does not count as a real one: blank, whitespace-only,
 * or still the auto-created placeholder.
 */
export const isPlaceholderChildName = (name: string | null | undefined): boolean =>
  !name || name.trim() === '' || name === DEFAULT_CHILD_NAME;

/**
 * True when the profile's first child (the only one onboarding collects;
 * `children[0]` is assumed everywhere else in the app too) has no usable
 * name. Shared by every studentNameGate check so "no name given" means the
 * same thing at every one of them.
 */
export const isStudentNameMissing = (
  profile: { children?: ReadonlyArray<{ name?: string | null }> } | null | undefined,
): boolean => isPlaceholderChildName(profile?.children?.[0]?.name);
