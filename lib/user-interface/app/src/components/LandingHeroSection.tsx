import './LandingHeroSection.css';
import { useLanguage } from '../common/language-context';

const LandingHeroSection = () => {
  const { t } = useLanguage();

  return (
    <section className="landing-hero-section">
      <div className="landing-hero-text-container">
      <span className="landing-hero-project-about-text">{t('landingHero.aboutAIEP')}</span>
        {/* Desktop h1 - with line breaks */}
        <h1 className="landing-hero-text landing-hero-text-desktop">
          {t('landingHero.title.aiep')} {t('landingHero.title.isAn')} <a href="https://ai4impact.ai/" target="_blank" rel="noopener noreferrer" className="landing-hero-text-orange landing-hero-link">{t('landingHero.title.aiForImpact')}</a> {t('landingHero.title.project')}<br />
          {t('landingHero.title.inPartnershipWith')} <a href="https://innovateschools.org/" target="_blank" rel="noopener noreferrer" className="landing-hero-text-blue landing-hero-link">{t('landingHero.title.innovate')}</a><br />
          <a href="https://innovateschools.org/" target="_blank" rel="noopener noreferrer" className="landing-hero-text-blue landing-hero-link">{t('landingHero.title.publicSchools')}</a> {t('landingHero.title.builtOn')}<br />
          <a href="https://communitycentered.ai/" target="_blank" rel="noopener noreferrer" className="landing-hero-text-pink landing-hero-link">{t('landingHero.title.communityCenteredAI')}</a><br />
          {t('landingHero.title.principles')}
        </h1>
        {/* Mobile h1 - without line breaks */}
        <h1 className="landing-hero-text landing-hero-text-mobile">
          {t('landingHero.title.aiep')} {t('landingHero.title.isAn')} <a href="https://ai4impact.ai/" target="_blank" rel="noopener noreferrer" className="landing-hero-text-orange landing-hero-link">{t('landingHero.title.aiForImpact')}</a> {t('landingHero.title.project')} {t('landingHero.title.inPartnershipWith')} <a href="https://innovateschools.org/" target="_blank" rel="noopener noreferrer" className="landing-hero-text-blue landing-hero-link">{t('landingHero.title.innovate')} {t('landingHero.title.publicSchools')}</a> {t('landingHero.title.builtOn')} <a href="https://communitycentered.ai/" target="_blank" rel="noopener noreferrer" className="landing-hero-text-pink landing-hero-link">{t('landingHero.title.communityCenteredAI')}</a> {t('landingHero.title.principles')}
        </h1>
        <div className="landing-hero-project-by">
          <span className="landing-hero-project-by-text">{t('landingHero.projectBy')}</span>
          <div className="landing-hero-logos">
            <a href="https://thegovlab.org/" target="_blank" rel="noopener noreferrer">
              <img src="/images/the-govlab-logo.svg" alt="The GovLab logo" className="landing-hero-logo" style={{ height: '30px' }} />
            </a>
            <a href="https://burnes.northeastern.edu/" target="_blank" rel="noopener noreferrer">
              <img src="/images/burnes-center-logo.svg" alt="Burnes Center logo" className="landing-hero-logo" style={{ height: '50px' }} />
            </a>
            <a href="https://innovateschools.org/" target="_blank" rel="noopener noreferrer">
              <img src="/images/innovate_logo.png" alt="Innovate logo" className="landing-hero-logo" />
            </a>
          </div>
        </div>
      </div>
      <div className="landing-hero-image-container">
        <img src="/images/hero-section-image.png" alt="Hero illustration" className="landing-hero-image" />
      </div>
    </section>
  );
};

export default LandingHeroSection;
