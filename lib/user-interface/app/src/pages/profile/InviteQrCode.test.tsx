/**
 * The decorated QR code must still scan.
 *
 * Rounded modules, coloured shades, rounded finder eyes and a face over the
 * middle are each a small bet against a phone camera. Rather than trust the
 * bets, these tests rasterise what the component actually drew and run it
 * through jsQR, an independent decoder, then assert the decoded text is the
 * exact URL. If the badge grows too big, an eye loses its shape, or the
 * matrix drifts from the value, the decode fails or returns something else.
 */
import React from 'react';
import { describe, expect, test } from 'vitest';
import { render } from '@testing-library/react';
import InviteQrCode from './InviteQrCode';
import { QUIET_ZONE } from './invite-qr-layout';
import { darkShapes, decodeQrSvg } from './invite-qr-decode.testutil';

const decodeRendered = (value: string) => {
  const { container, unmount } = render(<InviteQrCode value={value} label="qr" />);
  const decoded = decodeQrSvg(container.querySelector('svg') as SVGSVGElement);
  unmount();
  return decoded;
};

describe('InviteQrCode', () => {
  test.each([
    ['a short staging link', 'https://staging.example.test/r/ABC123'],
    ['a production-length link', 'https://www.a-iep-example.org/r/Q7XK2M9P'],
    ['a long link that needs a bigger symbol', `https://example.test/r/${'Z'.repeat(60)}`],
  ])('decodes back to exactly the url for %s', (_name, url) => {
    expect(decodeRendered(url)).toBe(url);
  });

  test('a different url decodes differently, so the check can fail', () => {
    const url = 'https://staging.example.test/r/ABC123';
    expect(decodeRendered(`${url}X`)).toBe(`${url}X`);
    expect(decodeRendered(`${url}X`)).not.toBe(url);
  });

  test('keeps the quiet zone clear', () => {
    const { container } = render(
      <InviteQrCode value="https://staging.example.test/r/ABC123" label="qr" />,
    );
    const svg = container.querySelector('svg') as SVGSVGElement;
    const extent = Number(svg.getAttribute('viewBox')!.split(' ')[2]);
    const isDarkAt = darkShapes(svg);

    for (let i = 0; i < extent; i++) {
      for (let band = 0; band < QUIET_ZONE; band++) {
        const edge = extent - band - 0.5;
        expect(isDarkAt(i + 0.5, band + 0.5)).toBe(false);
        expect(isDarkAt(i + 0.5, edge)).toBe(false);
        expect(isDarkAt(band + 0.5, i + 0.5)).toBe(false);
        expect(isDarkAt(edge, i + 0.5)).toBe(false);
      }
    }
  });

  test('draws locally, with an accessible name and nothing fetched', () => {
    const { container, getByRole } = render(
      <InviteQrCode value="https://staging.example.test/r/ABC123" label="Invite QR" />,
    );

    expect(getByRole('img')).toHaveAccessibleName('Invite QR');
    expect(container.querySelectorAll('image, img, use, canvas')).toHaveLength(0);
    // The only url() is the code's own gradient, a fragment in the same SVG.
    expect(container.innerHTML).not.toMatch(/url\((?!#)|href=/);
  });
});
