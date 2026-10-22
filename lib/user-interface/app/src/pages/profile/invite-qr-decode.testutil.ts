/**
 * Test-only: rasterise an InviteQrCode SVG from its drawn geometry and decode
 * it with jsQR, a decoder independent of the encoder, so a test can assert
 * what a camera would read rather than what the component was asked to draw.
 */
import jsQR from 'jsqr';

/** Pixels per module in the raster handed to the decoder. */
const SCALE = 5;

const num = (el: Element, name: string) => Number(el.getAttribute(name));

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const boxOf = (el: Element, pad = 0): Box => ({
  left: num(el, 'x') - pad,
  top: num(el, 'y') - pad,
  right: num(el, 'x') + num(el, 'width') + pad,
  bottom: num(el, 'y') + num(el, 'height') + pad,
});

const contains = (box: Box, x: number, y: number) =>
  x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;

/**
 * Bounding box of a module path. InviteQrCode writes only absolute M, H, V, A
 * and Z commands, so the extremes of the end points are the box.
 */
const pathBox = (d: string): Box => {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [, command, args] of d.matchAll(/([MHVAZ])([^MHVAZ]*)/g)) {
    const n = args.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (command === 'M') { xs.push(n[0]); ys.push(n[1]); }
    if (command === 'H') xs.push(n[0]);
    if (command === 'V') ys.push(n[0]);
    if (command === 'A') { xs.push(n[5]); ys.push(n[6]); }
  }
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
};

/**
 * The dark shapes, read off the drawn SVG, minus anything the badge covers. Rounded corners are treated as
 * square, which is the generous direction only at the corners of a module;
 * widths and gaps are exact, which is what a thinned eye ring would break.
 */
export const darkShapes = (svg: SVGSVGElement) => {
  const solids = [
    ...[...svg.querySelectorAll('.invite-qr-module')].map((el) => pathBox(el.getAttribute('d')!)),
    ...[...svg.querySelectorAll('.invite-qr-eye-core')].map((el) => boxOf(el)),
  ];
  const rings = [...svg.querySelectorAll('.invite-qr-eye-ring')].map((el) => {
    const half = num(el, 'stroke-width') / 2;
    return { outer: boxOf(el, half), inner: boxOf(el, -half) };
  });
  // The face is painted over the code, so wherever it actually landed hides
  // whatever is underneath. Treated as all light, which is how a camera's
  // binarisation sees the amber.
  const badges = [...svg.querySelectorAll('svg.invite-qr-badge')].map((el) => boxOf(el));
  return (x: number, y: number) =>
    !badges.some((box) => contains(box, x, y)) &&
    (solids.some((box) => contains(box, x, y)) ||
      rings.some(({ outer, inner }) => contains(outer, x, y) && !contains(inner, x, y)));
};

/** Paint the SVG at SCALE pixels per module into an RGBA buffer for jsQR. */
const rasterise = (svg: SVGSVGElement) => {
  const extent = Number(svg.getAttribute('viewBox')!.split(' ')[2]);
  const isDarkAt = darkShapes(svg);
  const side = extent * SCALE;
  const pixels = new Uint8ClampedArray(side * side * 4);

  for (let py = 0; py < side; py++) {
    for (let px = 0; px < side; px++) {
      const shade = isDarkAt((px + 0.5) / SCALE, (py + 0.5) / SCALE) ? 0 : 255;
      pixels.set([shade, shade, shade, 255], (py * side + px) * 4);
    }
  }
  return { pixels, side };
};

/** The text a scanner reads from the drawn code, or null if it does not scan. */
export const decodeQrSvg = (svg: SVGSVGElement) => {
  const { pixels, side } = rasterise(svg);
  return jsQR(pixels, side, side)?.data ?? null;
};
