/**
 * The app's one navigation control.
 *
 * Every screen that offers a way back now renders this, so what it emits is
 * the whole of the app's back-navigation accessibility. Three things that were
 * wrong in all eight hand-written copies it replaced are pinned here:
 *
 *  - the <nav> label was react-bootstrap's English default in a five-language
 *    app;
 *  - a crumb was an anchor with no href and role="button", so it was not a
 *    link and could not be opened in a new tab;
 *  - nothing marked the current page.
 *
 * The behaviour a parent depends on is also here: following a crumb changes
 * route and does not leave the app.
 */
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import Breadcrumbs, { Crumb } from "./Breadcrumbs";
import { LanguageContext } from "../common/language-context";
import type { SupportedLanguage } from "../common/languages";

/** t() is the identity, so assertions read translation keys. */
const languageValue = {
  language: "en" as SupportedLanguage,
  setLanguage: vi.fn(),
  t: (key: string) => key,
  translationsLoaded: true,
  enabledLanguages: ["en"] as SupportedLanguage[],
};

const Here = () => <div data-testid="landed-on">{useLocation().pathname}</div>;

const renderTrail = (trail: Crumb[]) => {
  render(
    <MemoryRouter initialEntries={["/consent-form"]}>
      <LanguageContext.Provider value={languageValue}>
        <Here />
        <Routes>
          <Route path="/consent-form" element={<Breadcrumbs trail={trail} />} />
          <Route path="/preferred-language" element={<div>language step</div>} />
        </Routes>
      </LanguageContext.Provider>
    </MemoryRouter>,
  );
  return userEvent.setup();
};

const TWO_STEPS: Crumb[] = [
  { labelKey: "breadcrumb.language", to: "/preferred-language" },
  { labelKey: "breadcrumb.consent", to: "/consent-form" },
];

describe("the trail", () => {
  test("is a landmark a screen reader can find, labelled in the parent's language", () => {
    // react-bootstrap's default is the literal English word "breadcrumb",
    // which is what all eight hand-written copies shipped.
    renderTrail(TWO_STEPS);

    expect(screen.getByRole("navigation", { name: "breadcrumb.label" })).toBeInTheDocument();
  });

  test("renders one crumb per step, in order", () => {
    renderTrail(TWO_STEPS);

    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "breadcrumb.language",
      "breadcrumb.consent",
    ]);
  });

  test("renders nothing at all for an empty trail", () => {
    // Not an empty <nav>: a landmark with no content is noise in the
    // rotor of every screen reader that lists them.
    renderTrail([]);

    expect(screen.queryByRole("navigation")).toBeNull();
  });
});

describe("the step before this one", () => {
  test("is a real link, with the href a parent can open in a new tab", () => {
    // Was an <a> with no href and role="button". Focusable, but the browser
    // could not treat it as a destination.
    renderTrail(TWO_STEPS);

    const link = screen.getByRole("link", { name: "breadcrumb.language" });
    expect(link).toHaveAttribute("href", "/preferred-language");
  });

  test("goes to that step when it is followed, without leaving the app", async () => {
    const user = renderTrail(TWO_STEPS);

    await user.click(screen.getByRole("link", { name: "breadcrumb.language" }));

    expect(screen.getByTestId("landed-on")).toHaveTextContent("/preferred-language");
  });
});

describe("the page the parent is on", () => {
  test("is marked as the current page", () => {
    renderTrail(TWO_STEPS);

    expect(screen.getByText("breadcrumb.consent")).toHaveAttribute("aria-current", "page");
  });

  test("is not a link, so there is no crumb that goes nowhere", () => {
    renderTrail(TWO_STEPS);

    expect(screen.queryByRole("link", { name: "breadcrumb.consent" })).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  test("is the last crumb even when the caller gave it a destination", () => {
    // Screens name their own step from the shared STEP map, which carries a
    // route on every entry. The last crumb dropping its link is what lets
    // them do that without a second spelling of each step.
    renderTrail(TWO_STEPS);

    expect(screen.getByText("breadcrumb.consent").tagName).toBe("LI");
  });

  test("is the only crumb, and no link, on a one-step trail", () => {
    // The first onboarding screen: the entry behind it is the sign-in card,
    // so there is deliberately nothing to follow out of the app.
    renderTrail([{ labelKey: "breadcrumb.language", to: "/preferred-language" }]);

    expect(screen.getByText("breadcrumb.language")).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link")).toBeNull();
  });
});
