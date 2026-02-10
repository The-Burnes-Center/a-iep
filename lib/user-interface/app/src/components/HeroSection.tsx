import React from 'react';
import { useLanguage, SupportedLanguage } from '../common/language-context';
import CustomLogin from './CustomLogin';
import HowToUseToolButton from './HowToUseToolButton';
import LanguageDropdown from './LanguageDropdown';
import './CustomLogin.css';
import './HeroSection.css';

const languageOptions = [
    { value: 'en', label: 'English' },
    { value: 'es', label: 'Español' },
    { value: 'zh', label: '中文' },
    { value: 'vi', label: 'Tiếng Việt' },
];

const HeroSection: React.FC = () => { 
    const { t, language, setLanguage } = useLanguage();
    
    return (
        <div className='hero-section-container'>
            <div className='hero-section-content'>
                <div className='hero-section-mobile-language-dropdown'>
                    <LanguageDropdown 
                        language={language}
                        languageOptions={languageOptions}
                        onLanguageChange={(lang: SupportedLanguage) => setLanguage(lang)}
                    />
                </div>
                <div className='hero-section-image-container'>
                    <img src="/images/hero-section-image.png" alt="Hero Section Image" className='hero-section-image' />
                    <div className='hero-illustration-text-container'>
                        <h2 className='hero-illustration-title'>{t('hero.title')}</h2>
                        <p className='hero-illustration-text'>{t('hero.description')}</p>
                        <HowToUseToolButton
                            buttonText={t('hero.howToUseTool')}
                            onClick={() => {
                                const howToBanner = document.getElementById('how-to-banner');
                                if (howToBanner) {
                                    howToBanner.scrollIntoView({ behavior: 'smooth' });
                                }
                            }}
                        />
                    </div>
                </div>
                <div className='hero-section-login-container'>
                    <div className='hero-section-login-container-content'>
                        <CustomLogin showLogo={false} />
                    </div> 
                </div>
            </div>
        </div>
    )
}

export default HeroSection;