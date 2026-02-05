import './LandingContainer.css';
import LandingSection from './LandingSection';
import OrangeHeader from './OrangeHeader';
import LandingContent from './LandingContent';
import { useLanguage } from '../common/language-context';

const LandingContainerBottom = () => {
  const { t } = useLanguage();

  return (
    <div className="landing-container">
      <LandingSection title={t('landingContainer.communityCenteredAI.title')}>
        <p className="landing-content-text">{t('landingContainer.communityCenteredAI.intro')}</p>
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
      <OrangeHeader title={"About the project"} />
      <LandingContent>
        <p className="landing-content-text">AI for IEPs is a project of the Burnes Center for Social Change and its AI for Impact, developed in partnership with Innovate Public Schools and families in California.</p>
        <p className="landing-content-text">
          The project was supported by grants from the Chan Zuckerberg Initiative and the Burnes Center for Social Change.
        </p>
      </LandingContent>
    </div>
  );
};

export default LandingContainerBottom;
