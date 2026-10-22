/**
 * The invite link as a QR code, drawn in the app's own palette.
 *
 * Inline SVG built from a locally computed matrix: no canvas, no image, no
 * third-party QR service, for the same reasons the invite icons are inline
 * (blocked resources on school and public networks, and not handing the
 * referral code to anyone else). See invite-qr-layout.ts for the design and
 * for why it still scans.
 *
 * Modules grow in from the centre on first paint. The animation is CSS only
 * and is switched off under prefers-reduced-motion.
 */
import React, { useId, useMemo } from 'react';
import { buildQrLayout, QUIET_ZONE, type ExposedCorners } from './invite-qr-layout';
import './InviteQrCode.css';

/**
 * Radius of an exposed module corner, in modules. Every module fills its whole
 * cell: an earlier version inset them to read as separate tiles, and the white
 * gaps stopped jsQR decoding the browser's rendering at 300px and up.
 */
const CORNER_RADIUS = 0.42;

/** One cell, with only the exposed corners rounded. Absolute commands only. */
const modulePath = (x: number, y: number, corners: ExposedCorners) => {
  const tl = corners.topLeft ? CORNER_RADIUS : 0;
  const tr = corners.topRight ? CORNER_RADIUS : 0;
  const br = corners.bottomRight ? CORNER_RADIUS : 0;
  const bl = corners.bottomLeft ? CORNER_RADIUS : 0;
  return [
    `M${x + tl} ${y}`,
    `H${x + 1 - tr}`,
    tr ? `A${tr} ${tr} 0 0 1 ${x + 1} ${y + tr}` : '',
    `V${y + 1 - br}`,
    br ? `A${br} ${br} 0 0 1 ${x + 1 - br} ${y + 1}` : '',
    `H${x + bl}`,
    bl ? `A${bl} ${bl} 0 0 1 ${x} ${y + 1 - bl}` : '',
    `V${y + tl}`,
    tl ? `A${tl} ${tl} 0 0 1 ${x + tl} ${y}` : '',
    'Z',
  ].join('');
};

/** The longest delay any module waits before growing in. */
const GROW_STAGGER_MS = 520;

/** Inset of the face inside its cleared square, so it does not touch modules. */
const BADGE_INSET = 0.5;

interface InviteQrCodeProps {
  value: string;
  /** Accessible name; a screen reader cannot scan, so say what it is. */
  label: string;
  className?: string;
}

/**
 * The amber face from the app's illustrations, sized to the badge.
 *
 * Positioned by a nested <svg>'s x/y/width/height rather than a transform
 * attribute: the grow-in animation sets the CSS transform property, which
 * overrides a transform attribute and would throw the face onto the top-left
 * finder eye.
 */
function BadgeFace({ x, y, size }: { x: number; y: number; size: number }) {
  // Drawn on a 10x10 grid, then scaled to the badge by the viewBox.
  return (
    <svg x={x} y={y} width={size} height={size} viewBox="0 0 10 10" className="invite-qr-badge">
      <g className="invite-qr-face">
        <rect width="10" height="10" rx="3" className="invite-qr-face-bg" />
        <circle cx="3.4" cy="4" r="0.75" className="invite-qr-face-ink" />
        <circle cx="6.6" cy="4" r="0.75" className="invite-qr-face-ink" />
        <path
          d="M3 6.1 Q5 8.1 7 6.1"
          fill="none"
          strokeWidth="0.75"
          strokeLinecap="round"
          className="invite-qr-face-smile"
        />
      </g>
    </svg>
  );
}

export default function InviteQrCode({ value, label, className }: InviteQrCodeProps) {
  const layout = useMemo(() => buildQrLayout(value), [value]);
  // Both the page and the overlay draw a code, so the gradient id is unique.
  const gradientId = `invite-qr-ink-${useId().replace(/:/g, '')}`;
  const ink = `url(#${gradientId})`;
  const extent = layout.size + QUIET_ZONE * 2;
  const badgeOrigin = layout.badge.start + QUIET_ZONE + BADGE_INSET;
  const badgeSize = layout.badge.span - BADGE_INSET * 2;

  return (
    <svg
      // Keyed on the value so a new link replays the grow-in.
      key={value}
      className={['invite-qr-code', className].filter(Boolean).join(' ')}
      viewBox={`0 0 ${extent} ${extent}`}
      role="img"
      aria-label={label}
      shapeRendering="geometricPrecision"
    >
      <defs>
        {/* Top-left to bottom-right in the symbol's own units, so every
            module and eye takes the colour of where it sits. */}
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1={QUIET_ZONE}
          y1={QUIET_ZONE}
          x2={extent - QUIET_ZONE}
          y2={extent - QUIET_ZONE}
        >
          <stop offset="0" className="invite-qr-ink-start" />
          <stop offset="1" className="invite-qr-ink-end" />
        </linearGradient>
      </defs>

      {/* The quiet zone is part of the code, so it is painted, not assumed. */}
      <rect width={extent} height={extent} className="invite-qr-ground" />

      {layout.modules.map(({ row, col, corners, distance }) => (
        <path
          key={`${row}-${col}`}
          d={modulePath(col + QUIET_ZONE, row + QUIET_ZONE, corners)}
          fill={ink}
          className="invite-qr-module"
          style={{ animationDelay: `${Math.round(distance * GROW_STAGGER_MS)}ms` }}
        />
      ))}

      {layout.finders.map(({ row, col }) => (
        <g key={`finder-${row}-${col}`} className="invite-qr-eye">
          {/* A 1-module ring around a 3x3 core, exactly the spec's 7x7. */}
          <rect
            x={col + QUIET_ZONE + 0.5}
            y={row + QUIET_ZONE + 0.5}
            width={6}
            height={6}
            rx={1.9}
            strokeWidth={1}
            fill="none"
            stroke={ink}
            className="invite-qr-eye-ring"
          />
          <rect
            x={col + QUIET_ZONE + 2}
            y={row + QUIET_ZONE + 2}
            width={3}
            height={3}
            rx={0.9}
            fill={ink}
            className="invite-qr-eye-core"
          />
        </g>
      ))}

      <BadgeFace x={badgeOrigin} y={badgeOrigin} size={badgeSize} />
    </svg>
  );
}
