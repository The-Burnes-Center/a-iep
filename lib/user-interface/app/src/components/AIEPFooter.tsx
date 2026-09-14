import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../common/auth-provider';
import { useLanguage } from '../common/language-context';
import { SIGN_IN_ROUTE } from '../common/sign-in-location';
import PartnerBanner from './PartnerBanner';
import './AIEPFooter.css';

interface FooterLink {
  route: string;
  labelKey: string;
}

/**
 * Where the four links go before a parent has signed in. Identical copies of
 * this array used to sit in five files (the landing page, the FAQs, the hub,
 * the public privacy policy and About), and a sixth screen decided between
 * them with a props spread.
 *
 * The Upload link is the sign-in card's hash, not a bare '/': see
 * common/sign-in-location.ts for why the hash is load-bearing.
 */
const PUBLIC_LINKS: FooterLink[] = [
  { route: '/', labelKey: 'footer.home' },
  { route: SIGN_IN_ROUTE, labelKey: 'footer.uploadIEP' },
  { route: '/faqs', labelKey: 'footer.faqs' },
  { route: '/about-the-project', labelKey: 'footer.aboutUs' },
];

/** The same four destinations, once the parent is inside the app. */
const SIGNED_IN_LINKS: FooterLink[] = [
  { route: '/summary-and-translations', labelKey: 'footer.home' },
  { route: '/iep-documents', labelKey: 'footer.uploadIEP' },
  { route: '/support-center', labelKey: 'footer.supportCenter' },
  { route: '/about-the-app', labelKey: 'footer.aboutUs' },
];

/**
 * The one footer, rendered once by AppShell for every screen.
 *
 * Which set of links it carries is read from the session rather than passed in
 * by the screen. That is the same question LandingTopNavigation answers for
 * its own Upload item (`uploadRoute`), and answering it the same way is what
 * stops a signed-in parent being offered the sign-in card from the bottom of a
 * page they reached while signed in. It also means the partner strip and the
 * SMS-frequency line — both of which exist for someone about to sign up —
 * appear exactly where they are for, instead of wherever a caller remembered
 * to pass `footerLinks`.
 */
const AIEPFooter: React.FC = () => {
  const { t } = useLanguage();
  const { authenticated, loading } = useAuth();
  const navigate = useNavigate();

  const links = authenticated ? SIGNED_IN_LINKS : PUBLIC_LINKS;
  // `!loading` as well, not just `!authenticated`: on a page load the session
  // check has not answered yet, and rendering these two strips on the strength
  // of the not-yet-resolved default would pop 73px of footer in and back out
  // again underneath the route guard's spinner.
  const showSignUpStrips = !authenticated && !loading;

  return (
    <>
    <footer className="aiep-footer">
      {/* alt="", not "Rainbow stripe": it is a divider, and this footer is now
          on every screen, so a name here is a word read out 29 times. */}
      <img
        src="/images/rainbow-stripe-desktop.png"
        alt=""
        className="footer-stripe-desktop"
      />
      <img
        src="/images/rainbow-stripe-mobile.png"
        alt=""
        className="footer-stripe-mobile"
      />

      <div className="footer-content">
        <div className="footer-logo">
            <img src="/images/aiep-logo-vertical-white.svg" alt="AIEP Logo" />
            <p className="footer-tagline">{t('footer.tagline')}</p>
        </div>
        <div className="footer-links">
            <ul>
                {/* Buttons, not bare <li onClick>: these four were not in the
                    tab order and could not be triggered from a keyboard, and
                    the footer is now on every screen in the app. */}
                {links.map((link) => (
                  <li key={link.route}>
                    <button
                      type="button"
                      className="footer-link"
                      onClick={() => navigate(link.route)}
                    >
                      {t(link.labelKey)}
                    </button>
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
    {showSignUpStrips && (
      <>
        <PartnerBanner position="bottom" />
        {/* 0.85, not 0.7: at 0.7 this 12px line was 4.27:1 on the green. */}
        <div style={{ height: '40px', backgroundColor: 'var(--aiep-green)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 1rem' }}>
          <p style={{ margin: 0, fontSize: '0.75rem', color: 'rgba(255,255,255,0.85)', lineHeight: '1.2', textAlign: 'center' }}>
            {t('auth.smsFrequencyDisclaimer')}
          </p>
        </div>
      </>
    )}
    </>
  );
};

export default AIEPFooter;
