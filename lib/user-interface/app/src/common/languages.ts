// Single source of truth for the languages the UI supports.
//
// Which of these are actually offered to the user is controlled per
// environment via `enabledLanguages` in aws-exports.json (see
// common/types.ts, common/language-context.ts and the build/deploy config in
// vite.config.ts / lib/user-interface/index.ts). For example Arabic is enabled
// on dev/staging but disabled on prod.

export type SupportedLanguage = 'en' | 'es' | 'zh' | 'vi' | 'ar';

export interface LanguageMeta {
  value: SupportedLanguage;
  /** Endonym — the language's own name (e.g. "العربية"). Used in most pickers. */
  label: string;
  /** English name (e.g. "Arabic"). Used in English-only admin/profile views. */
  englishLabel: string;
  /** First-person preference phrase shown in the onboarding language picker. */
  translatedPreference: string;
}

// Master list, in display order. Add a language here (plus its translation
// file and any backend support) to make it available app-wide.
export const LANGUAGES: LanguageMeta[] = [
  { value: 'en', label: 'English',    englishLabel: 'English',    translatedPreference: 'I prefer English' },
  { value: 'es', label: 'Español',    englishLabel: 'Spanish',    translatedPreference: 'Prefiero Español' },
  { value: 'zh', label: '中文',        englishLabel: 'Chinese',    translatedPreference: '我喜欢中文' },
  { value: 'vi', label: 'Tiếng Việt', englishLabel: 'Vietnamese', translatedPreference: 'Tôi thích tiếng Việt' },
  { value: 'ar', label: 'العربية',    englishLabel: 'Arabic',     translatedPreference: 'أفضّل اللغة العربية' },
];

// Every supported language code, in display order.
export const ALL_LANGUAGES: SupportedLanguage[] = LANGUAGES.map((l) => l.value);

export const isSupportedLanguage = (lang: unknown): lang is SupportedLanguage =>
  typeof lang === 'string' && LANGUAGES.some((l) => l.value === lang);

/**
 * Normalize an `enabledLanguages` config value into a safe, ordered list of
 * supported codes. An empty/missing/all-invalid value falls back to every
 * language, so a misconfigured deployment never hides the language picker
 * entirely. The result preserves the master display order.
 */
export const resolveEnabledLanguages = (
  enabled: readonly string[] | undefined | null,
): SupportedLanguage[] => {
  const filtered = (enabled ?? []).filter(isSupportedLanguage);
  const allowed = filtered.length > 0 ? new Set<SupportedLanguage>(filtered) : null;
  return allowed ? ALL_LANGUAGES.filter((l) => allowed.has(l)) : ALL_LANGUAGES;
};

/**
 * Filter a list of language options down to the enabled set, preserving the
 * order of the input list.
 */
export const filterEnabledOptions = <T extends { value: SupportedLanguage }>(
  options: T[],
  enabled: readonly SupportedLanguage[],
): T[] => {
  const allowed = new Set(enabled);
  return options.filter((o) => allowed.has(o.value));
};
