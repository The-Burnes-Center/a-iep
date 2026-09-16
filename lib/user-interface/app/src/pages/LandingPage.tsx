import React from 'react';
import './LandingPage.css';
import MultiFaceGreenBanner from '../components/MultiFaceGreenBanner';
import HowToBanner from '../components/HowToBanner';
import SummarizeTranslateAdvocateBanner from '../components/SummarizeTranslateAdvocateBanner';
import HeroSection from '../components/HeroSection';
import ParentRightsBanner from '../components/ParentRightsBanner';
import ResourcesBanner from '../components/ResourcesBanner';

const LandingPage: React.FC = () => { 
    return (
        <>
        <div className="landing-page-container">
            <HeroSection />
            <SummarizeTranslateAdvocateBanner />
            <MultiFaceGreenBanner />
            <HowToBanner />
            <ParentRightsBanner />
            <ResourcesBanner />
        </div>
        </>

    )
}

export default LandingPage;