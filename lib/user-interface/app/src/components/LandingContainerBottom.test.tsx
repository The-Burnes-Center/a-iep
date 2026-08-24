/**
 * The privacy diagram is artwork with its text baked into the image, so unlike
 * every other string on this page it cannot go through t(). A Spanish-speaking
 * parent reading the privacy section was shown the English drawing regardless
 * of the language they had picked.
 *
 * Two things are pinned here: the language -> file mapping, and that each file
 * the component can emit actually exists in public/. jsdom does not fetch
 * images, so a src pointing at a deleted asset renders green in a DOM
 * assertion and as a broken image in the browser.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import LandingContainerBottom from "./LandingContainerBottom";
import { LanguageContext } from "../common/language-context";
import { ALL_LANGUAGES, type SupportedLanguage } from "../common/languages";

const PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../public",
);

const renderIn = (language: SupportedLanguage) => {
  render(
    <LanguageContext.Provider
      value={{
        language,
        setLanguage: vi.fn(),
        // Identity t(): the diagram is found by its alt translation key, and
        // only the src is under test here.
        t: (key: string) => key,
        translationsLoaded: true,
        enabledLanguages: ALL_LANGUAGES,
      }}
    >
      <LandingContainerBottom />
    </LanguageContext.Provider>,
  );

  return screen.getByAltText("landingContainer.privacyAndTrust.diagramAlt");
};

describe("privacy diagram language", () => {
  test("Spanish gets the Spanish drawing", () => {
    expect(renderIn("es")).toHaveAttribute(
      "src",
      "/images/privacy-diagram-es.jpg",
    );
  });

  // Only English and Spanish versions of the artwork exist. The rest must fall
  // back rather than request a file that was never drawn.
  test.each(ALL_LANGUAGES.filter((l) => l !== "es"))(
    "%s falls back to the English drawing",
    (language) => {
      expect(renderIn(language)).toHaveAttribute(
        "src",
        "/images/privacy-diagram-en.jpg",
      );
    },
  );

  test.each(ALL_LANGUAGES)("the file %s resolves to is present in public/", (language) => {
    const src = renderIn(language).getAttribute("src") as string;
    expect(existsSync(path.join(PUBLIC_DIR, src))).toBe(true);
  });
});
