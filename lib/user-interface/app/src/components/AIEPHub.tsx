import React from 'react';
import './AIEPHub.css';
import LandingContainer from './LandingContainer';
import GreenSection from './GreenSection';
import LandingHeroSection from './LandingHeroSection';
import LandingCardSection from './LandingCardSection';
import { useLanguage } from '../common/language-context';
import { Container } from 'react-bootstrap';
import AIEPSpinner from './AIEPSpinner';

interface AIEPHubProps {
  NavigationComponent?: React.ComponentType;
}

export default function AIEPHub({ NavigationComponent }: AIEPHubProps) {
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
      {NavigationComponent && <NavigationComponent />}
      <LandingHeroSection />
      <LandingCardSection />
      <GreenSection />
      <LandingContainer />
    </div>
  );
}
