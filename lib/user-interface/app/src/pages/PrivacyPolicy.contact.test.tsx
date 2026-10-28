/**
 * a-iep.org/contact redirects to /public-privacy-policy#contact
 * (lib/user-interface/edge-routing.ts). The page renders after the browser
 * has already looked for the anchor, so without its own scroll a parent
 * landed at the top of a long policy with the contact details at the bottom.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import PrivacyPolicy from "./PrivacyPolicy";
import { LanguageContext } from "../common/language-context";
import type { SupportedLanguage } from "../common/languages";

const languageValue = {
  language: "en" as SupportedLanguage,
  setLanguage: vi.fn(),
  t: (key: string) => key,
  translationsLoaded: true,
  enabledLanguages: ["en"] as SupportedLanguage[],
};

const scrollIntoView = vi.fn();

beforeEach(() => {
  // jsdom does not implement scrolling.
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  scrollIntoView.mockReset();
});

const renderAt = (entry: string, translationsLoaded = true) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <LanguageContext.Provider value={{ ...languageValue, translationsLoaded }}>
        <PrivacyPolicy isPublic />
      </LanguageContext.Provider>
    </MemoryRouter>,
  );

describe("the privacy policy's contact anchor", () => {
  test("#contact scrolls to the contact section and moves focus to its heading", () => {
    renderAt("/public-privacy-policy#contact");

    const heading = screen.getByRole("heading", { name: "privacyPolicy.contact.title" });
    expect(heading.closest("section")).toHaveAttribute("id", "contact");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(heading);
    expect(heading).toHaveFocus();
  });

  test("without the hash the page opens at the top, untouched", () => {
    renderAt("/public-privacy-policy");

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.body).toHaveFocus();
  });

  test("waits for the page to render before scrolling", () => {
    renderAt("/public-privacy-policy#contact", false);

    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
