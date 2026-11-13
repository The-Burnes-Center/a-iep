import { describe, expect, test } from 'vitest';
import { PREVIEW_MIN_CHARS, summaryPreview } from './summary-preview';

const sentence = (n: number) => `This is sentence ${n} of the summary, written in plain words for a parent.`;

describe('the collapsed summary', () => {
  test('a title line is never the whole preview: the first real paragraph comes with it', () => {
    // The nightly's Vietnamese summary, in shape: a bold title, then the text.
    const content = `**IEP program summary for Maya**\n\n${sentence(1)} ${sentence(2)} ${sentence(3)}\n\n${sentence(4)}`;
    const { preview, truncated } = summaryPreview(content);
    expect(truncated).toBe(true);
    expect(preview).toContain(sentence(1));
    expect(preview).not.toContain(sentence(4));
    expect(preview.endsWith('..')).toBe(true);
  });

  test('a long first paragraph is the preview on its own, as before', () => {
    const first = [1, 2, 3].map(sentence).join(' ');
    expect(first.length).toBeGreaterThan(PREVIEW_MIN_CHARS);
    const { preview } = summaryPreview(`${first}\n\n${sentence(4)}`);
    expect(preview).toBe(`${first}..`);
  });

  test('a summary short enough to show whole has no Read more', () => {
    const content = `**Title**\n\n${sentence(1)}`;
    expect(summaryPreview(content)).toEqual({ preview: content, truncated: false });
    expect(summaryPreview(sentence(1))).toEqual({ preview: sentence(1), truncated: false });
  });

  test('markdown marks do not count toward the length', () => {
    const stars = `**${'*'.repeat(200)}**`;
    const { preview } = summaryPreview(`${stars}\n\n${sentence(1)} ${sentence(2)} ${sentence(3)}\n\n${sentence(4)}`);
    expect(preview).toContain(sentence(1));
  });
});
