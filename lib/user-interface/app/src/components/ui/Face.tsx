import React from 'react';

/**
 * The app's face: an amber rounded square with short thick eyes and a thick,
 * round-ended mouth, drawn after the face artwork the app already uses
 * (public/images/9_x_9_faces.png, the hero and the QR code's centre). Every
 * face anywhere in the app is this one, so they always match.
 *
 * Only the mouth's curve carries the expression, from a frown to a smile, so
 * faces in a row differ in one feature and read left to right at a glance.
 * Every face is the same size with its features in the same place: placed in
 * a row, the eye compares them moving sideways only (UI_STANDARDS.md, Faces).
 *
 * A face is decoration beside words, never a replacement for them: it is
 * aria-hidden, and the answer it shows is always written next to it.
 */

import { FACE_MOOD, FaceExpression, mouthPath } from './face-shape';

interface FaceProps {
  /** Which face. 'unsure' is a dashed box with a question mark, not a face; 'empty' is a face not yet chosen. */
  expression?: FaceExpression;
  /** A mood between -1 and 1 instead of a named answer, for a face that moves (a slider). */
  mood?: number;
  /** Width and height in px. */
  size?: number;
  className?: string;
}

const Face: React.FC<FaceProps> = ({ expression = 'empty', mood, size = 40, className }) => {
  const classes = `ui-face${className ? ` ${className}` : ''}`;
  if (expression === 'unsure' && mood === undefined) {
    // Not a point on the scale, so not a face: a dashed box the same size,
    // lined up with them. --aiep-face-ring turns it solid when chosen (ui.css).
    return (
      <svg className={classes} viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" focusable="false" data-expression="unsure">
        <rect
          x="5" y="5" width="38" height="38" rx="13" fill="none"
          style={{ stroke: 'var(--aiep-face-ring, var(--aiep-border))', strokeDasharray: 'var(--aiep-face-dash, 5 4)' }}
          strokeWidth="2.5"
        />
        <text x="24" y="30" textAnchor="middle" fontSize="16" fontWeight="700" style={{ fill: 'var(--aiep-face-ring, var(--aiep-muted))' }}>?</text>
      </svg>
    );
  }
  const blank = expression === 'empty' || expression === 'unsure';
  const curve = mood ?? (blank ? 0 : FACE_MOOD[expression as keyof typeof FACE_MOOD]);
  return (
    <svg
      className={classes}
      viewBox="0 0 48 48"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      data-expression={mood === undefined ? expression : 'mood'}
    >
      <rect
        x="3" y="3" width="42" height="42" rx="15"
        style={{ fill: blank && mood === undefined ? 'var(--aiep-surface-field)' : 'var(--aiep-face)', stroke: 'var(--aiep-cream)' }}
        strokeWidth="1.5"
      />
      <path d="M18 16.5 L18 21" style={{ stroke: 'var(--aiep-ink)' }} strokeWidth="4.2" strokeLinecap="round" />
      <path d="M30.5 15.5 L30.5 20" style={{ stroke: 'var(--aiep-ink)' }} strokeWidth="4.2" strokeLinecap="round" />
      <path data-mouth d={mouthPath(curve)} style={{ stroke: 'var(--aiep-ink)' }} strokeWidth="3.8" fill="none" strokeLinecap="round" />
    </svg>
  );
};

export default Face;
