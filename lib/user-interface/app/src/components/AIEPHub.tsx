import React from 'react';
import './AIEPHub.css';
import LandingContainer from './LandingContainer';
import GreenSection from './GreenSection';
import LandingHeroSection from './LandingHeroSection';
import LandingCardSection from './LandingCardSection';
import { useLanguage } from '../common/language-context';
import PageLoading from './PageLoading';

/**
 * The public hub at /aiep-hub. The header used to arrive as a
 * `NavigationComponent` prop that only AppRoutes passed; PublicChrome renders
 * it for the whole public block now (components/RouteChrome.tsx).
 */
export default function AIEPHub() {
  const { t, translationsLoaded } = useLanguage();

  if (!translationsLoaded) {
    return (
      <PageLoading message={t('common.loading')} />
    );
  }

  return (
    <div>
      <LandingHeroSection />
      <LandingCardSection />
      <GreenSection />
      <LandingContainer />
    </div>
  );
}
