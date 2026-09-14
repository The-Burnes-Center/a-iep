/**
 * The name rule, from the side a parent sees it.
 *
 * The cases that matter most here are the ones that must be ACCEPTED: this
 * runs in front of every family, and the fastest way to lock a parent out of
 * the product is a Latin-only regex that calls their child's name invalid.
 * Four of the five languages we ship in are covered below, in both the
 * precomposed and the decomposed form, because a phone keyboard produces
 * either one and a parent cannot tell which they typed.
 *
 * Several cases below look identical to the one above them: a decomposed name
 * renders the same as a precomposed one, and the Unicode hyphen and curly
 * apostrophe render almost the same as the ASCII pair. That is why every case
 * carries a label saying which it is.
 *
 * The same rule runs server-side (user-profile-handler's
 * `validate_child_name`); test/python/test_child_name_validation.py walks the
 * same cases against it.
 */
import { describe, expect, test } from "vitest";
import {
  CHILD_NAME_MAX_LENGTH,
  normalizeChildName,
  validateChildName,
} from "./child-name";

describe("names that must be accepted", () => {
  test.each([
    ["José", "Spanish, precomposed"],
    ["José", "Spanish, decomposed: e + combining acute"],
    ["Nguyễn Minh Anh", "Vietnamese, precomposed"],
    ["Nguyễn Minh Anh", "Vietnamese, decomposed: two marks on one letter"],
    ["李伟", "Chinese"],
    ["أحمد", "Arabic"],
    ["أَحْمَد", "Arabic with harakat (combining marks)"],
    ["Mary-Jane O'Brien", "ASCII hyphen and apostrophe"],
    ["Mary‐Jane O’Brien", "the Unicode hyphen and curly apostrophe a keyboard produces"],
    ["J. R. Rivera", "initials"],
    ["A", "a single letter is a name"],
    ["李", "one Chinese character is a name"],
    ["van der Berg", "lower case particles"],
    ["Ana María de la Cruz", "four words"],
  ])("accepts %j (%s)", (name) => {
    expect(validateChildName(name)).toBeNull();
  });
});

describe("names that must be rejected", () => {
  test.each([
    ["", "required"],
    ["   ", "required"],
    ["\t\n ", "required"],
    ["123", "invalid"],
    ["Alex 3", "invalid"],
    ["!!!", "invalid"],
    [".", "invalid"],
    ["-", "invalid"],
    ["'", "invalid"],
    ["  .  ", "invalid"],
    ["Alex!", "invalid"],
    ["Alex_Rivera", "invalid"],
    ["Alex@home", "invalid"],
    ["<script>", "invalid"],
    ["Alex \u{1f600}", "invalid"],
    ["\u{1f600}", "invalid"],
    ["Alex\u0007", "invalid"],
    ["Alex\u200bRivera", "invalid"],
    ["\\1", "invalid"],
    ["\\g<0>", "invalid"],
    ["Alex\\Rivera", "invalid"],
  ] as const)("rejects %j as %s", (name, reason) => {
    expect(validateChildName(name)).toBe(reason);
  });

  test("punctuation on its own is not a name", () => {
    expect(validateChildName("...")).toBe("invalid");
    expect(validateChildName("- -")).toBe("invalid");
  });
});

describe("normalising", () => {
  test("trims and collapses internal runs of whitespace", () => {
    expect(normalizeChildName("  Mary   Jane  ")).toBe("Mary Jane");
    expect(normalizeChildName("Mary\tJane")).toBe("Mary Jane");
    expect(normalizeChildName("Mary\n\nJane")).toBe("Mary Jane");
    expect(normalizeChildName("Mary Jane")).toBe("Mary Jane");
  });

  test("treats the non-breaking space a phone keyboard emits as a space", () => {
    expect(normalizeChildName("Mary Jane")).toBe("Mary Jane");
    expect(validateChildName("Mary Jane")).toBeNull();
  });

  test("leaves a name that needs nothing doing to it alone", () => {
    expect(normalizeChildName("Nguyễn Minh Anh")).toBe("Nguyễn Minh Anh");
  });

  test("a name that is only whitespace normalises to nothing", () => {
    expect(normalizeChildName("   ")).toBe("");
  });

  test("validates the collapsed form, not what was typed", () => {
    // Without the collapse this is two tokens with a tab between them, and
    // the tab is not on the allow-list.
    expect(validateChildName("Mary\t\tJane")).toBeNull();
  });
});

describe("the length boundary", () => {
  const letters = (count: number) => "a".repeat(count);

  test("accepts exactly the maximum", () => {
    expect(CHILD_NAME_MAX_LENGTH).toBe(64);
    expect(validateChildName(letters(CHILD_NAME_MAX_LENGTH))).toBeNull();
  });

  test("rejects one character past it", () => {
    expect(validateChildName(letters(CHILD_NAME_MAX_LENGTH + 1))).toBe("tooLong");
  });

  test("measures the normalised name, not what was typed", () => {
    // 65 characters typed, 64 stored. Measuring the raw value would reject a
    // name that saves fine.
    const typed = `${letters(32)}  ${letters(31)}`;
    expect(typed.length).toBe(CHILD_NAME_MAX_LENGTH + 1);
    expect(normalizeChildName(typed)).toHaveLength(CHILD_NAME_MAX_LENGTH);
    expect(validateChildName(typed)).toBeNull();
  });

  test("surrounding whitespace never counts toward the limit", () => {
    expect(validateChildName(`   ${letters(CHILD_NAME_MAX_LENGTH)}   `)).toBeNull();
  });

  test("reports an over-long value as too long even when it is also invalid", () => {
    // The order of the checks is part of the agreement with the server: the
    // two sides must give a parent the same answer for the same input.
    expect(validateChildName("9".repeat(CHILD_NAME_MAX_LENGTH + 1))).toBe("tooLong");
  });
});
