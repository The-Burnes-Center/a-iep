import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../common/language-context';
import './MultiFaceGreenBanner.css';
import CreateAccountButton from './CreateAccountButton';

const MultiFaceGreenBanner: React.FC = () => {
    const { t } = useLanguage();
    const navigate = useNavigate();

    return (
        <>
            <div className='multi-face-green-banner-container'>
                <div className='multi-face-green-banner-content' >
                    <div className='multi-face-green-banner-text-container'>
                        <h2 className='multi-face-green-banner-title'>{t("landing.greenBanner.title")}</h2>
                        <p className='multi-face-green-banner-text'>{t("landing.greenBanner.description")}</p>
                        <CreateAccountButton 
                            onClick={() => navigate('/login')} 
                            buttonText={t("landing.greenBanner.createAccountButton")}
                        />
                    </div>
                    <div className='multi-face-green-banner-faces-container'>
                        <img src="/images/9_x_9_faces.png" alt="9x9 faces" className="multi-face-green-banner-faces" />
                    </div>
                </div>
            </div>
            <div className='multi-face-green-banner-divider'>
                <img 
                    src="/images/orange-pattern-stripe-desktop.png" 
                    alt="Yellow pattern stripe" 
                    className="yellow-pattern-stripe-desktop"
                />
                <img 
                    src="/images/orange-pattern-stripe-mobile.png" 
                    alt="Yellow pattern stripe" 
                    className="yellow-pattern-stripe-mobile"
                />
            </div>
        </>
    )
}

export default MultiFaceGreenBanner;