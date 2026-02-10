import './LandingContainer.css';
import './LandingContainerBottom.css';
import LandingSection from './LandingSection';
import OrangeHeader from './OrangeHeader';
import LandingContent from './LandingContent';
import LandingCTA from './LandingCTA';
import { useLanguage } from '../common/language-context';

const LandingContainerBottom = () => {
  const { t } = useLanguage();

  return (
    <div className="landing-container">
      <LandingSection title={t('landingContainer.communityCenteredAI.title')}>
        <p className="landing-content-text">{t('landingContainer.communityCenteredAI.intro')}</p>
        {/* <LandingCTA pretext={t('landingContainer.cta.exploreMore.pretext')} title={t('landingContainer.cta.exploreMore.title')} /> */}
        {/* <LandingCTA pretext={t('landingContainer.cta.writing.pretext')} title={t('landingContainer.cta.writing.title')} /> */}
        <div className="landing-cta-row">
          <LandingCTA pretext={t('landingContainer.cta.course.pretext')} title={t('landingContainer.cta.course.title')} link="https://bit.ly/civic-ai-course" />
          {/* <LandingCTA pretext={t('landingContainer.cta.research.pretext')} title={t('landingContainer.cta.research.title')} /> */}
        </div>
        <p className="landing-content-text">{t('landingContainer.communityCenteredAI.text1')}</p>
        <p className="landing-content-text">{t('landingContainer.communityCenteredAI.text2')}</p>
        <p className="landing-content-title">{t('landingContainer.communityCenteredAI.subtitle')}</p>
        <ul>
          <li className="landing-content-list-item">{t('landingContainer.communityCenteredAI.item1')}</li>
          <li className="landing-content-list-item">{t('landingContainer.communityCenteredAI.item2')}</li>
          <li className="landing-content-list-item">{t('landingContainer.communityCenteredAI.item3')}</li>
          <li className="landing-content-list-item">{t('landingContainer.communityCenteredAI.item4')}</li>
        </ul>
        <p className="landing-content-text">{t('landingContainer.communityCenteredAI.conclusion')}</p>
      </LandingSection>
      <LandingSection title={t('landingContainer.privacyAndTrust.title')}>
        <p className="landing-content-text">{t('landingContainer.privacyAndTrust.intro')}</p>
        <p className="landing-content-title">{t('landingContainer.privacyAndTrust.subtitle')}</p>
        <ul>
          <li className="landing-content-list-item">{t('landingContainer.privacyAndTrust.item1')}</li>
          <li className="landing-content-list-item">{t('landingContainer.privacyAndTrust.item2')}</li>
          <li className="landing-content-list-item">{t('landingContainer.privacyAndTrust.item3')}</li>
          <li className="landing-content-list-item">{t('landingContainer.privacyAndTrust.item4')}</li>
        </ul>
        <p className="landing-content-title">{t('landingContainer.privacyAndTrust.conclusion')}</p>
        <img 
          src="/images/privacy-diagram-en.jpg" 
          alt={t('landingContainer.privacyAndTrust.diagramAlt')} 
          className="privacy-diagram"
        />
      </LandingSection>
      <LandingSection title={t('landingContainer.moreThanATool.title')}>
        <p className="landing-content-text">{t('landingContainer.moreThanATool.intro')}</p>
        <p className="landing-content-title">{t('landingContainer.moreThanATool.subtitle')}</p>
        <ul>
          <li className="landing-content-list-item">{t('landingContainer.moreThanATool.item1')}</li>
          <li className="landing-content-list-item">{t('landingContainer.moreThanATool.item2')}</li>
          <li className="landing-content-list-item">{t('landingContainer.moreThanATool.item3')}</li>
          <li className="landing-content-list-item">{t('landingContainer.moreThanATool.item4')}</li>
        </ul>
        <p className="landing-content-title">{t('landingContainer.moreThanATool.conclusion')}</p>
      </LandingSection>
      <OrangeHeader title={t('landingContainer.aboutProject.title')} />
      <LandingContent>
        <p className="landing-content-text">{t('landingContainer.aboutProject.text1')}</p>
        <p className="landing-content-text">{t('landingContainer.aboutProject.text2')}</p>
        <LandingCTA pretext={t('landingContainer.cta.tryTool.pretext')} title={t('landingContainer.cta.tryTool.title')} link="/" />
        <LandingCTA pretext={t('landingContainer.cta.learnHow.pretext')} title={t('landingContainer.cta.learnHow.title')} link="https://drive.google.com/file/d/1ijmrBXrc0p-7ryOl0dXUzQ8Z4zcXdV5M/view?usp=sharing" />
        {/* <LandingCTA pretext={t('landingContainer.cta.explore.pretext')} title={t('landingContainer.cta.explore.title')} /> */}
      </LandingContent>
    </div>
  );
};

export default LandingContainerBottom;
