import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useLanguage, SupportedLanguage } from '../common/language-context';
import { IconFileDescription, IconHelpCircle, IconInfoCircle, IconHome, IconWorld } from '@tabler/icons-react';
import LanguageDropdown from './LanguageDropdown';
import './LandingTopNavigation.css';

const LandingTopNavigation: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { t, language, setLanguage } = useLanguage();

  // Language options with labels
  const languageOptions = [
    { value: 'en', label: 'English' },
    { value: 'es', label: 'Español' },
    { value: 'zh', label: '中文' },
    { value: 'vi', label: 'Tiếng Việt' }
  ];

  // Handle language change
  const handleLanguageChange = (lang: SupportedLanguage) => {
    setLanguage(lang);
  };

  const navigationItems = [
    {
      icon: IconHome,
      label: t('navigation.home') || 'Home',
      route: '/'
    },
    {
      icon: IconFileDescription,
      label: t('navigation.uploadIEP') || 'Upload An IEP',
      route: '/login'
    },
    {
      icon: IconHelpCircle,
      label: t('navigation.faqs') || 'FAQs',
      route: '/faqs'
    },
    {
      icon: IconInfoCircle,
      label: t('navigation.about') || 'About The Project',
      route: '/about-the-project'
    },
  ];

  const handleNavigation = (route: string) => {
    navigate(route);
  };

  return (
    <div className="landing-top-navigation">
      <div className="navigation-container">
        {/* Left logo - desktop only */}
        <div className="nav-logo nav-logo-left" onClick={() => navigate('/')} style={{ cursor: 'pointer' }}>
          <img src="/images/logo-v-white.svg" alt="AI IEP Logo" />
        </div>

        {/* Center nav items */}
        <div className="nav-items-center">
          {navigationItems.map((item, index) => {
            const IconComponent = item.icon;
            return (
              <button
                key={index}
                className={`nav-item ${location.pathname === item.route ? 'active' : ''}`}
                onClick={() => handleNavigation(item.route)}
                aria-label={`Navigate to ${item.label}`}
              >
                <IconComponent size={24} stroke={1.5} />
                <span className="nav-label">{item.label}</span>
              </button>
            );
          })}
        </div>

        {/* Right side - Language dropdown (desktop only) */}
        <div className="nav-logo nav-logo-right">
          <LanguageDropdown
            language={language}
            languageOptions={languageOptions}
            onLanguageChange={handleLanguageChange}
          />
        </div>
      </div>
    </div>
  );
};

export default LandingTopNavigation;

