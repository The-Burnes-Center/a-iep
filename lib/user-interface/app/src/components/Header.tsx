import './Header.css';

interface HeaderProps {
  title: string;
}

const Header = ({ title }: HeaderProps) => {
  return (
    <div className="landing-section-header">
      <h5>{title}</h5>
    </div>
  );
};

export default Header;
