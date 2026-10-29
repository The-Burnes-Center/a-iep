import './LandingHeroSection.css';
import { useLanguage } from '../common/language-context';

const LandingHeroSection = () => {
  const { t } = useLanguage();

  return (
    <section className="landing-hero-section">
      <div className="landing-hero-text-container">
      <span className="landing-hero-project-about-text">{t('landingHero.aboutAIEP')}</span>
        {/* One h1. The line breaks are only shown at desktop width (see
            .landing-hero-break), so a phone reads it as one paragraph and a
            wide screen gets the four-line layout, from the same markup. */}
        <h1 className="landing-hero-text">
          {t('landingHero.title.aiep')} {t('landingHero.title.isAn')} <a href="https://ai4impact.ai/" target="_blank" rel="noopener noreferrer" className="landing-hero-text-orange landing-hero-link">{t('landingHero.title.aiForImpact')}</a> {t('landingHero.title.project')}{' '}<br className="landing-hero-break" />
          {t('landingHero.title.inPartnershipWith')} <a href="https://innovateschools.org/" target="_blank" rel="noopener noreferrer" className="landing-hero-text-blue landing-hero-link">{t('landingHero.title.innovate')}{' '}<br className="landing-hero-break" />{t('landingHero.title.publicSchools')}</a> {t('landingHero.title.builtOn')}{' '}<br className="landing-hero-break" />
          <a href="https://communitycentered.ai/" target="_blank" rel="noopener noreferrer" className="landing-hero-text-pink landing-hero-link">{t('landingHero.title.communityCenteredAI')}</a>{' '}<br className="landing-hero-break" />
          {t('landingHero.title.principles')}
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
