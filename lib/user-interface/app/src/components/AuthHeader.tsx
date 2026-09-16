import './AuthHeader.css';
interface AuthHeaderProps {
  title: string;
  logoSrc?: string;
  logoAlt?: string;
  className?: string;
  showLogo?: boolean;
}

const AuthHeader: React.FC<AuthHeaderProps> = ({ 
  title, 
  logoSrc = "/images/aiep-logo-vertical.svg",
  logoAlt = "AIEP Logo",
  className = '',
  showLogo = true
}) => {
  return (
    <div className={`text-center mb-4 ${className}`}>
      {showLogo && (
        <img 
          src={logoSrc} 
          alt={logoAlt} 
          className="aiep-logo mb-3" 
        />
      )}
      {/* Focusable, but never in the tab order. The landing page moves focus
          here when a parent arrives at the sign-in card from /login, from a
          protected page they were not signed in for, or from an "Upload An
          IEP" link, so this heading is what gets announced on arrival.
          -1 keeps it out of the tab sequence, so nobody tabbing through the
          form itself ever stops on it. */}
      <h4 tabIndex={-1}>{title}</h4>
    </div>
  );
};

export default AuthHeader;