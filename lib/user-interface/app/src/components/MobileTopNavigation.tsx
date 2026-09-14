import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useLanguage } from '../common/language-context';
import { IconFileDescription, IconHeartHandshake, IconUser, IconInfoCircle } from '@tabler/icons-react';
import './MobileTopNavigation.css';

interface MobileTopNavigationProps {
  tutorialPhaseEnabled?: boolean;
  tutorialPhase?:string;
}

const MobileTopNavigation: React.FC<MobileTopNavigationProps> = ({ 
  tutorialPhaseEnabled = false,
  tutorialPhase =''
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useLanguage();

  const navigationItems = [
    {
      icon: IconFileDescription,
      label: t('navigation.summary') || 'Summary',
      route: '/summary-and-translations'
    },
    {
      icon: IconHeartHandshake,
      label: t('navigation.support') || 'Support',
      route: '/support-center'
    },
    {
      icon: IconInfoCircle,
      label: t('navigation.rights') || 'Rights',
      route: '/parent-rights'
    },
    {
      icon: IconUser,
      label: t('navigation.account') || 'Account',
      route: '/account-center'
    },
  ];

  const handleNavigation = (route: string) => {
    navigate(route);
  };

  return (
    // A landmark, not a div: it is the same bar on every in-app screen, so it
    // is what a screen reader jumps over and what AppShell's skip link skips.
    <nav className="mobile-top-navigation" aria-label={t('a11y.mainNavigation')}>
      {tutorialPhaseEnabled ?
      (

        tutorialPhase === 'app-tutorial' || tutorialPhase === 'parent-rights' ? (
        <div className="processing-line">
          {t('navigation.processing') || 'Your document is being processed...'}
        </div>
        ) :
        (<>
        <div className="processing-header">
          {t('navigation.processing') || 'Your document is being processed...'}
        </div>
        <div className="navigation-container">
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
        </>)
      ) : (
        <div className="navigation-container">
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
      )}
    </nav>
  );
};

export default MobileTopNavigation;