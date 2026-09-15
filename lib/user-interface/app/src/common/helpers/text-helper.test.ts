/**
 * TextHelper.formatUnixTimestamp: the "Last updated <date>" line under a
 * parent's summary, in all five languages.
 *
 * The guard against a non-number is the reason this file exists. The
 * signature says `number | undefined`, but the value is a DynamoDB field off
 * an API response, and the document row holds its last-update time in two
 * attributes of which only one is in seconds — the other is an ISO string.
 * `'2026-09-15T20:30:00' * 1000` is NaN, `new Date(NaN)` is an Invalid Date,
 * and toLocaleDateString prints it as the literal words "Invalid Date" to a
 * parent. The callers' own `value && ...` guards do not catch it, because a
 * non-empty string is truthy.
 *
 * user-profile-handler's `_document_updated_at` is what normalizes the two
 * attributes to seconds, and test/python/test_user_profile_api.py pins that.
 * This is the second half of the same defence: if a future response ever
 * leaks the raw string again, the line goes missing rather than wrong.
 */
import { describe, expect, test } from "vitest";
import { TextHelper } from "./text-helper";

/** 2026-09-15T20:30:00Z, the same instant the python suite uses. */
const SEPT_15_2026 = 1789504200;

describe("formatUnixTimestamp", () => {
  test("formats seconds since the epoch in the parent's locale", () => {
    expect(TextHelper.formatUnixTimestamp(SEPT_15_2026, "en")).toBe("September 15, 2026");
  });

  test.each([
    ["es", "15 de septiembre de 2026"],
    ["zh", "2026年9月15日"],
  ])("renders %s in its own wording", (language, expected) => {
    expect(TextHelper.formatUnixTimestamp(SEPT_15_2026, language)).toBe(expected);
  });

  test("keeps Western digits in Arabic, to match the English IEP's page numbers", () => {
    // The nu-latn extension in the locale map is what does this, and it is
    // load-bearing: the summaries reference pages of the original document.
    const arabic = TextHelper.formatUnixTimestamp(SEPT_15_2026, "ar");

    expect(arabic).toContain("2026");
    expect(arabic).toContain("15");
    expect(arabic).not.toMatch(/[٠-٩]/);
  });

  test("falls back to English for a language it has no locale for", () => {
    expect(TextHelper.formatUnixTimestamp(SEPT_15_2026, "de")).toBe("September 15, 2026");
  });

  test.each([undefined, 0, null])("says nothing for %s", (absent) => {
    expect(TextHelper.formatUnixTimestamp(absent as unknown as number)).toBe("");
  });

  test.each([
    ["an ISO string, which is the other attribute on the row", "2026-09-15T20:30:00.123456"],
    ["an ISO string with a zone", "2026-09-15T20:30:00+00:00"],
    ["seconds that arrived as a string", "1789504200"],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["an object", {}],
  ])("says nothing rather than \"Invalid Date\" for %s", (_label, value) => {
    // Never the words a parent must not read, whatever comes through.
    expect(TextHelper.formatUnixTimestamp(value as unknown as number)).toBe("");
  });

  test("the fallback is empty in every language, not just English", () => {
    for (const language of ["en", "es", "vi", "zh", "ar"]) {
      expect(
        TextHelper.formatUnixTimestamp("2026-09-15T20:30:00" as unknown as number, language),
      ).toBe("");
    }
  });
});
