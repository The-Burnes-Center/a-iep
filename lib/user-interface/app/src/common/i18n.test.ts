/**
 * Guardrails for the hand-rolled i18n layer: the five translation dictionaries
 * and the language metadata that decides which of them the app can load.
 *
 * `t()` in common/language-context.ts is `translations[key] || key`: a flat
 * lookup with no fallback to English and no logging. So every way a dictionary
 * can be wrong fails silently, in front of a parent, in a language nobody on
 * the team reads:
 *
 *  - a key missing from es/zh/vi/ar renders the raw dot-separated key
 *    ("landingHero.title.project") in the middle of the page;
 *  - an EMPTY value renders the key too, because "" is falsy;
 *  - a key repeated inside one file collapses to whichever copy JSON.parse
 *    sees last, so editing the other copy changes nothing and the dead half
 *    keeps drifting;
 *  - a language added to SupportedLanguage without its dictionary file lands
 *    in loadTranslations' catch and quietly shows English, which reads like a
 *    translation bug rather than a missing file.
 *
 * Five dictionaries of several hundred keys are kept in step by hand, so "we
 * will notice" is not a plan. Each assertion names the file and the key: the
 * person who hits this in CI months from now should not have to re-derive
 * which of ~3000 strings moved.
 *
 * The dictionaries are read off disk rather than imported. The duplicate-key
 * check needs the raw text, because JSON.parse has already thrown the evidence
 * away by the time you can inspect the object, and reading the directory means
 * a sixth language is covered the moment its file lands.
 */
// `node:` prefixes on purpose: this runs under the jsdom environment, where a
// bare "url" or "fs" resolves to the browser polyfill in node_modules and
// fileURLToPath simply is not there. The URL is passed as a string for the
// same reason — jsdom's global URL is not the one node:url accepts — and
// fileURLToPath is used rather than .pathname because the checkout path can
// contain spaces, which stay percent-encoded.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ALL_LANGUAGES, LANGUAGES, SupportedLanguage } from "./languages";

const TRANSLATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../translations");

/** English is the source dictionary: every other file is compared against it. */
const REFERENCE_LANGUAGE: SupportedLanguage = "en";

/**
 * Not a key count — the other agents add keys constantly and pinning a number
 * would just be a chore. This only stops a truncated or emptied en.json from
 * making every parity check below pass vacuously.
 */
const MIN_REFERENCE_KEYS = 100;

/** Long lists are truncated so a mass drift reports names, not 600 lines. */
const NAMES_SHOWN = 20;

const dictionaryFile = (lang: string): string => path.join(TRANSLATIONS_DIR, `${lang}.json`);

const readRaw = (lang: string): string => fs.readFileSync(dictionaryFile(lang), "utf8");

const readDictionary = (lang: string): Record<string, unknown> =>
  JSON.parse(readRaw(lang)) as Record<string, unknown>;

const listNames = (keys: string[]): string =>
  keys.length <= NAMES_SHOWN
    ? keys.join(", ")
    : `${keys.slice(0, NAMES_SHOWN).join(", ")} ... and ${keys.length - NAMES_SHOWN} more`;

/**
 * Top-level keys with their 1-based line numbers, straight from the file text.
 * These dictionaries are flat (asserted below), so every line that starts with
 * a quoted string followed by a colon is one entry.
 */
const keyLines = (raw: string): { key: string; line: number }[] =>
  raw.split("\n").flatMap((text, index) => {
    const match = /^\s*"((?:[^"\\]|\\.)*)"\s*:/.exec(text);
    return match ? [{ key: match[1], line: index + 1 }] : [];
  });

const dictionaryFiles = fs
  .readdirSync(TRANSLATIONS_DIR)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.replace(/\.json$/, ""));

const translatedLanguages = ALL_LANGUAGES.filter((lang) => lang !== REFERENCE_LANGUAGE);

