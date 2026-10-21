/**
 * The onboarding top bar: what the trail says, and where the language selector
 * belongs.
 *
 * This file used to pin when a BACK pill was offered, because the pill had to
 * guess whether `navigate(-1)` had anywhere of ours to go and got it wrong in
 * both directions. It was replaced by the breadcrumb trail the rest of the app
 * already used, which each screen names outright, so the question the old
 * tests asked no longer exists. What survives from them is the defect they
 * were written for and the rule it produced:
 *
 *  - a way back must never leave a signed-in parent on '/' or '/login'. Every
 *    crumb here is a named in-app route, and the first onboarding step offers
 *    no link at all rather than one out of the app. Pinned per screen in
 *    pages/profile/onboarding-trail.test.tsx.
 *  - the row drew its own language dropdown, in a different place from every
 *    other screen's. The picker now lives only in the top bar's language spot
 *    (NavLanguageSlot.tsx), which the language step empties.
 *
 * What the trail EMITS (nav landmark, real links, aria-current) is pinned once
 * in Breadcrumbs.test.tsx; this file is about the bar that carries it.
 */
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import OnboardingTopBar from "./OnboardingChrome";
import { STEP } from "../common/breadcrumb-steps";
import { LanguageContext } from "../common/language-context";
import type { SupportedLanguage } from "../common/languages";

/** t() is the identity, so assertions read translation keys. */
const languageValue = {
  language: "en" as SupportedLanguage,
  setLanguage: vi.fn(),
  t: (key: string) => key,
  translationsLoaded: true,
  enabledLanguages: ["en", "es"] as SupportedLanguage[],
};

const renderBar = (element: React.ReactElement) => {
  render(
    <MemoryRouter initialEntries={["/view-update-add-child"]}>
      <LanguageContext.Provider value={languageValue}>{element}</LanguageContext.Provider>
    </MemoryRouter>,
  );
};

const crumbs = () => screen.queryAllByRole("listitem").map((item) => item.textContent);

/** What LanguageDropdown's toggle renders for the selected option. */
const languageToggle = () => screen.queryByRole("button", { name: "English" });

describe("the onboarding trail", () => {
  test("shows the step before this one and this one, in that order", () => {
    renderBar(<OnboardingTopBar trail={[STEP.consent, STEP.child]} />);

    expect(crumbs()).toEqual(["breadcrumb.consent", "breadcrumb.child"]);
  });

  test("links the previous step and marks this one as where the parent is", () => {
    renderBar(<OnboardingTopBar trail={[STEP.consent, STEP.child]} />);

    expect(screen.getByRole("link", { name: "breadcrumb.consent" })).toHaveAttribute(
      "href",
      "/consent-form",
    );
    expect(screen.getByText("breadcrumb.child")).toHaveAttribute("aria-current", "page");
  });

  test("offers no link at all on a screen that is the start of the flow", () => {
    // The language step. A parent who pushed the sign-in card and then signed
    // in has an entry behind them and it is the login form: having somewhere
    // to go is not the same as having somewhere worth going.
    renderBar(<OnboardingTopBar trail={[STEP.language]} />);

    expect(crumbs()).toEqual(["breadcrumb.language"]);
    expect(screen.queryByRole("link")).toBeNull();
  });

  test("is absent entirely when a screen names no trail", () => {
    renderBar(<OnboardingTopBar />);

    expect(screen.queryByRole("navigation")).toBeNull();
  });
});

describe("the onboarding language selector", () => {
  test("is not drawn by the onboarding row: the top bar owns the one picker", () => {
    // It used to sit on this row's trailing edge, a different place from
    // every other screen. NavLanguageSlot.test.tsx pins the bar's picker.
    renderBar(<OnboardingTopBar trail={[STEP.consent, STEP.child]} />);

    expect(languageToggle()).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
