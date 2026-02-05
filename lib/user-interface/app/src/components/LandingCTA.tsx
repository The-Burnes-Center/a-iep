interface LandingCTAProps {
  pretext: string;
  title: string;
}

const LandingCTA = ({ pretext, title }: LandingCTAProps) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', border: '1px solid #CBC6BC', borderRadius: '20px', padding: '16px', margin: '16px 0' }}>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <p className="landing-content-pretext">{pretext}</p>
        <p className="landing-content-title">{title}</p>
      </div>
      <img src="/images/next-btn-light.svg" alt="Next" />
    </div>
  );
};

export default LandingCTA;
