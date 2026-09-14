import React from 'react';
import './AIEPHub.css';
import LandingContainer from './LandingContainer';
import GreenSection from './GreenSection';
import LandingHeroSection from './LandingHeroSection';
import LandingCardSection from './LandingCardSection';
import AIEPFooter from './AIEPFooter';
import { useLanguage } from '../common/language-context';
import { SIGN_IN_ROUTE } from '../common/sign-in-location';
import { Container } from 'react-bootstrap';

const publicFooterLinks = [
  { route: '/', labelKey: 'footer.home' },
  { route: SIGN_IN_ROUTE, labelKey: 'footer.uploadIEP' },
  { route: '/faqs', labelKey: 'footer.faqs' },
  { route: '/about-the-project', labelKey: 'footer.aboutUs' },
];

interface AIEPHubProps {
  NavigationComponent?: React.ComponentType;
}

export default function AIEPHub({ NavigationComponent }: AIEPHubProps) {
  const { translationsLoaded } = useLanguage();

  if (!translationsLoaded) {
    return (
      <Container className="mt-4 mb-5">
        <div className="text-center my-5">
          <div className="spinner-border text-primary" role="status">
            <span className="visually-hidden">Loading...</span>
          </div>
          <p className="mt-3">Loading...</p>
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
      <AIEPFooter footerLinks={publicFooterLinks} />
    </div>
  );
}
