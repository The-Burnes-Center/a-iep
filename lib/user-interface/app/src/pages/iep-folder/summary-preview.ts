/**
 * The summary as the collapsed card shows it, before "Read more".
 *
 * It used to be the first paragraph, whatever that was. When a summary opens
 * with a title line ("**IEP program summary for Maya**"), which the
 * translation step sometimes adds, the preview was that title alone and
 * nothing a parent could read (staging nightly, 2026-11-13: 54 characters of
 * Vietnamese). Paragraphs are now added until the preview holds enough real
 * text, so it always reaches the first sentences of the summary itself.
 */

/** Enough text to be a preview: two or three short sentences. */
export const PREVIEW_MIN_CHARS = 160;

/** What a paragraph reads as, without markdown's emphasis and heading marks. */
const readableLength = (paragraph: string): number =>
  paragraph.replace(/[*_#>`]/g, '').replace(/\s+/g, ' ').trim().length;

export interface SummaryPreview {
  /** What to show collapsed. The whole summary when it is already short. */
  preview: string;
  /** True when there is more to show behind "Read more". */
  truncated: boolean;
}

export const summaryPreview = (content: string): SummaryPreview => {
  const paragraphs = content.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length <= 1) return { preview: content, truncated: false };

  const shown: string[] = [];
  let length = 0;
  for (const paragraph of paragraphs) {
    shown.push(paragraph);
    length += readableLength(paragraph);
    if (length >= PREVIEW_MIN_CHARS) break;
  }
  if (shown.length === paragraphs.length) return { preview: content, truncated: false };
  // ".." after the last shown paragraph, as before, to say it continues.
  return { preview: `${shown.join('\n\n')}..`, truncated: true };
};
