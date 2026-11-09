import React from 'react';
import './page.css';

interface PageHeroProps {
  title: string;
  /** One line under the title. Optional: some screens need only the name. */
  description?: string;
  /** The h1's id, for the section's aria-labelledby. */
  titleId: string;
  /** The home screen's faces illustration on the hero's side. */
  showFaces?: boolean;
  /** Anything that belongs in the band itself (a chip, a control). */
  children?: React.ReactNode;
}

/**
 * The opening band of a screen, in the brand's own artwork: the invite
 * page's dark-green grid paper and four-colour accent stripe (drawn in CSS,
 * so nothing is fetched) with, optionally, the home screen's faces
 * illustration. It carries the screen's one h1, which ten screens were
 * missing (UI audit, 2026-11-09).
 *
 * The faces are decoration: no alt text, and hidden on a narrow phone where
 * they would push the heading down.
 */
const PageHero: React.FC<PageHeroProps> = ({ title, description, titleId, showFaces = true, children }) => (
  <section className="page-hero" aria-labelledby={titleId}>
    <div className="page-hero-text">
      <h1 id={titleId} className="page-hero-title">{title}</h1>
      {description && <p className="page-hero-description">{description}</p>}
      {children}
    </div>
    {showFaces && (
      <img
        className="page-hero-faces"
        src="/images/9_x_9_faces.png"
        alt=""
        aria-hidden="true"
        loading="lazy"
        decoding="async"
      />
    )}
  </section>
);

export default PageHero;
