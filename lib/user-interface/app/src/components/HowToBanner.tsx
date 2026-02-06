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
        </div>
    );
};

export default HowToBanner;
