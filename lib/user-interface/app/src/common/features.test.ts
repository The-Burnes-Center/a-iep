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

describe("the placeholder name has one definition", () => {
  /**
   * Three call sites wrote the literal 'My Child' instead of importing this
   * constant, while isPlaceholderChildName compared against the constant. The
   * two agreeing was a coincidence maintained by hand: changing the constant
   * would have left those three writing a name the gate no longer recognised,
   * so a parent would have been asked for a name they had already given.
   *
   * Read off disk rather than by grepping imports, because the failure mode is
   * a string literal, and a literal is invisible to the type system.
   */
  test("no source file writes the placeholder as a literal", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        // features.ts is where it is defined; tests may name it in fixtures.
        if (entry.name === "features.ts" || /\.test\.tsx?$/.test(entry.name)) continue;
        fs.readFileSync(full, "utf8").split("\n").forEach((line, i) => {
          // A comment explaining the placeholder is fine; passing it is not.
          if (/(['"])My Child\1/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) {
            offenders.push(`${path.relative(srcDir, full)}:${i + 1}`);
          }
        });
      }
    };
    walk(srcDir);

    expect(offenders).toEqual([]);
  });
});
