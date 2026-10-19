import React from 'react';
import './ResourcesBanner.css';
import { useLanguage } from '../common/language-context';
import ViewResourcesButton from './ViewResourcesButton';

const ResourcesBanner: React.FC = () => {
    const { t, translationsLoaded } = useLanguage();

    const resources = translationsLoaded ? [
        {
            title: t("resources.toolkit.title"),
            description: t("resources.toolkit.description"),
            url: "https://www.disabilityrightsca.org/resources/special-education/special-education-basics-toolkit",
            buttonText: t("resources.buttonText")
        },
        {
            title: t("resources.walletCard.title"), 
            description: t("resources.walletCard.description"),
            url: "https://www.disabilityrightsca.org/publications/know-your-rights-wallet-card",
            buttonText: t("resources.buttonText")
        },
        {
            title: t("resources.advocacyTips.title"),
            description: t("resources.advocacyTips.description"),
            url: "https://www.disabilityrightsca.org/publications/17-special-education-advocacy-tips",
            buttonText: t("resources.buttonText")
        },
        {
            title: t("resources.rulaManual.title"),
            description: t("resources.rulaManual.description"),
            url: "https://rula.disabilityrightsca.org/",
            buttonText: t("resources.buttonText")
        }
    ] : [];

    return (
        <>
            <div className='multi-face-green-banner-divider'>
                <img loading="lazy" decoding="async" 
                    src="/images/blue-pattern-stripe-desktop.png" 
                    alt="Blue pattern stripe" 
                    className="yellow-pattern-stripe-desktop"
                />
                <img loading="lazy" decoding="async" 
                    src="/images/blue-pattern-stripe-mobile.png" 
                    alt="Blue pattern stripe" 
                    className="yellow-pattern-stripe-mobile"
                />
            </div>
            <div className='resources-banner-container'>
                <div className='resources-banner-content'>
                    <h2 className='resources-banner-title'>{translationsLoaded ? t("resources.title") : "Resources"}</h2>
                    <div className='resources-banner-list-container'>
                        {resources.map((resource, index) => (
                            <div key={index} className='resources-banner-item'>
                                <h5>{resource.title}</h5>
                                <p>{resource.description}</p>
                                <ViewResourcesButton url={resource.url} buttonText={resource.buttonText} />
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </>
    );
 }

export default ResourcesBanner;
