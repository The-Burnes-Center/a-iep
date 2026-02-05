import './OrangeHeader.css';

interface OrangeHeaderProps {
  title: string;
}

const OrangeHeader = ({ title }: OrangeHeaderProps) => {
  return (
    <div className="landing-section-header-orange">
      <h5>{title}</h5>
    </div>
  );
};

export default OrangeHeader;
