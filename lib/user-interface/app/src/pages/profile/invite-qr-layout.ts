/**
 * Turns a URL into the shapes InviteQrCode draws.
 *
 * The idea is borrowed from tree.icqr.com, which draws a QR code as a garden
 * seen from above: every dark module is a block of foliage, the finder
 * patterns are hedges, and from straight overhead the whole thing still
 * scans. We keep the flat, top-down half of that trick: modules rounded only
 * on the corners no dark neighbour touches, so runs read as soft shapes, soft
 * rounded finder eyes, and the app's amber face in the middle.
 *
 * Everything decorative is constrained by what a phone camera needs:
 *  - Modules fill their whole cell. Inset "tiles" with white gaps between
 *    them stopped jsQR decoding the browser's rendering from 300px up.
 *  - Colour is one smooth diagonal gradient between two dark brand tokens,
 *    not a per-module mix. ICQR shades each block differently, but a mix of
 *    lighter and darker modules stopped jsQR decoding renders above ~900px,
 *    while a gradient decoded at every size tried (150px to 2000px).
 *  - The finder eyes stay solid and dark. Only their corners are rounded.
 *  - The face covers the centre, which the code survives because it is built
 *    at error-correction level Q (up to ~25% of codewords recoverable) and the
 *    covered area is kept to a few percent of the symbol. The decode test in
 *    InviteQrCode.test.tsx is what actually holds this to account.
 */
import qrcode from 'qrcode-generator';

/** The QR spec's minimum quiet zone, in modules. */
export const QUIET_ZONE = 4;

const FINDER_SIZE = 7;

/** Fraction of the symbol width the centre badge may clear. */
const BADGE_FRACTION = 0.3;

/** Which corners of a module face only light cells, and so may be rounded. */
export interface ExposedCorners {
  topLeft: boolean;
  topRight: boolean;
  bottomRight: boolean;
  bottomLeft: boolean;
}

export interface QrModule {
  row: number;
  col: number;
  corners: ExposedCorners;
  /** 0 at the centre of the symbol, 1 at the farthest corner. */
  distance: number;
}

export interface QrLayout {
  /** Modules per side, without the quiet zone. */
  size: number;
  modules: QrModule[];
  /** Top-left cell of each 7x7 finder pattern. */
  finders: Array<{ row: number; col: number }>;
  /** The cleared square in the middle, in cells. */
  badge: { start: number; span: number };
}

const isInFinder = (row: number, col: number, size: number) => {
  const nearTop = row < FINDER_SIZE;
  const nearLeft = col < FINDER_SIZE;
  const nearRight = col >= size - FINDER_SIZE;
  const nearBottom = row >= size - FINDER_SIZE;
  return (nearTop && nearLeft) || (nearTop && nearRight) || (nearBottom && nearLeft);
};

/** Odd, so it centres exactly on an odd-sized symbol. */
const badgeSpanFor = (size: number) => {
  const span = Math.floor(size * BADGE_FRACTION);
  return span % 2 === 0 ? span - 1 : span;
};

export function buildQrLayout(value: string): QrLayout {
  const code = qrcode(0, 'Q');
  code.addData(value, 'Byte');
  code.make();

  const size = code.getModuleCount();
  const span = badgeSpanFor(size);
  const start = (size - span) / 2;
  const centre = (size - 1) / 2;
  const maxDistance = Math.hypot(centre, centre);
  const inBadge = (index: number) => index >= start && index < start + span;

  // Modules covered by the badge or a finder are drawn by those shapes, so
  // they do not count as neighbours that would square off a corner.
  const isDrawn = (row: number, col: number) =>
    row >= 0 &&
    col >= 0 &&
    row < size &&
    col < size &&
    code.isDark(row, col) &&
    !isInFinder(row, col, size) &&
    !(inBadge(row) && inBadge(col));

  const modules: QrModule[] = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!isDrawn(row, col)) continue;
      const up = isDrawn(row - 1, col);
      const down = isDrawn(row + 1, col);
      const left = isDrawn(row, col - 1);
      const right = isDrawn(row, col + 1);
      modules.push({
        row,
        col,
        corners: {
          topLeft: !up && !left,
          topRight: !up && !right,
          bottomRight: !down && !right,
          bottomLeft: !down && !left,
        },
        distance: Math.hypot(row - centre, col - centre) / maxDistance,
      });
    }
  }

  return {
    size,
    modules,
    finders: [
      { row: 0, col: 0 },
      { row: 0, col: size - FINDER_SIZE },
      { row: size - FINDER_SIZE, col: 0 },
    ],
    badge: { start, span },
  };
}
