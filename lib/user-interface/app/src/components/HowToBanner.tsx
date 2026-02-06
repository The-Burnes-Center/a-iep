import React from 'react';
import './HowToBanner.css';

const HowToBanner: React.FC = () => {
    return (
        <div className="how-to-banner">
            <div className="how-to-banner-content">
                <h2 className="how-to-banner-title">
                    <span className="how-to-banner-title-green">How to use the </span>
                    <span className="how-to-banner-title-orange">AIEP tool</span>
                </h2>
            </div>
            <div className="how-to-cards-container">
                <div className="how-to-card">
                    <img src="/images/Summarize_Illustration.png" alt="Summarize" className="how-to-card-image" />
                    <h2 className="how-to-card-title">Summarize</h2>
                    <p className="how-to-card-text">
                        The tool will break down the key aspects of your IEP document into easy-to-understand language.
                    </p>
                </div>

                <div className="how-to-card">
                    <img src="/images/Translate_Illustration.png" alt="Translate" className="how-to-card-image" />
                    <h2 className="how-to-card-title">Translate</h2>
                    <p className="how-to-card-text">
                        AIEP can also translate the summaries of IEP documents into your the language of your choice.
                    </p>
                </div>

                <div className="how-to-card">
                    <img src="/images/Advocate_Illustration.png" alt="Advocate" className="how-to-card-image" />
                    <h2 className="how-to-card-title">Advocate</h2>
                    <p className="how-to-card-text">
                        Advocate for your child's education by exploring the IEP and understanding your rights.
                    </p>
                </div>
            </div>
        </div>
    );
};

export default HowToBanner;
