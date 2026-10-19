/**
 * The landing page's banner carousel. Its dots are the only way a parent can
 * jump between slides, so they have to be big enough to hit (WCAG 2.2 SC 2.5.8)
 * and named in the parent's language, not react-bootstrap's English "Slide N".
 *
 * Nothing is mocked: the real component, driven through the DOM.
 */
import React from "react";
import { describe, expect, test } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { fireEvent, render, screen, within } from "@testing-library/react";
import ParentRightsBanner from "./ParentRightsBanner";
import { LanguageContext } from "../common/language-context";
import type { SupportedLanguage } from "../common/languages";

import en from "../translations/en.json";
import es from "../translations/es.json";
import zh from "../translations/zh.json";
import vi from "../translations/vi.json";
import ar from "../translations/ar.json";

const dictionaries = { en, es, zh, vi, ar } as Record<string, Record<string, string>>;

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "ParentRightsBanner.css"),
  "utf8",
);

/** The banner's eight slides, in order, as the parent sees them in English. */
const SLIDE_TITLE_KEYS = [
  "privacy.slide1.title",
  "privacy.slide2.title",
  "rights.slide1.title",
  "rights.slide2.title",
  "rights.slide3.title",
  "rights.slide4.title",
  "rights.slide5.title",
  "rights.slide6.title",
];

/**
 * The language context as the app supplies it: a real dictionary off disk and
 * the real `translations[key] || key` lookup, so a key missing from a locale
 * surfaces here as the raw key rather than as a pass.
 */
const inLanguage = (code: string) =>
  render(
    <LanguageContext.Provider
      value={{
        language: code as SupportedLanguage,
        setLanguage: () => {},
        t: (key: string) => dictionaries[code][key] || key,
        translationsLoaded: true,
        enabledLanguages: [code as SupportedLanguage],
      }}
    >
      <ParentRightsBanner />
    </LanguageContext.Provider>,
  );

const dots = () => within(screen.getByTestId("banner-dots")).getAllByRole("button");

const activeDotIndex = () => dots().findIndex((dot) => dot.getAttribute("aria-current") === "true");

/** The left card's picture is named after the slide on screen. */
const onScreenSlideTitle = () => document.querySelector(".banner-slide-image")?.getAttribute("alt");

/** The rule's body in the stylesheet, or fails the test if it is missing. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(CSS);
  expect(match, `ParentRightsBanner.css has no ${selector} rule`).not.toBeNull();
  return match![2];
}

describe("the banner's dots", () => {
  test("there is one per slide", () => {
    inLanguage("en");

    expect(dots()).toHaveLength(SLIDE_TITLE_KEYS.length);
  });

  test("react-bootstrap's own indicators are gone, so nothing says 'Slide N' in English", () => {
    const { container } = inLanguage("es");

    expect(container.querySelector(".carousel-indicators")).toBeNull();
    dots().forEach((dot, index) => {
      expect(dot).not.toHaveAccessibleName(`Slide ${index + 1}`);
    });
  });

  test.each(Object.keys(dictionaries))(
    "each is named from the %s dictionary, using the carousel's existing key",
    (code) => {
      inLanguage(code);

      dots().forEach((dot, index) => {
        const expected = dictionaries[code]["carousel.goToSlide"].replace("{number}", String(index + 1));
        expect(dot).toHaveAccessibleName(expected);
      });
    },
  );

  test("tapping one goes to that slide and marks it current", () => {
    inLanguage("en");

    fireEvent.click(dots()[3]);

    expect(onScreenSlideTitle()).toBe(en[SLIDE_TITLE_KEYS[3]]);
    expect(activeDotIndex()).toBe(3);
    expect(dots()[3]).toHaveAttribute("aria-current", "true");
    expect(dots()[0]).not.toHaveAttribute("aria-current");
  });

  test("the current dot follows the Next button too", () => {
    inLanguage("en");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(activeDotIndex()).toBe(1);
    expect(onScreenSlideTitle()).toBe(en[SLIDE_TITLE_KEYS[1]]);
  });

  test("each dot is a button with a 24px hit area in the stylesheet", () => {
    // jsdom cannot measure layout, so the size is pinned in the CSS itself.
    const hitArea = rule(".banner-dot");

    expect(hitArea).toMatch(/(^|;)\s*width:\s*24px/);
    expect(hitArea).toMatch(/(^|;)\s*height:\s*24px/);
    expect(hitArea).toMatch(/min-width:\s*24px/);
    expect(hitArea).toMatch(/min-height:\s*24px/);
  });

  test("the visible dot stays small: 8px, drawn by the pseudo-element", () => {
    const visibleDot = rule(".banner-dot::before");

    expect(visibleDot).toMatch(/width:\s*8px/);
    expect(visibleDot).toMatch(/height:\s*8px/);
  });

  test("keyboard focus has a visible outline", () => {
    expect(rule(".banner-dot:focus-visible")).toMatch(/outline:\s*2px solid/);
  });

  test("the active dot is styled differently from the rest", () => {
    expect(rule(".banner-dot.active::before")).toMatch(/background-color:\s*#00682F/);
    expect(rule(".banner-dot::before")).not.toMatch(/#00682F/);
  });

  test("the row is positioned on both edges, so it centres under RTL too", () => {
    const row = rule(".banner-dots");

    expect(row).toMatch(/(^|;)\s*left:\s*0/);
    expect(row).toMatch(/(^|;)\s*right:\s*0/);
  });

  test("the Arabic banner renders the same dots in RTL", () => {
    inLanguage("ar");

    expect(dots()).toHaveLength(SLIDE_TITLE_KEYS.length);
    expect(dots()[0]).toHaveAccessibleName(ar["carousel.goToSlide"].replace("{number}", "1"));
  });
});
