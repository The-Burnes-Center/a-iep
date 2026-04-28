import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../common/language-context';
import PartnerBanner from './PartnerBanner';
import './AIEPFooter.css';

interface FooterLink {
  route: string;
  labelKey: string;
}

interface AIEPFooterProps {
  footerLinks?: FooterLink[];
}

const defaultFooterLinks: FooterLink[] = [
  { route: '/summary-and-translations', labelKey: 'footer.home' },
  { route: '/iep-documents', labelKey: 'footer.uploadIEP' },
  { route: '/support-center', labelKey: 'footer.supportCenter' },
  { route: '/about-the-app', labelKey: 'footer.aboutUs' },
];

const AIEPFooter: React.FC<AIEPFooterProps> = ({ footerLinks }) => {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const isPublic = footerLinks !== undefined;
  const resolvedLinks = footerLinks ?? defaultFooterLinks;

  const handleNavigation = (route: string) => {
    navigate(route);
  };

  return (
    <>
    <footer className="aiep-footer">
      <img 
        src="/images/rainbow-stripe-desktop.png" 
        alt="Rainbow stripe" 
        className="footer-stripe-desktop"
      />
      <img 
        src="/images/rainbow-stripe-mobile.png" 
        alt="Rainbow stripe" 
        className="footer-stripe-mobile"
      />
      
      <div className="footer-content">
        <div className="footer-logo">
            <img src="/images/aiep-logo-vertical-white.svg" alt="AIEP Logo" />
            <p className="footer-tagline">{t('footer.tagline')}</p>
        </div>
        <div className="footer-links">
            <ul>
                {resolvedLinks.map((link, index) => (
                  <li key={index} onClick={() => handleNavigation(link.route)}>
                    {t(link.labelKey)}
                  </li>
                ))}
            </ul>
        </div>
        <div className="footer-project-partners">
          <div className="footer-project-partners-logo">
            <a href="https://thegovlab.org/" target="_blank" rel="noopener noreferrer">
              <img src="/images/govlab-negative.svg" alt="The Gov Lab Logo" />
            </a>
          </div>
          <div className="footer-project-partners-logo">
            <a href="https://burnes.northeastern.edu/" target="_blank" rel="noopener noreferrer">
              <img src="/images/burnes-logo-negative 1.svg" alt="The Burnes Center Logo" />
            </a>
          </div>
          <div className="footer-project-partners-logo">
            <a href="https://innovateschools.org/" target="_blank" rel="noopener noreferrer">
              <img src="/images/innovate-negative-tight 1.svg" alt="Innovate Public Schools Logo" />
            </a>
          </div>
        </div>
      </div>
    </footer>
    {isPublic && (
      <>
        <PartnerBanner position="bottom" />
        <div style={{ height: '40px', backgroundColor: '#00682F', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 1rem' }}>
          <p style={{ margin: 0, fontSize: '0.75rem', color: 'rgba(255,255,255,0.7)', lineHeight: '1.2', textAlign: 'center' }}>
            {t('auth.smsFrequencyDisclaimer')}
          </p>
        </div>
      </>
    )}
    </>
  );
};

export default AIEPFooter;

