/**
 * WCAG 2.1 AA colour contrast, checked against the colours the app actually
 * ships.
 *
 * A colour fix with no test regresses the first time somebody picks a nicer
 * grey, so this suite is built so that a new colour cannot reach a parent
 * without a measured ratio next to it. Three checks hold that shut:
 *
 *  1. Every colour literal in every stylesheet and component the app imports
 *     has to be a value declared in `src/styles/palette.css`, or an entry in
 *     ALPHA_LAYERS below. The palette is read off disk, not copied here, so
 *     changing a token changes what this suite measures.
 *  2. Every palette token has to appear in at least one PAIRS row. Adding a
 *     token and using it somewhere is not enough: you have to say what it
 *     renders against.
 *  3. Every pair has to clear its threshold.
 *
 * Thresholds are AA: 4.5:1 for text, 3:1 for text at 24px or above (18.66px if
 * bold), 3:1 for the boundary of a control or a graphic you need to see to use
 * the page. Each `large` row names the selector and the px size that earns it.
 *
 * Scope notes, so the gaps are stated rather than implied:
 *  - Reachability is resolved from `import './x.css'` statements. Three
 *    stylesheets are not imported by anything and so render nowhere:
 *    components/AppTutorialCarousel.css, pages/AppTutorial.css and
 *    pages/ParentRights.css. They are skipped, and if one is ever imported it
 *    is picked up automatically.
 *  - box-shadow and text-shadow are excluded. Neither carries meaning here.
 *  - Text over the brand pattern photographs cannot be measured from CSS. The
 *    worst pixel of each was measured by hand and is recorded in
 *    IMAGE_BACKDROPS, which the scrim assertion uses.
 *  - WCAG exempts an inactive control from both 1.4.3 and 1.4.11, so the
 *    disabled tokens are asserted only to be distinguishable from the page,
 *    not to reach 3:1.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import AlertMessages from "../components/AlertMessages";
import { LanguageContext } from "./language-context";
import { ALL_LANGUAGES } from "./languages";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PALETTE_FILE = join(SRC, "styles/palette.css");

// ---------------------------------------------------------------------------
// Contrast maths (WCAG 2.1 relative luminance)
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];

function channelToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** Accepts #rgb, #rrggbb and #rrggbbaa; the alpha byte is handled by the caller. */
export function parseHex(hex: string): Rgb {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

function hexAlpha(hex: string): number {
  const h = hex.trim().replace(/^#/, "");
  return h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
}

function parseRgbFunction(value: string): { rgb: Rgb; alpha: number } {
  const parts = value
    .slice(value.indexOf("(") + 1, value.lastIndexOf(")"))
    .split(/[,/]/)
    .map((p) => parseFloat(p.trim()));
  return {
    rgb: [parts[0], parts[1], parts[2]] as Rgb,
    alpha: parts.length > 3 ? parts[3] : 1,
  };
}

function toRgba(value: string): { rgb: Rgb; alpha: number } {
  const v = value.trim().toLowerCase();
  if (v.startsWith("rgb")) return parseRgbFunction(v);
  return { rgb: parseHex(v), alpha: hexAlpha(v) };
}

/** Paints `value` (which may be translucent) onto an opaque backdrop. */
function flatten(value: string, backdrop: string): Rgb {
  const { rgb, alpha } = toRgba(value);
  if (alpha >= 1) return rgb;
  const base = toRgba(backdrop).rgb;
  return rgb.map((c, i) => c * alpha + base[i] * (1 - alpha)) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  return (
    0.2126 * channelToLinear(r) +
    0.7152 * channelToLinear(g) +
    0.0722 * channelToLinear(b)
  );
}

export function contrastRatio(fg: string, bg: string): number {
  const back = flatten(bg, "#ffffff");
  const front = flatten(fg, `rgb(${back.join(",")})`);
  const [a, b] = [luminance(front), luminance(back)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

// ---------------------------------------------------------------------------
// Reading the palette and the code that uses it
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** token name -> declared value, read straight out of palette.css. */
function readPalette(): Map<string, string> {
  const tokens = new Map<string, string>();
  const body = stripComments(readFileSync(PALETTE_FILE, "utf8"));
  for (const [, name, value] of body.matchAll(
    /(--aiep-[a-z0-9-]+)\s*:\s*([^;]+);/g,
  )) {
    tokens.set(name, value.trim().toLowerCase());
  }
  return tokens;
}

const ALL_FILES = walk(SRC);
const MODULES = ALL_FILES.filter(
  (f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f),
);

/** Stylesheets some non-test module imports, so they are in the bundle. */
function reachableStylesheets(): Set<string> {
  const reached = new Set<string>();
  for (const mod of MODULES) {
    const src = readFileSync(mod, "utf8");
    for (const [, spec] of src.matchAll(
      /import\s+['"]([^'"]+\.(?:css|scss))['"]/g,
    )) {
      reached.add(resolve(dirname(mod), spec));
    }
  }
  return reached;
}

const PALETTE = readPalette();
const PALETTE_VALUES = new Set(PALETTE.values());

function token(name: string): string {
  const value = PALETTE.get(name);
  if (!value) throw new Error(`palette.css has no ${name}`);
  return value;
}

// ---------------------------------------------------------------------------
// What renders against what
// ---------------------------------------------------------------------------

type Level = "text" | "large" | "ui" | "surface";

interface Pair {
  /** Palette token name, or a literal for the translucent layers. */
  fg: string;
  bg: string;
  level: Level;
  /** Where it renders, and for `large` rows, the size that earns 3:1. */
  where: string;
}

const MINIMUM: Record<Exclude<Level, "surface">, number> = {
  text: 4.5,
  large: 3,
  ui: 3,
};

const PAIRS: Pair[] = [
  // -- body copy -----------------------------------------------------------
  { fg: "--aiep-ink", bg: "--aiep-cream", level: "text", where: "body copy on the page" },
  { fg: "--aiep-ink", bg: "--aiep-surface-sunk", level: "text", where: "carousel body copy" },
  { fg: "--aiep-ink", bg: "--aiep-surface-field", level: "text", where: "what a parent types into a field; open accordion header" },
  { fg: "--aiep-ink", bg: "--aiep-surface-white", level: "text", where: "code blocks in a summary" },
  { fg: "--aiep-ink", bg: "--aiep-surface-tint", level: "text", where: "file-picker button label" },
  { fg: "--aiep-ink", bg: "--aiep-surface-tint-strong", level: "text", where: "file-picker button, pressed" },
  { fg: "--aiep-ink-soft", bg: "--aiep-surface-white", level: "text", where: "the chosen filename in the upload control" },
  { fg: "--aiep-ink-soft", bg: "--aiep-cream", level: "text", where: "consent line under prefers-contrast: high" },
  { fg: "--aiep-muted", bg: "--aiep-cream", level: "text", where: "blockquotes, breadcrumbs, SMS consent, page-count label" },
  { fg: "--aiep-muted", bg: "--aiep-surface-sunk", level: "text", where: "carousel slide body copy" },
  { fg: "--aiep-muted", bg: "--aiep-surface-field", level: "text", where: "the 'no file chosen' line in the upload control" },
  { fg: "--aiep-muted", bg: "--aiep-surface-white", level: "text", where: "the SSN / address labels and the bracketed placeholders on the sample IEP" },

  // -- links and the jargon terms -----------------------------------------
  { fg: "--aiep-link", bg: "--aiep-cream", level: "text", where: "links in the privacy policy and in summaries" },
  { fg: "--aiep-link", bg: "--aiep-surface-white", level: "text", where: "links inside a code or quote block" },
  { fg: "--aiep-accent-blue", bg: "--aiep-cream", level: "text", where: "jargon terms in a summary (also underlined)" },
  { fg: "--aiep-accent-blue", bg: "--aiep-surface-sunk", level: "ui", where: "the icon on the document-failure card; a fanned document edge against the provider card" },
  { fg: "--aiep-accent-blue-hover", bg: "--aiep-cream", level: "text", where: "a jargon term under the pointer" },
  { fg: "--aiep-cream", bg: "--aiep-accent-blue", level: "text", where: "the jargon drawer title, and the resources banner heading" },

  // -- errors --------------------------------------------------------------
  { fg: "--aiep-error", bg: "--aiep-cream", level: "text", where: "Log out, delete-account button, text-to-speech failure" },
  { fg: "--aiep-error", bg: "--aiep-surface-sunk", level: "text", where: "an error inside a sunk card" },
  { fg: "--aiep-cream", bg: "--aiep-error", level: "text", where: "the delete button while pressed" },

  // -- the greens ----------------------------------------------------------
  { fg: "--aiep-green", bg: "--aiep-cream", level: "text", where: "the unselected login-method label; section headings" },
  { fg: "--aiep-green", bg: "--aiep-surface-sunk", level: "ui", where: "the active carousel dot; a fanned document edge against the provider card" },
  { fg: "--aiep-green-dark", bg: "--aiep-cream", level: "text", where: "dark-green headings" },
  { fg: "--aiep-cream", bg: "--aiep-green", level: "text", where: "nav bar, green banners, primary button label" },
  { fg: "--aiep-cream", bg: "--aiep-green-dark", level: "text", where: "footer, hero panel, processing card" },
  { fg: "--aiep-surface-white", bg: "--aiep-green", level: "text", where: "the partner banner labels" },
  { fg: "--aiep-on-green-muted", bg: "--aiep-green", level: "text", where: "the four nav labels on the in-app bar" },
  { fg: "--aiep-on-green-muted", bg: "--aiep-green-dark", level: "text", where: "the four nav labels on the public bar" },
  { fg: "--aiep-sage", bg: "--aiep-green-dark", level: "text", where: "the language dropdown on the login screen (label and border)" },

  // -- large display type --------------------------------------------------
  // .landing-hero-text is 2.25rem (36px) on mobile and 3rem (48px) from 992px
  // up; .how-to-banner-title is 3rem (48px). Both are well past the 24px that
  // AA counts as large, and both accents are used nowhere else.
  { fg: "--aiep-accent-orange", bg: "--aiep-cream", level: "large", where: ".landing-hero-text-orange / .how-to-banner-title-orange, 36-48px" },
  { fg: "--aiep-accent-rose", bg: "--aiep-cream", level: "large", where: ".landing-hero-text-pink, 36-48px" },

  // -- the gold name chip, and the same gold on the privacy screen ----------
  { fg: "--aiep-ink", bg: "--aiep-amber", level: "text", where: "the child's name in the chip above the upload heading; the SSN and address on the sample IEP" },
  { fg: "--aiep-amber", bg: "--aiep-cream", level: "surface", where: "the chip itself against the page; the name inside it is what has to be read" },
  { fg: "--aiep-amber", bg: "--aiep-surface-white", level: "surface", where: "the highlight on the sample document, against the paper; the value inside it is what has to be read" },

  // -- the privacy screen's document tones ---------------------------------
  // The five tones the fanned document edges (over the #EEEBE5 card) and the
  // summary bars (over the white document) are drawn in. They are decoration
  // -- the five step sentences say what is happening, and the whole
  // illustration is aria-hidden -- so SC 1.4.11 arguably exempts them
  // entirely. Held to the 3:1 a meaningful graphical object would need
  // anyway, because "decorative" is a judgement that gets revisited and a
  // parent with low vision should be able to see that these are five
  // different things.
  { fg: "--aiep-green", bg: "--aiep-surface-white", level: "ui", where: "summary bar 1 on the sample document" },
  { fg: "--aiep-accent-blue", bg: "--aiep-surface-white", level: "ui", where: "summary bar 2 on the sample document" },
  { fg: "--aiep-accent-violet", bg: "--aiep-surface-white", level: "ui", where: "summary bar 3 on the sample document" },
  { fg: "--aiep-accent-rose", bg: "--aiep-surface-white", level: "ui", where: "summary bar 4 on the sample document" },
  { fg: "--aiep-accent-orange", bg: "--aiep-surface-white", level: "ui", where: "summary bar 5 on the sample document" },
  { fg: "--aiep-accent-violet", bg: "--aiep-surface-sunk", level: "ui", where: "a fanned document edge against the provider card" },
  { fg: "--aiep-accent-rose", bg: "--aiep-surface-sunk", level: "ui", where: "a fanned document edge against the provider card" },
  { fg: "--aiep-accent-orange", bg: "--aiep-surface-sunk", level: "ui", where: "a fanned document edge against the provider card" },
  { fg: "--aiep-surface-white", bg: "--aiep-surface-sunk", level: "surface", where: "the sample documents against the provider card; their 3:1 edge comes from --aiep-border" },

  // -- boundaries ----------------------------------------------------------
  { fg: "--aiep-border", bg: "--aiep-cream", level: "ui", where: "input, select, card, table and dropdown edges" },
  { fg: "--aiep-border", bg: "--aiep-surface-sunk", level: "ui", where: "the carousel prev/next buttons" },
  { fg: "--aiep-border", bg: "--aiep-surface-field", level: "ui", where: "the file-picker button against the filename field" },
  { fg: "--aiep-border", bg: "--aiep-surface-white", level: "ui", where: "table gridlines inside a code or quote block" },

  // -- full-bleed QR overlay ----------------------------------------------
  { fg: "--aiep-cream", bg: "--aiep-overlay-navy", level: "text", where: "the referral URL under the QR code" },
  { fg: "--aiep-surface-white", bg: "--aiep-overlay-navy", level: "ui", where: "the QR quiet zone against the overlay" },
  { fg: "--aiep-black", bg: "--aiep-surface-white", level: "ui", where: "the QR modules a camera has to separate" },

  // -- vendor alert palette, reproduced in AlertMessages.css ---------------
  { fg: "--aiep-alert-success-fg", bg: "--aiep-alert-success-bg", level: "text", where: "'Signed in' and other success alerts" },
  { fg: "--aiep-alert-danger-fg", bg: "--aiep-alert-danger-bg", level: "text", where: "sign-in error alerts" },
  { fg: "--aiep-alert-info-fg", bg: "--aiep-alert-info-bg", level: "text", where: "informational alerts" },

  // -- surfaces, measured only to keep them apart from the page ------------
  { fg: "--aiep-surface-sunk", bg: "--aiep-cream", level: "surface", where: "sunk card behind the page" },
  { fg: "--aiep-surface-field", bg: "--aiep-cream", level: "surface", where: "field fill; its 3:1 edge comes from --aiep-border" },
  { fg: "--aiep-surface-tint", bg: "--aiep-cream", level: "surface", where: "file-picker button fill" },
  { fg: "--aiep-surface-tint-strong", bg: "--aiep-cream", level: "surface", where: "pressed/inert fill" },
  { fg: "--aiep-cream-veil", bg: "--aiep-green-dark", level: "surface", where: "1px grid texture on the modal scrim" },
  { fg: "--aiep-image-scrim", bg: "--aiep-green", level: "surface", where: "the layer over the hub card photographs; measured against the artwork in IMAGE_BACKDROPS" },
  { fg: "--aiep-image-scrim-soft", bg: "--aiep-green", level: "surface", where: "the layer over the rights card photographs; measured against the artwork in IMAGE_BACKDROPS" },

  // -- inactive controls: exempt from 1.4.3 and 1.4.11 --------------------
  { fg: "--aiep-disabled-border", bg: "--aiep-cream", level: "surface", where: "disabled button edge" },
  { fg: "--aiep-disabled-text", bg: "--aiep-cream", level: "surface", where: "disabled button label" },
];

/**
 * Translucent layers, which have no palette token because what they mean
 * depends on what is behind them. Every rgba() in the app is listed here.
 */
const ALPHA_LAYERS: {
  value: string;
  over: string;
  level: Level | "decorative";
  where: string;
}[] = [
  { value: "rgba(255,255,255,0.85)", over: "--aiep-green", level: "text", where: "the SMS-frequency line in the public footer, 12px" },
  { value: "rgba(245, 243, 238, 0.75)", over: "--aiep-overlay-navy", level: "text", where: "the hint under the QR code" },
  { value: "rgba(245, 243, 238, 0.4)", over: "--aiep-overlay-navy", level: "ui", where: "the close button on the QR overlay" },
  { value: "rgba(0, 64, 186, 0.05)", over: "--aiep-green", level: "decorative", where: "a 5% wash under a nav item on hover; the label colour is what changes" },
  { value: "rgba(255, 255, 255, 0.2)", over: "--aiep-green", level: "decorative", where: "the rule under the partner banner, separating two bands of the same green" },
  { value: "rgba(255, 255, 255, 0.15)", over: "--aiep-green", level: "decorative", where: "rules between partner links in the mobile dropdown" },
  { value: "rgba(255, 255, 255, 0.95)", over: "--aiep-surface-sunk", level: "decorative", where: "dead: the very next declaration in the same rule overrides it with --aiep-surface-sunk" },
  { value: "rgba(30, 30, 30, 0.1)", over: "--aiep-cream", level: "decorative", where: "hovered dropdown item; the item's own text carries the meaning" },
  { value: "rgba(30, 30, 30, 0.2)", over: "--aiep-cream", level: "decorative", where: "selected dropdown item; the check mark carries the meaning" },
];

/**
 * Worst case for cream text over a photograph is its brightest pixel. These
 * are the brightest pixel of each brand pattern the app puts cream text on,
 * sampled from public/images at 160px wide. Bare, they ran 1.39:1 to 3.10:1,
 * which is why the scrims exist. Re-measure if the artwork is replaced.
 *
 * `scrim` names the token layered over the photograph and `need` the threshold
 * the copy on it has to reach: the hub cards carry an 18.4px body line (4.5:1)
 * and the rights cards only a 40px h1 (3:1).
 */
const IMAGE_BACKDROPS: {
  name: string;
  brightest: string;
  scrim: string;
  need: number;
  where: string;
}[] = [
  // Hub cards: --aiep-image-scrim, 18.4px body copy under a 40px heading.
  { name: "patterns-red-h", brightest: "#f84d34", scrim: "--aiep-image-scrim", need: 4.5, where: "AIEPToolCard" },
  { name: "patterns-yellow-h", brightest: "#ffc900", scrim: "--aiep-image-scrim", need: 4.5, where: "AIEPToolCard" },
  { name: "patterns-orange-h", brightest: "#ffa600", scrim: "--aiep-image-scrim", need: 4.5, where: "AIEPToolCard" },
  { name: "patterns-pink-h", brightest: "#ffb0bc", scrim: "--aiep-image-scrim", need: 4.5, where: "AIEPToolCard" },
  { name: "patterns-blue-h", brightest: "#00a9e7", scrim: "--aiep-image-scrim", need: 4.5, where: "AIEPToolCard" },
  { name: "patterns-light-green-h", brightest: "#81ce91", scrim: "--aiep-image-scrim", need: 4.5, where: "AIEPToolCard" },
  // Rights cards: --aiep-image-scrim-soft, a 40px h1 and nothing else.
  { name: "patterns-pink", brightest: "#ffabb9", scrim: "--aiep-image-scrim-soft", need: 3, where: ".banner-card / .parent-rights-card h1, 40px" },
  { name: "patterns-blue", brightest: "#00a6e6", scrim: "--aiep-image-scrim-soft", need: 3, where: ".parent-rights-card--blue h1, 40px" },
  { name: "patterns-dark-green", brightest: "#00683f", scrim: "--aiep-image-scrim-soft", need: 3, where: ".banner-card--green h1, 40px" },
];

// ---------------------------------------------------------------------------

function resolveColor(nameOrLiteral: string): string {
  return nameOrLiteral.startsWith("--") ? token(nameOrLiteral) : nameOrLiteral;
}

describe("palette", () => {
  it("declares every colour the app renders", () => {
    const stylesheets = [...reachableStylesheets()].filter((f) =>
      /\.(css|scss)$/.test(f),
    );
    const alphaValues = new Set(
      ALPHA_LAYERS.map((l) => l.value.toLowerCase().replace(/\s+/g, " ")),
    );
    const NAMED_COLOR =
      /(?:^|[\s:,(])(white|black|red|blue|green|gray|grey|silver|yellow|orange|pink|purple|navy|teal)(?=[\s;,)]|$)/g;
    const unregistered: string[] = [];

    for (const file of [...stylesheets, ...MODULES].sort()) {
      const lines = stripComments(readFileSync(file, "utf8")).split("\n");
      lines.forEach((raw, i) => {
        // The palette's own declarations, and shadows, are out of scope.
        if (/^\s*--aiep-/.test(raw)) return;
        if (/box-shadow|text-shadow/.test(raw)) return;
        const where = `${relative(SRC, file)}:${i + 1}`;
        for (const found of raw.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) ??
          []) {
          const value = found.toLowerCase().replace(/\s+/g, " ");
          if (PALETTE_VALUES.has(value) || alphaValues.has(value)) continue;
          unregistered.push(`${where}  ${found}`);
        }
        // A named colour is just as much a new colour as a hex one, but only
        // in a stylesheet: "blue" in a TSX string is prose. Strip
        // var(--aiep-accent-blue) and friends first so token names do not read
        // as keywords, and only look at the value side of a declaration.
        if (!/\.(css|scss)$/.test(file)) return;
        const value = raw.replace(/var\([^)]*\)/g, "").split(":").slice(1).join(":");
        for (const [, keyword] of value.matchAll(NAMED_COLOR)) {
          unregistered.push(`${where}  ${keyword}`);
        }
      });
    }

    expect(
      unregistered,
      `colours used but not declared in styles/palette.css:\n  ${unregistered.join("\n  ")}`,
    ).toEqual([]);
  });

  it("measures every token it declares", () => {
    const measured = new Set(
      PAIRS.flatMap((p) => [p.fg, p.bg]).filter((c) => c.startsWith("--")),
    );
    const unmeasured = [...PALETTE.keys()].filter((t) => !measured.has(t));
    expect(
      unmeasured,
      `palette tokens with no contrast pair; add a PAIRS row saying what each renders against:\n  ${unmeasured.join("\n  ")}`,
    ).toEqual([]);
  });
});

describe("SC 1.4.3 contrast (minimum) and SC 1.4.11 non-text contrast", () => {
  for (const pair of PAIRS) {
    if (pair.level === "surface") continue;
    const need = MINIMUM[pair.level];
    const label =
      pair.level === "large"
        ? `${pair.fg} on ${pair.bg} reaches ${need}:1 as large text (${pair.where})`
        : `${pair.fg} on ${pair.bg} reaches ${need}:1 (${pair.where})`;

    it(label, () => {
      const ratio = contrastRatio(resolveColor(pair.fg), resolveColor(pair.bg));
      expect(
        ratio,
        `${pair.fg} (${resolveColor(pair.fg)}) on ${pair.bg} (${resolveColor(pair.bg)}) is ${ratio.toFixed(2)}:1, needs ${need}:1 -- ${pair.where}`,
      ).toBeGreaterThanOrEqual(need);
    });
  }

  for (const layer of ALPHA_LAYERS) {
    if (layer.level === "decorative" || layer.level === "surface") continue;
    const need = MINIMUM[layer.level];
    it(`${layer.value} over ${layer.over} reaches ${need}:1 (${layer.where})`, () => {
      const ratio = contrastRatio(layer.value, token(layer.over));
      expect(
        ratio,
        `${layer.value} over ${layer.over} is ${ratio.toFixed(2)}:1, needs ${need}:1 -- ${layer.where}`,
      ).toBeGreaterThanOrEqual(need);
    });
  }

  it("says why each decorative layer is exempt", () => {
    for (const layer of ALPHA_LAYERS.filter((l) => l.level === "decorative")) {
      expect(layer.where.length, `${layer.value} needs a reason`).toBeGreaterThan(
        30,
      );
    }
  });

  it("keeps cream card copy readable over every brand pattern photograph", () => {
    const cream = token("--aiep-cream");
    for (const image of IMAGE_BACKDROPS) {
      const scrimmed = flatten(token(image.scrim), image.brightest);
      const ratio = contrastRatio(cream, `rgb(${scrimmed.join(",")})`);
      expect(
        ratio,
        `cream text over ${image.name} is ${ratio.toFixed(2)}:1 through ${image.scrim}, needs ${image.need}:1 -- ${image.where}`,
      ).toBeGreaterThanOrEqual(image.need);
    }
  });

  it("keeps an inactive control visible even though AA exempts it", () => {
    // Not 3:1 -- looking inactive is the point -- but it must not vanish.
    const cream = token("--aiep-cream");
    for (const t of ["--aiep-disabled-border", "--aiep-disabled-text"]) {
      expect(contrastRatio(token(t), cream)).toBeGreaterThan(1.4);
    }
  });
});

describe("SC 1.4.1 use of colour", () => {
  const read = (p: string) => readFileSync(join(SRC, p), "utf8");

  it("underlines a jargon term rather than only colouring it", () => {
    const css = read("pages/iep-folder/IEPSummarizationAndTranslation.css");
    const rule = css.slice(css.indexOf(".jargon-term {"));
    expect(rule.slice(0, rule.indexOf("}"))).toMatch(
      /text-decoration:\s*underline/,
    );
  });

  it("gives the selected nav tab a signal that is not its colour", () => {
    // The active tab's background is the same green as the bar behind it, so
    // without these the only difference is the label colour.
    for (const file of [
      "components/MobileTopNavigation.css",
      "components/LandingTopNavigation.css",
    ]) {
      const css = read(file);
      expect(css, `${file} should underline the active tab`).toMatch(
        /\.nav-item\.active\s*{[^}]*border-bottom-color:/,
      );
      expect(css, `${file} should embolden the active tab's label`).toMatch(
        /\.nav-item\.active\s+\.nav-label\s*{[^}]*font-weight:\s*700/,
      );
    }
  });

  it("tells a parent what went wrong in words, not only in red", () => {
    // Every failure on the sign-in screen goes through AlertMessages. The two
    // variants differ in colour, so the message text is what has to carry the
    // difference; assert it is rendered rather than trusting the variant.
    const renderAlert = (props: {
      error: string | null;
      successMessage: string | null;
    }) =>
      render(
        <LanguageContext.Provider
          value={{
            language: "en",
            setLanguage: vi.fn(),
            t: (key: string) => `translated:${key}`,
            translationsLoaded: true,
            enabledLanguages: ALL_LANGUAGES,
          }}
        >
          <AlertMessages {...props} />
        </LanguageContext.Provider>,
      );

    const failed = renderAlert({
      error: "auth.errorIncorrectCredentials",
      successMessage: null,
    });
    expect(
      failed.getByText("translated:auth.errorIncorrectCredentials"),
    ).toBeInTheDocument();
    failed.unmount();

    const worked = renderAlert({ error: null, successMessage: "auth.codeSent" });
    expect(worked.getByText("translated:auth.codeSent")).toBeInTheDocument();
  });
});
