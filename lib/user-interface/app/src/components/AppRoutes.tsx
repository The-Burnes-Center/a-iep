import React, { useEffect } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { trackPageView } from '../common/helpers/analytics-helper';

// Auth components
import CustomLoginWrapper from './CustomLoginWrapper';

// Navigation components
import LandingTopNavigation from './LandingTopNavigation';

// Public pages
import LandingPage from '../pages/LandingPage';

// Public and Protected pages
import SupportCenter from '../pages/profile/SupportCenter';
import AboutApp from '../pages/profile/AboutApp';

// Protected pages
import PreferredLanguage from '../pages/profile/PreferredLanguage';
import OnboardingUser from '../pages/profile/OnboardingUser';
import UserProfileForm from '../pages/profile/UserProfileForm';
import WelcomePage from '../pages/WelcomePage';
import IEPDocumentView from '../pages/iep-folder/IEPDocumentView';
import SummaryAndTranslationsPage from '../pages/iep-folder/SummaryAndTranslationsPage';
import ViewAndAddChild from '../pages/profile/ViewAndAddChild';
import ViewAndAddParent from '../pages/profile/ViewAndAddParent';
import UpdateProfileName from '../pages/profile/UpdateProfileName';
import RevokeConsent from '../pages/profile/RevokeConsent';
import RightsAndOnboarding from '../pages/RightsAndOnboarding';
import ConsentForm from '../pages/profile/ConsentForm';
import WelcomeIntro from '../pages/profile/WelcomeIntro';
import FrequentlyAskedQuestions from '../components/FrequentlyAskedQuestions';
import AIEPHub from '../components/AIEPHub';
import ParentRightsCarousel from '../components/ParentRightsCarousel';
import AccountCenter from '../pages/profile/AccountCenter';
import SurveyForm from '../components/SurveyForm';
import AboutAIEP from '../components/AboutAIEP';
import DeleteAccount from '../pages/profile/DeleteAccount';
import ChangeLanguage from '../pages/profile/ChangeLanguage';
import ViewResources from '../pages/profile/ViewResources';
import AboutTheProject from '../pages/profile/AboutTheProject';
import ParentRights from '../pages/ParentRights';
import PrivacyPolicy from '../pages/PrivacyPolicy';

// Route guard
import { ProtectedRoute } from './ProtectedRoute';

export default function AppRoutes() {
  const location = useLocation();
  
  // Track page views when location changes
  useEffect(() => {
    trackPageView(location.pathname + location.search);
  }, [location]);

  return (
    <Routes>
      {/* ===== PUBLIC ROUTES ===== */}
      {/* Home/Landing page at root */}
      <Route path="/" element={<LandingPage />} />

      {/* Login page */}
      <Route path="/login" element={<CustomLoginWrapper />} />
      
      {/* FAQs - public route */}
      <Route path="/faqs" element={
        <FrequentlyAskedQuestions 
          NavigationComponent={LandingTopNavigation} 
        />
      } />


      {/* About the project - public route */}
      <Route path="/about-the-project" element={
        <AboutApp 
          NavigationComponent={LandingTopNavigation} 
          showBreadcrumbs={false} 
        />
      } />

      {/* Privacy Policy - public route */}
      <Route path="/public-privacy-policy" element={
        <PrivacyPolicy isPublic={true} />
      } />

      {/* AIEP Hub - public route */}
      <Route path="/aiep-hub" element={
        <AIEPHub 
          NavigationComponent={LandingTopNavigation} 
        />
      } />
      
      {/* ===== PROTECTED ROUTES ===== */}
      <Route element={<ProtectedRoute />}>
        {/* Landing page after login - now at /preferred-language */}
        <Route path="/preferred-language" element={<PreferredLanguage />} />
        
        {/* Onboarding flow */}
        <Route path="/onboarding-user" element={<OnboardingUser />} />
        <Route path="/consent-form" element={<ConsentForm />} />
        <Route path="/welcome-intro" element={<WelcomeIntro />} />
        <Route path="/about-the-app" element={<AboutApp />} />
        
        {/* Main app pages */}
        <Route path="/welcome-page" element={<WelcomePage />} />
        <Route path="/iep-documents" element={<IEPDocumentView />} />
        <Route path="/summary-and-translations" element={<SummaryAndTranslationsPage />} />
        
        {/* Profile & Settings */}
        <Route path="/profile" element={<UserProfileForm />} />
        <Route path="/account-center" element={<AccountCenter />} />
        <Route path="/account-center/profile" element={<UpdateProfileName />} />
        <Route path="/account-center/delete-account" element={<DeleteAccount />} />
        <Route path="/account-center/change-language" element={<ChangeLanguage />} />
        <Route path="/support-center" element={<SupportCenter />} />
        
        {/* Children & Parents */}
        <Route path="/view-update-add-child" element={<ViewAndAddChild />} />
        <Route path="/view-and-add-parent" element={<ViewAndAddParent />} />
        
        {/* Rights & Resources */}
        <Route path="/rights-and-onboarding" element={<RightsAndOnboarding />} />
        <Route path="/parent-rights" element={<ParentRights />} />
        <Route path="/rights-of-parents" element={<ParentRightsCarousel />} />
        <Route path="/view-resources" element={<ViewResources />} />
        
        {/* Other pages */}
        <Route path="/revoke-consent" element={<RevokeConsent />} />
        <Route path="/frequently-asked-questions" element={<FrequentlyAskedQuestions />} />
        <Route path="/survey-form" element={<SurveyForm />} />
        <Route path="/about-aiep" element={<AboutAIEP />} />
        <Route path="/privacy-policy" element={<PrivacyPolicy />} />
      </Route>
    </Routes>
  );
}

