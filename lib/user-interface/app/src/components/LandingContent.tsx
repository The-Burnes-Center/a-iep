import './LandingContent.css';
import type { ReactNode } from 'react';

interface LandingContentProps {
  children: ReactNode;
}

const LandingContent = ({ children }: LandingContentProps) => {
  return (
    <div className="landing-content">
      {children}
    </div>
  );
};

export default LandingContent;
