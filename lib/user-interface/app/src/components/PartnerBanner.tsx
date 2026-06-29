import React, { useState } from 'react';
import { useLanguage } from '../common/language-context';
import './PartnerBanner.css';

const partners = [
  { name: 'InnovateUS', url: 'https://innovate-us.org' },
  { name: 'The Burnes Center for Social Change', url: 'https://www.theburnescenter.org' },
  { name: 'Reboot Democracy', url: 'https://rebootdemocracy.ai' },
  { name: 'The Gov Lab', url: 'https://thegovlab.org' },
  { name: 'Observatory of Public Sector AI', url: 'https://innovate-us.org/research' },
  { name: 'Community-Centered AI', url: 'https://communitycentered.ai/' },
];

interface PartnerBannerProps {
  position?: 'top' | 'bottom';
}

const PartnerBanner: React.FC<PartnerBannerProps> = ({ position = 'top' }) => {
  const [isOpen, setIsOpen] = useState(false);
  const { t } = useLanguage();

  return (
    <div className="partner-banner">
      {/* Desktop view */}
      <div className="partner-banner__desktop">
        <span className="partner-banner__label">{t('partnerBanner.label')}</span>
        {partners.map((partner) => (
          <a
            key={partner.name}
            href={partner.url}
            target="_blank"
            rel="noopener noreferrer"
            className="partner-banner__link"
          >
            <img src="/images/arrow-ne.svg" alt="" className="partner-banner__icon" />
            {partner.name}
          </a>
        ))}
      </div>

      {/* Mobile view */}
      <div className="partner-banner__mobile">
        {!isOpen ? (
          <button className="partner-banner__toggle" onClick={() => setIsOpen(true)}>
            <span className="partner-banner__label">{t('partnerBanner.label')}</span>
            <img
              src="/images/arrow-down.svg"
              alt=""
              className={`partner-banner__arrow${position === 'bottom' ? ' partner-banner__arrow--up' : ''}`}
            />
          </button>
        ) : (
          <div
            className={`partner-banner__dropdown${position === 'bottom' ? ' partner-banner__dropdown--reverse' : ''}`}
            onClick={() => setIsOpen(false)}
          >
            <span className="partner-banner__dropdown-header">
              <span className="partner-banner__label">{t('partnerBanner.label')}</span>
              <img
                src="/images/arrow-down.svg"
                alt=""
                className="partner-banner__arrow partner-banner__arrow--open"
              />
            </span>
            {partners.map((partner) => (
              <a
                key={partner.name}
                href={partner.url}
                target="_blank"
                rel="noopener noreferrer"
                className="partner-banner__link"
                onClick={(e) => e.stopPropagation()}
              >
                <img src="/images/arrow-ne.svg" alt="" className="partner-banner__icon" />
                {partner.name}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default PartnerBanner;
