import { describe, expect, test } from 'vitest';
import { render } from '@testing-library/react';
import Face from './Face';
import { FACE_MOOD, mouthPath } from './face-shape';

/** The mouth's control point: lower in the picture is a bigger smile. */
const curveOf = (container: HTMLElement) => {
  const d = container.querySelector('[data-mouth]')?.getAttribute('d') ?? '';
  return Number(/Q24 ([\d.]+)/.exec(d)?.[1]);
};

describe('the app face', () => {
  test('runs from a frown to a smile across the four answers, in order', () => {
    const curves = (['disagree', 'somewhat_disagree', 'somewhat_agree', 'agree'] as const)
      .map((expression) => curveOf(render(<Face expression={expression} />).container));
    expect(curves).toEqual([...curves].sort((a, b) => a - b));
    expect(curves[0]).toBeLessThan(31.5);
    expect(curves[3]).toBeGreaterThan(31.5);
  });

  test('is decoration beside words, never the only way the answer is said', () => {
    const { container } = render(<Face expression="agree" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('title')).toBeNull();
  });

  test('"Not sure" is a question mark, and an unanswered face has no colour', () => {
    const unsure = render(<Face expression="unsure" />).container;
    expect(unsure.querySelector('text')).toHaveTextContent('?');
    expect(unsure.querySelector('[data-mouth]')).toBeNull();
    const empty = render(<Face expression="empty" />).container;
    expect(empty.querySelector('rect')?.getAttribute('style')).toContain('--aiep-surface-field');
  });

  test('takes its colours from the palette, never a literal', () => {
    const { container } = render(<Face expression="agree" />);
    const styles = [...container.querySelectorAll('[style]')].map((el) => el.getAttribute('style') ?? '');
    expect(styles.length).toBeGreaterThan(0);
    for (const style of styles) expect(style).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(container.querySelector('rect')?.getAttribute('style')).toContain('--aiep-face');
  });

  test('every face is the same size with its features in the same place, so a row lines up', () => {
    const sizes = Object.keys(FACE_MOOD).map((expression) => {
      const svg = render(<Face expression={expression as keyof typeof FACE_MOOD} />).container.querySelector('svg')!;
      return `${svg.getAttribute('viewBox')} ${svg.getAttribute('width')}`;
    });
    expect(new Set(sizes).size).toBe(1);
  });

  test('a moving face (a slider) takes any mood, kept between a frown and a smile', () => {
    expect(mouthPath(5)).toBe(mouthPath(1));
    expect(mouthPath(-5)).toBe(mouthPath(-1));
  });
});
