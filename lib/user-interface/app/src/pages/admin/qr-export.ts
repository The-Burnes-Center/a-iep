/**
 * Turn an on-screen InviteQrCode into files an admin can print.
 *
 * The drawn code takes its colours from stylesheet classes (palette tokens),
 * which a standalone file does not carry. So the export copies each element's
 * resolved fill, stroke and stop colour onto the copy as inline style, and
 * leaves the classes behind as inert names. Nothing animates in the file.
 */

/** Long edge of the PNG. Print at 3in and 300dpi without upscaling. */
export const PNG_SIZE_PX = 1200;

const PAINT_PROPERTIES = ['fill', 'stroke', 'stop-color'] as const;

const inlinePaint = (source: Element, target: Element) => {
  const computed = window.getComputedStyle(source);
  const declarations = PAINT_PROPERTIES.map((property) => [
    property,
    computed.getPropertyValue(property),
  ])
    .filter(([, value]) => value && value !== 'none')
    .map(([property, value]) => `${property}:${value}`);
  // Replace rather than merge: the on-screen inline style is the grow-in
  // animation delay, which means nothing in a file.
  if (declarations.length > 0) target.setAttribute('style', declarations.join(';'));
  else target.removeAttribute('style');
};

/** A self-contained SVG document of the code, at `size` px square. */
export const serializeQrSvg = (svg: SVGSVGElement, size = PNG_SIZE_PX) => {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const sources = [svg, ...svg.querySelectorAll('*')];
  const targets = [copy, ...copy.querySelectorAll('*')];
  sources.forEach((source, i) => inlinePaint(source, targets[i]));

  copy.setAttribute('width', String(size));
  copy.setAttribute('height', String(size));
  copy.removeAttribute('class');
  // The serializer writes the SVG namespace itself; setting xmlns as well
  // duplicates the attribute and the file no longer parses.
  return new XMLSerializer().serializeToString(copy);
};

export const qrSvgBlob = (svg: SVGSVGElement) =>
  new Blob([serializeQrSvg(svg)], { type: 'image/svg+xml' });

/** Rasterise the code through the browser's own SVG renderer. */
export const qrPngBlob = (svg: SVGSVGElement): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(qrSvgBlob(svg));
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = PNG_SIZE_PX;
      canvas.height = PNG_SIZE_PX;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('Canvas 2D context unavailable'));
        return;
      }
      context.drawImage(image, 0, 0, PNG_SIZE_PX, PNG_SIZE_PX);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))),
        'image/png',
      );
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('QR SVG failed to load as an image'));
    };
    image.src = url;
  });
