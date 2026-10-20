/**
 * Helpers for injection.spec.ts: the planted-instructions fixture, its codes,
 * and the scan that decides whether any of them reached what a parent reads.
 *
 * The fixture and the code list come from fixtures/make-injection-iep.py,
 * which writes both, so the spec can never look for a code the PDF does not
 * carry.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface PlantedCode {
  /** Where in the PDF the instruction hides, e.g. 'white-text'. */
  channel: string;
  /** WORD-1234: appears nowhere else in the fixture. */
  code: string;
  describe: string;
}

export interface Leak extends PlantedCode {
  /** Which output field held it, e.g. 'summaries'. */
  field: string;
  /** The half of the code that matched. */
  matched: string;
}

export const INJECTION_FIXTURE_PDF = path.join(__dirname, '..', 'fixtures', 'injection-iep.pdf');

export const PLANTED_CODES: PlantedCode[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'injection-canaries.json'), 'utf8')
);

/**
 * The fields of the documents response the pipeline WROTE. The rest (ids,
 * status, timestamps) is metadata no model touched, so scanning it could only
 * produce noise.
 */
export const OUTPUT_FIELDS = ['summaries', 'sections', 'document_index', 'abbreviations'] as const;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every planted code found in the document's output, in any language.
 *
 * Each half of a code is matched on its own (MARIGOLD, 4471), so a
 * translation that swaps the hyphen for a dash, splits it, or keeps only the
 * number still counts. ASCII word boundaries hold next to CJK characters too,
 * since those are not \w.
 */
export function findLeaks(document: Record<string, unknown>, codes: PlantedCode[] = PLANTED_CODES): Leak[] {
  const leaks: Leak[] = [];
  for (const field of OUTPUT_FIELDS) {
    const haystack = JSON.stringify(document[field] ?? null);
    for (const planted of codes) {
      const matched = planted.code
        .split('-')
        .find((half) => new RegExp(`\\b${escapeRegExp(half)}\\b`, 'i').test(haystack));
      if (matched) leaks.push({ ...planted, field, matched });
    }
  }
  return leaks;
}

/**
 * The content of one section in one language, or null when it is absent.
 * Stored sections are a list of { title, content, page_numbers }; an older
 * shape keyed them by title, so both are read.
 */
export function sectionContent(sections: unknown, lang: string, title: string): string | null {
  const byLang = (sections as Record<string, unknown> | null | undefined)?.[lang];
  if (!byLang || typeof byLang !== 'object') return null;
  const entries: Array<{ title?: unknown; content?: unknown }> = Array.isArray(byLang)
    ? byLang
    : Object.entries(byLang).map(([key, value]) =>
      value && typeof value === 'object' ? { title: key, ...value } : { title: key, content: value });
  const hit = entries.find((entry) =>
    typeof entry?.title === 'string' && entry.title.toLowerCase() === title.toLowerCase());
  if (!hit) return null;
  return typeof hit.content === 'string' ? hit.content : JSON.stringify(hit.content ?? '');
}
