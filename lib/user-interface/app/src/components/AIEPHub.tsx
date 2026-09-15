import React from 'react';
import './AIEPHub.css';
import LandingContainer from './LandingContainer';
import GreenSection from './GreenSection';
import LandingHeroSection from './LandingHeroSection';
import LandingCardSection from './LandingCardSection';
import { useLanguage } from '../common/language-context';
import { Container } from 'react-bootstrap';
import AIEPSpinner from './AIEPSpinner';

/**
 * The public hub at /aiep-hub. The header used to arrive as a
 * `NavigationComponent` prop that only AppRoutes passed; PublicChrome renders
 * it for the whole public block now (components/RouteChrome.tsx).
 */
export default function AIEPHub() {
  const { t, translationsLoaded } = useLanguage();

  if (!translationsLoaded) {
    return (
      <Container className="mt-4 mb-5">
        <div className="text-center my-5">
          <AIEPSpinner label={t('common.loading')} />
          <p className="mt-3">{t('common.loading')}</p>
        </div>
      </Container>
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
