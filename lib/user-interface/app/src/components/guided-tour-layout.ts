/**
 * Where the guided tour's card and highlight go. Pure arithmetic over
 * viewport coordinates, so the cases that are hard to reproduce in a browser
 * (a 320px phone, right-to-left, a target taller than the screen) are unit
 * tested in guided-tour-layout.test.ts.
 */

export interface Box {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface CardPlacement {
  top: number;
  left: number;
  width: number;
  /** The part of the target to cut out of the dim, or null when none of it is on screen. */
  highlight: Box | null;
}

export const CARD_MAX_WIDTH = 340;
export const EDGE_MARGIN = 8;
export const CARD_GAP = 12;
export const HIGHLIGHT_PADDING = 6;
// A sliver of highlight beside a docked card says nothing, so it is dropped.
const MIN_HIGHLIGHT_SIZE = 24;

export const boxOf = (rect: Pick<DOMRect, 'top' | 'left' | 'right' | 'bottom'>): Box => ({
  top: rect.top,
  left: rect.left,
  right: rect.right,
  bottom: rect.bottom,
});

/** The smallest box holding every given box: a target made of several elements. */
export function unionBox(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  return boxes.reduce((all, box) => ({
    top: Math.min(all.top, box.top),
    left: Math.min(all.left, box.left),
    right: Math.max(all.right, box.right),
    bottom: Math.max(all.bottom, box.bottom),
  }));
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

/**
 * Place the card beside the target, never over it.
 *
 * Below the target when it fits, else above, else docked to the bottom edge
 * with the highlight trimmed to the part the card leaves visible (a target
 * taller than the screen, or a 320px-wide phone with large text). Horizontally
 * the card lines up with the target's START edge, so in right-to-left it
 * hangs from the right and reads the same way the page does.
 */
export function placeCard({
  target,
  cardHeight,
  viewport,
  rtl,
}: {
  target: Box | null;
  cardHeight: number;
  viewport: Viewport;
  rtl: boolean;
}): CardPlacement {
  const width = Math.min(CARD_MAX_WIDTH, viewport.width - 2 * EDGE_MARGIN);
  const height = Math.min(cardHeight, viewport.height - 2 * EDGE_MARGIN);
  const centeredLeft = (viewport.width - width) / 2;
  const dockedBottom = Math.max(EDGE_MARGIN, viewport.height - EDGE_MARGIN - height);

  if (!target) {
    return { top: dockedBottom, left: centeredLeft, width, highlight: null };
  }

  const padded: Box = {
    top: target.top - HIGHLIGHT_PADDING,
    left: target.left - HIGHLIGHT_PADDING,
    right: target.right + HIGHLIGHT_PADDING,
    bottom: target.bottom + HIGHLIGHT_PADDING,
  };
  const left = clamp(
    rtl ? padded.right - width : padded.left,
    EDGE_MARGIN,
    viewport.width - EDGE_MARGIN - width,
  );

  const visible: Box = {
    top: Math.max(padded.top, 0),
    left: Math.max(padded.left, 0),
    right: Math.min(padded.right, viewport.width),
    bottom: Math.min(padded.bottom, viewport.height),
  };
  if (visible.bottom <= visible.top || visible.right <= visible.left) {
    return { top: dockedBottom, left, width, highlight: null };
  }

  const needed = height + CARD_GAP;
  const spaceBelow = viewport.height - visible.bottom - EDGE_MARGIN;
  const spaceAbove = visible.top - EDGE_MARGIN;

  if (spaceBelow >= needed) {
    return { top: visible.bottom + CARD_GAP, left, width, highlight: visible };
  }
  if (spaceAbove >= needed) {
    return { top: visible.top - CARD_GAP - height, left, width, highlight: visible };
  }

  // No room beside it (the target fills the screen, or the phone is small):
  // dock at the bottom, where the start of the target stays highlighted, and
  // trim the highlight to what the card leaves visible.
  const trimmed: Box = { ...visible, bottom: Math.min(visible.bottom, dockedBottom - CARD_GAP) };
  const isUsable =
    trimmed.bottom - trimmed.top >= MIN_HIGHLIGHT_SIZE &&
    trimmed.right - trimmed.left >= MIN_HIGHLIGHT_SIZE;
  return { top: dockedBottom, left, width, highlight: isUsable ? trimmed : null };
}
