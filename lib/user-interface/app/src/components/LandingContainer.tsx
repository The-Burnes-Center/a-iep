import './LandingContainer.css';
import LandingSection from './LandingSection';
import { useLanguage } from '../common/language-context';

const LandingContainer = () => {
  const { t } = useLanguage();

  return (
    <div className="landing-container">
      <LandingSection title={t('landingContainer.whyAiepExists.title')}>
        <p className="landing-content-text">{t('landingContainer.whyAiepExists.intro')}</p>
        <p className="landing-content-title">{t('landingContainer.whyAiepExists.subtitle')}</p>
        <ul>
          <li className="landing-content-list-item">{t('landingContainer.whyAiepExists.item1')}</li>
          <li className="landing-content-list-item">{t('landingContainer.whyAiepExists.item2')}</li>
          <li className="landing-content-list-item">{t('landingContainer.whyAiepExists.item3')}</li>
          <li className="landing-content-list-item">{t('landingContainer.whyAiepExists.item4')}</li>
        </ul>
        <p className="landing-content-text">{t('landingContainer.whyAiepExists.consequences')}</p>
        <p className="landing-content-text">{t('landingContainer.whyAiepExists.conclusion')}</p>
      </LandingSection>
      <LandingSection title={t('landingContainer.whatAiepDoes.title')}>
        <p className="landing-content-title">{t('landingContainer.whatAiepDoes.subtitle')}</p>
        <ul>
          <li className="landing-content-list-item">{t('landingContainer.whatAiepDoes.item1')}</li>
          <li className="landing-content-list-item">{t('landingContainer.whatAiepDoes.item2')}</li>
          <li className="landing-content-list-item">{t('landingContainer.whatAiepDoes.item3')}</li>
          <li className="landing-content-list-item">{t('landingContainer.whatAiepDoes.item4')}</li>
          <li className="landing-content-list-item">{t('landingContainer.whatAiepDoes.item5')}</li>
        </ul>
        <p className="landing-content-text">{t('landingContainer.whatAiepDoes.conclusion')}</p>
      </LandingSection>
      <LandingSection title={t('landingContainer.builtWithFamilies.title')}>
        <p className="landing-content-text">{t('landingContainer.builtWithFamilies.intro')}</p>
        <p className="landing-content-title">{t('landingContainer.builtWithFamilies.subtitle')}</p>
        <ul>
          <li className="landing-content-list-item">{t('landingContainer.builtWithFamilies.item1')}</li>
          <li className="landing-content-list-item">{t('landingContainer.builtWithFamilies.item2')}</li>
          <li className="landing-content-list-item">{t('landingContainer.builtWithFamilies.item3')}</li>
          <li className="landing-content-list-item">{t('landingContainer.builtWithFamilies.item4')}</li>
        </ul>
        <p className="landing-content-text">{t('landingContainer.builtWithFamilies.codesigners')}</p>
        <p className="landing-content-text">{t('landingContainer.builtWithFamilies.conclusion')}</p>
      </LandingSection>
    </div>
  );
};

export default LandingContainer;
