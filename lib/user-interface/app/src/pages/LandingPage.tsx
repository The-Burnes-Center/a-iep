import React from 'react';
import LandingTopNavigation from '../components/LandingTopNavigation';
import './LandingPage.css';
import MultiFaceGreenBanner from '../components/MultiFaceGreenBanner';
import HowToBanner from '../components/HowToBanner';
import SummarizeTranslateAdvocateBanner from '../components/SummarizeTranslateAdvocateBanner';
import HeroSection from '../components/HeroSection';
import AIEPFooter from '../components/AIEPFooter';
import ParentRightsBanner from '../components/ParentRightsBanner';
import ResourcesBanner from '../components/ResourcesBanner';

const publicFooterLinks = [
    { route: '/', labelKey: 'footer.home' },
    { route: '/login', labelKey: 'footer.uploadIEP' },
    { route: '/faqs', labelKey: 'footer.faqs' },
    { route: '/about-the-project', labelKey: 'footer.aboutUs' },
];

const LandingPage: React.FC = () => { 
    return (
        <>
        <LandingTopNavigation />
        <div className="landing-page-container">
            <HeroSection />
            <SummarizeTranslateAdvocateBanner />
            <MultiFaceGreenBanner />
            <HowToBanner />
            <ParentRightsBanner />
            <ResourcesBanner />
            <AIEPFooter footerLinks={publicFooterLinks} />
        </div>
        </>

    )
}

export default LandingPage;