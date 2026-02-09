import './LandingSection.css';
import type { ReactNode } from 'react';
import Header from './Header';
import LandingContent from './LandingContent';

interface LandingSectionProps {
  title: string;
  children: ReactNode;
}

const LandingSection = ({ title, children }: LandingSectionProps) => {
  return (
    <section className="landing-section">
      <Header title={title} />
      <LandingContent>
        {children}
      </LandingContent>
    </section>
  );
};

export default LandingSection;
