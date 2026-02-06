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
                    <img src="/images/tutorial_upload.jpg" alt="Upload IEP document" className="how-to-card-image" />
                    <h2 className="how-to-card-title">Upload an IEP to the tool</h2>
                    <p className="how-to-card-text">
                        After signing up, you will be able to upload your child's IEP document as a document file (doc or docx) or a PDF.
                    </p>
                </div>

                <div className="how-to-card">
                    <img src="/images/tutorial_select-language.jpg" alt="Select language" className="how-to-card-image" />
                    <h2 className="how-to-card-title">Translate the IEP to your preferred language</h2>
                    <p className="how-to-card-text">
                        Your uploaded IEP will be translated to the language you chose at sign up and will also be available in English.
                    </p>
                </div>

                <div className="how-to-card">
                    <img src="/images/tutorial_summary.jpg" alt="View summary" className="how-to-card-image" />
                    <h2 className="how-to-card-title">Get a first glimpse of the entire IEP document</h2>
                    <p className="how-to-card-text">
                        At the top of the screen, you will find a short summary of the information we found on your IEP document.
                    </p>
                </div>
            </div>
            <div className="how-to-cards-container">
                <div className="how-to-card">
                    <img src="/images/tutorial_insights.jpg" alt="Key insights" className="how-to-card-image" />
                    <h2 className="how-to-card-title">Understand the main insights from the IEP</h2>
                    <p className="how-to-card-text">
                        In the sections below, you will find the key insights we drew from the document you uploaded. Click on the titles to read the information.
                    </p>
                </div>

                <div className="how-to-card">
                    <img src="/images/tutorial_glossary.jpg" alt="Complex terms" className="how-to-card-image" />
                    <h2 className="how-to-card-title">Find the meaning of complex terms</h2>
                    <p className="how-to-card-text">
                        Whenever you see a blue word, you will be able to click on it to show its definition. When you're done, click on the X to return to your summary.
                    </p>
                </div>

                <div className="how-to-card">
                    <img src="/images/tutorial_page-numbers.jpg" alt="Contrast with original" className="how-to-card-image" />
                    <h2 className="how-to-card-title">Contrast the content with the original IEP</h2>
                    <p className="how-to-card-text">
                        Below the title of each key insight, you will find the page number where we took the information from. Always double check!
                    </p>
                </div>
            </div>
        </div>
    );
};

export default HowToBanner;
