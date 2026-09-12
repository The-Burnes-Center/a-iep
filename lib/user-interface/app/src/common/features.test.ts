/**
 * The studentNameGate predicates and the master feature list they were added
 * to. `isPlaceholderChildName` / `isStudentNameMissing` decide "no name
 * given" for every onboarding screen that checks the gate (PreferredLanguage,
 * ConsentForm, ViewAndAddChild), so this is the one place that decision is
 * pinned rather than re-derived per screen.
 */
import { describe, expect, test } from "vitest";
import {
  ALL_FEATURES,
  DEFAULT_CHILD_NAME,
  isFeature,
  isPlaceholderChildName,
  isStudentNameMissing,
  resolveEnabledFeatures,
} from "./features";

describe("isPlaceholderChildName", () => {
  test.each([
    { label: "an empty string", name: "" },
    { label: "whitespace only", name: "   " },
    { label: "the auto-created placeholder", name: DEFAULT_CHILD_NAME },
    { label: "undefined", name: undefined },
    { label: "null", name: null },
  ])("$label counts as no name given", ({ name }) => {
    expect(isPlaceholderChildName(name)).toBe(true);
  });

  test.each([
    { label: "a real name", name: "Alex" },
    { label: "a real name with incidental whitespace", name: " Alex Rivera " },
    // Case matters: only the exact placeholder string is special-cased, so a
    // parent who actually named their child this is not silently overridden.
    { label: "a name that merely contains the placeholder text", name: "My Child Alex" },
  ])("$label counts as a name given", ({ name }) => {
    expect(isPlaceholderChildName(name)).toBe(false);
  });
});

describe("isStudentNameMissing", () => {
  test("true when there are no children at all", () => {
    expect(isStudentNameMissing({ children: [] })).toBe(true);
    expect(isStudentNameMissing({})).toBe(true);
    expect(isStudentNameMissing(null)).toBe(true);
    expect(isStudentNameMissing(undefined)).toBe(true);
  });

  test("true when the first child's name is blank or the placeholder", () => {
    expect(isStudentNameMissing({ children: [{ name: "" }] })).toBe(true);
    expect(isStudentNameMissing({ children: [{ name: DEFAULT_CHILD_NAME }] })).toBe(true);
  });

  test("false once the first child has a real name", () => {
    expect(isStudentNameMissing({ children: [{ name: "Alex Rivera" }] })).toBe(false);
  });

  test("only the first child's name is ever checked", () => {
    // children[0] is what onboarding collects and what the redaction
    // pipeline restores from; a second child existing must not mask a
    // missing first name, nor the reverse.
    expect(
      isStudentNameMissing({ children: [{ name: "" }, { name: "Sibling" }] }),
    ).toBe(true);
    expect(
      isStudentNameMissing({ children: [{ name: "Alex" }, { name: "" }] }),
    ).toBe(false);
  });
});

describe("the master feature list", () => {
  test("recognises studentNameGate", () => {
    expect(ALL_FEATURES).toContain("studentNameGate");
    expect(isFeature("studentNameGate")).toBe(true);
  });

  test("resolveEnabledFeatures includes studentNameGate by default (dev/staging), and only when named otherwise", () => {
    expect(resolveEnabledFeatures(undefined)).toContain("studentNameGate");
    expect(resolveEnabledFeatures(null)).toContain("studentNameGate");
    expect(resolveEnabledFeatures([])).not.toContain("studentNameGate");
    expect(resolveEnabledFeatures(["studentNameGate"])).toEqual(["studentNameGate"]);
    expect(resolveEnabledFeatures(["referrals"])).not.toContain("studentNameGate");
  });
});
