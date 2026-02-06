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
      <img src="/images/next-btn-light.svg" alt="Next" />
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