describe("translation dictionaries", () => {
  const reference = readDictionary(REFERENCE_LANGUAGE);
  const referenceKeys = Object.keys(reference);

  test("en.json is a real dictionary, not an empty or truncated one", () => {
    expect(referenceKeys.length).toBeGreaterThan(MIN_REFERENCE_KEYS);
  });

  test.each(translatedLanguages)("%s.json has exactly the keys en.json has", (lang) => {
    const keys = new Set(Object.keys(readDictionary(lang)));
    const missing = referenceKeys.filter((key) => !keys.has(key));
    const extra = [...keys].filter((key) => !(key in reference));

    // Reported as messages rather than as two bare array diffs so the failure
    // says which file, which direction, and which keys.
    const problems: string[] = [];
    if (missing.length > 0) {
      problems.push(
        `${lang}.json is missing ${missing.length} key(s) that en.json has: ${listNames(missing)}`,
      );
    }
    if (extra.length > 0) {
      problems.push(
        `${lang}.json has ${extra.length} key(s) en.json does not: ${listNames(extra)}`,
      );
    }
    expect(problems).toEqual([]);
  });

  test.each(ALL_LANGUAGES)("%s.json is flat, with a string for every key", (lang) => {
    // A nested object would render as "[object Object]" through t(), and it
    // would also break the line-based duplicate scan below.
    const dictionary = readDictionary(lang);
    const wrongType = Object.keys(dictionary).filter((key) => typeof dictionary[key] !== "string");
    expect(wrongType.map((key) => `${lang}.json: "${key}" is not a string`)).toEqual([]);
  });

  test.each(ALL_LANGUAGES)("%s.json has no empty translations", (lang) => {
    // `translations[key] || key` treats "" as missing, so an empty value shows
    // the parent the raw key. A string of spaces is the same defect with a
    // blank space where the text should be.
    const dictionary = readDictionary(lang);
    const blank = Object.keys(dictionary).filter(
      (key) => typeof dictionary[key] === "string" && (dictionary[key] as string).trim() === "",
    );
    expect(
      blank.map((key) => `${lang}.json: "${key}" is empty, so t() will render the key itself`),
    ).toEqual([]);
  });

  test.each(ALL_LANGUAGES)("%s.json declares every key exactly once", (lang) => {
    const seen = new Map<string, number[]>();
    for (const { key, line } of keyLines(readRaw(lang))) {
      seen.set(key, [...(seen.get(key) ?? []), line]);
    }
    const duplicates = [...seen.entries()]
      .filter(([, lines]) => lines.length > 1)
      .map(
        ([key, lines]) =>
          `${lang}.json: "${key}" is declared ${lines.length} times (lines ${lines.join(", ")}); ` +
          `JSON.parse keeps the last one and drops the rest`,
      );
    expect(duplicates).toEqual([]);
  });
});

describe("language metadata", () => {
  /**
   * Adding a code to SupportedLanguage without adding it here fails the app's
   * `tsc --noEmit` gate before this suite even runs. That is the point of
   * spelling the record out instead of deriving it from LANGUAGES.
   */
  const EXPECTED_ENGLISH_LABELS: Record<SupportedLanguage, string> = {
    en: "English",
    es: "Spanish",
    zh: "Chinese",
    vi: "Vietnamese",
    ar: "Arabic",
  };

  test("carries metadata for every supported language, and only those", () => {
    expect([...ALL_LANGUAGES].sort()).toEqual(Object.keys(EXPECTED_ENGLISH_LABELS).sort());
    expect(new Set(ALL_LANGUAGES).size).toBe(ALL_LANGUAGES.length);
  });

  test.each(LANGUAGES)("$value is fully labelled", (meta) => {
    // A blank field leaves an unpickable empty row in the language picker, and
    // the endonym is the only thing a parent who does not read English can
    // recognise their own language by. Named individually so the failure says
    // which field, not just that some string was empty.
    const blank = (["label", "englishLabel", "translatedPreference"] as const).filter(
      (field) => meta[field].trim() === "",
    );
    expect(blank.map((field) => `${meta.value}: ${field} is blank`)).toEqual([]);
    expect(meta.englishLabel).toBe(EXPECTED_ENGLISH_LABELS[meta.value]);
  });

  test("ships a dictionary file for every supported language, and no orphans", () => {
    // Missing file: language-context falls back to English and the picker
    // offers a language that does nothing. Orphan file: a language that was
    // half-added or half-removed, dead weight in the repo and invisible to
    // resolveEnabledLanguages, which drops codes it does not recognise.
    expect([...dictionaryFiles].sort()).toEqual([...ALL_LANGUAGES].sort());
  });
});
