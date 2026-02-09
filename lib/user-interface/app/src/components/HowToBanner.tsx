import React from 'react';
import { useLanguage } from '../common/language-context';
import './HowToBanner.css';

const HowToBanner: React.FC = () => {
    const { t } = useLanguage();

    return (
        <div className="how-to-banner">
            <div className="how-to-banner-content">
                <h2 className="how-to-banner-title">
                    <span className="how-to-banner-title-green">{t("landing.howTo.titlePrefix")} </span>
                    <span className="how-to-banner-title-orange">{t("landing.howTo.titleSuffix")}</span>
                </h2>
            </div>
            <div className="how-to-cards-container">
                <div className="how-to-card">
                    <img src="/images/tutorial_upload.jpg" alt="Upload IEP document" className="how-to-card-image" />
                    <h2 className="how-to-card-title">{t("landing.howTo.card1.title")}</h2>
                    <p className="how-to-card-text">
                        {t("landing.howTo.card1.text")}
                    </p>
                </div>

                <div className="how-to-card">
                    <img src="/images/tutorial_select-language.jpg" alt="Select language" className="how-to-card-image" />
                    <h2 className="how-to-card-title">{t("landing.howTo.card2.title")}</h2>
                    <p className="how-to-card-text">
                        {t("landing.howTo.card2.text")}
                    </p>
                </div>

                <div className="how-to-card">
                    <img src="/images/tutorial_summary.jpg" alt="View summary" className="how-to-card-image" />
                    <h2 className="how-to-card-title">{t("landing.howTo.card3.title")}</h2>
                    <p className="how-to-card-text">
                        {t("landing.howTo.card3.text")}
                    </p>
                </div>
            </div>
            <div className="how-to-cards-container">
                <div className="how-to-card">
                    <img src="/images/tutorial_insights.jpg" alt="Key insights" className="how-to-card-image" />
                    <h2 className="how-to-card-title">{t("landing.howTo.card4.title")}</h2>
                    <p className="how-to-card-text">
                        {t("landing.howTo.card4.text")}
                    </p>
                </div>

                <div className="how-to-card">
                    <img src="/images/tutorial_glossary.jpg" alt="Complex terms" className="how-to-card-image" />
                    <h2 className="how-to-card-title">{t("landing.howTo.card5.title")}</h2>
                    <p className="how-to-card-text">
                        {t("landing.howTo.card5.text")}
                    </p>
                </div>

                <div className="how-to-card">
                    <img src="/images/tutorial_page-numbers.jpg" alt="Contrast with original" className="how-to-card-image" />
                    <h2 className="how-to-card-title">{t("landing.howTo.card6.title")}</h2>
                    <p className="how-to-card-text">
                        {t("landing.howTo.card6.text")}
                    </p>
                </div>
            </div>
        </div>
    );
};

export default HowToBanner;
