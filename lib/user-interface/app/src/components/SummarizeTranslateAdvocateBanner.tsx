import { useLanguage } from '../common/language-context';
import './SummarizeTranslateAdvocateBanner.css';

const SummarizeTranslateAdvocateBanner: React.FC = () => {
    const { t } = useLanguage();

    return (
        <div className='summarize-translate-advocate-banner-container'>

        <div className='summarize-translate-advocate-cards-container'>
            <div className='summarize-translate-advocate-card'>
                <img loading="lazy" decoding="async" width={327} height={327} src="/images/Summarize_Illustration.png" alt="Summarize" className='summarize-translate-advocate-image' />
                <h2 className='summarize-translate-advocate-title'>{t("onboarding.carousel.heading.summarize")}</h2>
                <p className='summarize-translate-advocate-text'>
                    {t("onboarding.carousel.paragraph.summarize")}
                </p>
            </div>
        
            <div className='summarize-translate-advocate-card'>
                <img loading="lazy" decoding="async" width={327} height={327} src="/images/Translate_Illustration.png" alt="Translate" className='summarize-translate-advocate-image' />
                <h2 className='summarize-translate-advocate-title'>{t("onboarding.carousel.heading.translate")}</h2>
                <p className='summarize-translate-advocate-text'>
                    {t("onboarding.carousel.paragraph.translate")}
                </p>
            </div>


            <div className='summarize-translate-advocate-card'>
                <img loading="lazy" decoding="async" width={327} height={327} src="/images/Advocate_Illustration.png" alt="Advocate" className='summarize-translate-advocate-image' />
                <h2 className='summarize-translate-advocate-title'>{t("onboarding.carousel.heading.advocate")}</h2>
                <p className='summarize-translate-advocate-text'>
                    {t("onboarding.carousel.paragraph.advocate")}
                </p>
            </div>   
        </div>
        
        </div>
    )
}

export default SummarizeTranslateAdvocateBanner;