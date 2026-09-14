import React, { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useLanguage, SupportedLanguage } from '../common/language-context';
import { LANGUAGES, filterEnabledOptions } from '../common/languages';
import { SIGN_IN_CARD_ID, SIGN_IN_HASH } from '../common/sign-in-location';
import CustomLogin from './CustomLogin';
import HowToUseToolButton from './HowToUseToolButton';
import LanguageDropdown from './LanguageDropdown';
import './CustomLogin.css';
import './HeroSection.css';

const HeroSection: React.FC = () => {
    const { t, language, setLanguage, enabledLanguages } = useLanguage();
    const languageOptions = filterEnabledOptions(LANGUAGES, enabledLanguages);
    const location = useLocation();
    const signInCard = useRef<HTMLDivElement>(null);

    // This card is the app's only sign-in form, so /login, ProtectedRoute and
    // every "Upload An IEP" link arrive here rather than on a page of their
    // own. They arrive at #sign-in, and a parent who asked for the form wants
    // the form, not the top of a marketing page with it four screens down.
    //
    // The scroll is ours to do: ScrollToTop skips any location carrying a
    // hash (see its docblock), which is exactly the hole this fills. Focus
    // moves with it, onto the card's own heading, so a screen reader says
    // "Log In" on arrival and the next Tab is the phone field — scrolling
    // alone would leave focus on <body> and announce nothing.
    //
    // Keyed on the whole location, not just the hash: tapping the same link
    // twice pushes a new entry with the same hash, and a parent who has
    // scrolled away since expects the second tap to work too.
    useEffect(() => {
        if (location.hash !== SIGN_IN_HASH) return;
        const card = signInCard.current;
        if (!card) return;
        // The container is the fallback, not the target: focusing the box
        // announces the whole form at once. It only ever applies if the card
        // renders without a heading.
        const heading = card.querySelector<HTMLElement>('h1, h2, h3, h4, h5, h6');
        (heading ?? card).focus({ preventScroll: true });
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, [location]);

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
                <div
                    className='hero-section-login-container'
                    id={SIGN_IN_CARD_ID}
                    ref={signInCard}
                    tabIndex={-1}
                >
                    <div className='hero-section-login-container-content'>
                        <CustomLogin showLogo={false} />
                    </div>
                </div>
            </div>
        </div>
    )
}

export default HeroSection;
