import React from 'react';
import Breadcrumbs, { Crumb } from '../Breadcrumbs';
import './page.css';

interface PageShellProps {
  /** Where this screen sits. Omit on a screen that is itself a top-level tab. */
  trail?: Crumb[];
  /** 'reading' widens the column for long text (summaries, policies). */
  width?: 'task' | 'reading';
  children: React.ReactNode;
  className?: string;
}

/**
 * The one column every signed-in screen sits in.
 *
 * The UI audit (2026-11-09) measured five different column systems: a 560px
 * onboarding column, a ~600px Bootstrap container, a 608px card column,
 * full-bleed lists and edge-to-edge bands, and a breadcrumb that sat in its
 * own centred half-width box 262px away from the content under it. This sets
 * the width, the side gutters and the vertical rhythm once, and puts the
 * trail on the same left edge as everything below it.
 */
const PageShell: React.FC<PageShellProps> = ({ trail, width = 'task', children, className }) => (
  <div className={`page-shell page-shell--${width}${className ? ` ${className}` : ''}`}>
    {trail && trail.length > 0 && <Breadcrumbs trail={trail} />}
    {children}
  </div>
);

export default PageShell;
