import React from 'react';
import './MyChildren.css';

interface ChildrenHeroProps {
  title: string;
  description: string;
  /** The h1's id, for the section's aria-labelledby. */
  titleId: string;
}

/**
 * The opening band of My children and the add and edit screens, in the
 * brand's own artwork: the invite page's dark-green grid paper and accent
 * stripe (drawn in CSS, InvitePage.css), with the home screen's faces
 * illustration (MultiFaceGreenBanner) on its side. The faces are decoration,
 * so they carry no alt text and are hidden on a narrow phone, where they
 * would push the heading down.
 */
const ChildrenHero: React.FC<ChildrenHeroProps> = ({ title, description, titleId }) => (
  <section className="children-hero" aria-labelledby={titleId}>
    <div className="children-hero-text">
      <h1 id={titleId} className="children-hero-title">{title}</h1>
      <p className="children-hero-description">{description}</p>
    </div>
    <img
      className="children-hero-faces"
      src="/images/9_x_9_faces.png"
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
    />
  </section>
);

export default ChildrenHero;
