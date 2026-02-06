import './LandingCTA.css';

interface LandingCTAProps {
  pretext: string;
  title: string;
}

const LandingCTA = ({ pretext, title }: LandingCTAProps) => {
  return (
    <div className="landing-cta">
      <div className="landing-cta-content">
        <p className="landing-content-pretext">{pretext}</p>
        <p className="landing-content-title">{title}</p>
      </div>
      <img src="/images/next-btn-light.svg" alt="Next" />
    </div>
  );
};

export default LandingCTA;
