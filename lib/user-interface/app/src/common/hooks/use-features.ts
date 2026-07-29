import { useContext, useMemo } from 'react';
import { AppContext } from '../app-context';
import { Feature, resolveEnabledFeatures } from '../features';

interface FeaturesState {
  /** Features enabled for this environment, in master order. */
  enabledFeatures: Feature[];
  /** True when `feature` is live here. Use this to gate UI entry points. */
  isFeatureEnabled: (feature: Feature) => boolean;
}

/**
 * Read the per-environment feature set from the runtime config
 * (aws-exports.json, injected by lib/user-interface/index.ts). Mirrors the way
 * `useLanguage().enabledLanguages` exposes `enabledLanguages`; no provider is
 * needed because the config is already in AppContext before any route renders
 * (see components/app-configured.tsx).
 */
export const useFeatures = (): FeaturesState => {
  const appConfig = useContext(AppContext);

  return useMemo(() => {
    const enabledFeatures = resolveEnabledFeatures(appConfig?.enabledFeatures);
    return {
      enabledFeatures,
      isFeatureEnabled: (feature: Feature) => enabledFeatures.includes(feature),
    };
  }, [appConfig]);
};
