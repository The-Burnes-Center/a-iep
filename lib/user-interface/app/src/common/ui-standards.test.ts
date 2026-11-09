/**
 * Holds the line docs/UI_STANDARDS.md draws: anything a parent presses to do
 * something is the shared Button (components/ui/Button.tsx).
 *
 * An inventory on 2026-11-09 found about 95 live buttons in 15 looks and nine
 * heights, built from Bootstrap's <Button>, `className="btn ..."` on links, and
 * raw <button>s each styled on its own. Without this, the next screen adds a
 * sixteenth. It reads the source rather than rendering, so it covers screens
 * no other test mounts.
 *
 * The admin console (pages/admin) is internal and English-only by design and
 * is out of scope. A raw <button> is allowed only in the files listed in
 * PURPOSE_BUILT, each a control that is deliberately not a button-looking
 * action (navigation tabs, the language menu, a chevron row): add to it only
 * with the reason beside the entry.
 */
import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Files whose raw <button>s are purpose-built controls, with why. */
const PURPOSE_BUILT: Record<string, string> = {
  "components/ui/Button.tsx": "the shared Button itself",
  "components/MobileTopNavigation.tsx": "the bottom/top navigation tabs",
  "pages/utils/content-processor.ts": "glossary terms inline in running text",
  "pages/profile/PreferredLanguage.tsx": "list-row language choices (aria-pressed), not action pills",
  "components/ParentRightsBanner.tsx": "the landing carousel's previous/next arrows and slide dots",
  "components/PartnerBanner.tsx": "the landing's partner-list disclosure toggle",
  "components/ParentRightsCarousel.tsx": "the rights carousel's icon-only previous/next arrows",
  "pages/profile/InvitePage.tsx": "the QR picture itself, which opens the full-screen code",
  "pages/profile/InviteQrOverlay.tsx": "the full-screen QR's round, icon-only close control",
};

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "admin" || entry === "prerender" ? [] : sourceFiles(path);
    return /\.(tsx|ts)$/.test(entry) && !/\.test\.|\.testutil\./.test(entry) ? [path] : [];
  });

const files = sourceFiles(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, "utf8") }));

const offenders = (match: (text: string) => boolean, allow: Record<string, string> = {}) =>
  files.filter(({ path, text }) => !(path in allow) && match(text)).map(({ path }) => path).sort();

describe("every action is the shared Button", () => {
  test("no screen imports react-bootstrap's Button", () => {
    const importsBootstrapButton = (text: string) =>
      /import\s*\{[^}]*\bButton\b[^}]*\}\s*from\s*['"]react-bootstrap['"]/.test(text);
    expect(offenders(importsBootstrapButton)).toEqual([]);
  });

  test("no link is dressed up with Bootstrap's button classes", () => {
    // A navigating action is <Button to=...>, never <Link className="btn ...">.
    const linkAsBootstrapButton = (text: string) => /<(Link|a)\b[^>]*className=["'{`][^"'`}]*\bbtn\b/.test(text);
    expect(offenders(linkAsBootstrapButton)).toEqual([]);
  });

  test("raw <button>s exist only in the purpose-built controls listed above", () => {
    const rawButton = (text: string) => /<button\b/.test(text);
    expect(offenders(rawButton, PURPOSE_BUILT)).toEqual([]);
  });

  test("every purpose-built entry still exists and still needs its exception", () => {
    const stale = Object.keys(PURPOSE_BUILT).filter((path) => {
      const file = files.find((f) => f.path === path);
      return !file || !/<button\b/.test(file.text);
    });
    expect(stale).toEqual([]);
  });
});
