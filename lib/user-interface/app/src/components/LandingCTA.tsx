import './LandingCTA.css';


interface LandingCTAProps {
  pretext: string;
  title: string;
  link?: string;
}

const LandingCTA = ({ pretext, title, link }: LandingCTAProps) => {
  const content = (
    <>
      <div className="landing-cta-content">
        <p className="landing-content-pretext">{pretext}</p>
        <p className="landing-content-title">{title}</p>
      </div>
      <span className="landing-cta-arrow" aria-hidden="true">
        <img className="landing-cta-arrow-icon" src="/images/arrow-icon.svg" alt="" />
      </span>
    </>
  );

  if (link) {
    return (
      <a href={link} target="_blank" rel="noopener noreferrer" className="landing-cta">
        {content}
      </a>
    );
  }

  return (
    <div className="landing-cta">
      {content}
    </div>
  );
};

export default LandingCTA;
