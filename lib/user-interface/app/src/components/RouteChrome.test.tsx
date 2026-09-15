/**
 * Which navigation bar a route gets, and whether it stays put.
 *
 * The defect: 23 screens rendered their own bar, and 15 of them had a loading
 * state that returned a spinner INSTEAD of the screen's tree — bar included.
 * A parent waiting on their profile, their language list or their summary
 * watched the navigation disappear and come back. The footer, hoisted into
 * AppShell earlier, stayed on screen throughout, so the bar was the only
 * thing that blinked.
 *
 * So these tests drive real screens in their real loading state, not a stub
 * that renders `null`: the assertion is that the bar is on screen WHILE the
 * screen has nothing to show, and that it is the same DOM node afterwards.
 * A test that only rendered the finished screen would have passed before this
 * change too.
 *
 * The last test is a source scan rather than a render, for the same reason
 * AppShell.test.tsx scans for the footer: the way this comes back is somebody
 * pasting `<MobileTopNavigation />` into screen 24.
 */
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { InAppChrome, PublicChrome } from "./RouteChrome";
import PrivacyPolicy from "../pages/PrivacyPolicy";
import ViewResources from "../pages/profile/ViewResources";
import { LanguageContext } from "../common/language-context";
import type { SupportedLanguage } from "../common/languages";

// The bars and the footer both read the session. The context's own default
// (`loading: true`) is the honest answer here and needs no provider; what it
// changes is only which four links the footer carries.
vi.mock("../common/auth-provider", () => ({
  useAuth: () => ({ authenticated: false, loading: false }),
}));

/** Identity t(), so an assertion names the key the component chose. */
const languageValue = (translationsLoaded: boolean) => ({
  language: "en" as SupportedLanguage,
  setLanguage: vi.fn(),
  t: (key: string) => key,
  translationsLoaded,
  enabledLanguages: ["en"] as SupportedLanguage[],
});

/** Both bars name themselves with this key; Breadcrumbs and the partner
 *  strip are landmarks too, so every query below is scoped by the name. */
const MAIN_NAV = { name: "a11y.mainNavigation" };

const mainNav = () => screen.getByRole("navigation", MAIN_NAV);

/**
 * The in-app block: ViewResources at /view-resources, which returns a bare
 * spinner until its dictionary is in memory. `rerender` flips that the way
 * LanguageProvider does, without unmounting the tree above it.
 */
const renderInApp = (translationsLoaded = false) => {
  const tree = (loaded: boolean) => (
    <MemoryRouter initialEntries={["/view-resources"]}>
      <LanguageContext.Provider value={languageValue(loaded)}>
        <Routes>
          <Route element={<InAppChrome />}>
            <Route path="/view-resources" element={<ViewResources />} />
            <Route path="/support-center" element={<div>support centre</div>} />
          </Route>
        </Routes>
      </LanguageContext.Provider>
    </MemoryRouter>
  );
  const { rerender } = render(tree(translationsLoaded));
  return { dictionaryArrives: () => rerender(tree(true)) };
};

/** The public block: the published privacy policy, same loading shape. */
const renderPublic = (translationsLoaded = false) => {
  render(
    <MemoryRouter initialEntries={["/public-privacy-policy"]}>
      <LanguageContext.Provider value={languageValue(translationsLoaded)}>
        <Routes>
          <Route element={<PublicChrome />}>
            <Route path="/public-privacy-policy" element={<PrivacyPolicy isPublic />} />
          </Route>
        </Routes>
      </LanguageContext.Provider>
    </MemoryRouter>,
  );
};

describe("a screen that is still loading", () => {
  test("keeps the in-app bar on screen", () => {
    renderInApp();

    // The screen itself is a spinner and nothing else.
    expect(screen.getByRole("status")).toHaveTextContent("common.loading");
    // The bar is not the screen's to drop.
    expect(mainNav()).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Navigate to navigation.account" }),
    ).toBeInTheDocument();
  });

  test("keeps the public header on screen", () => {
    renderPublic();

    expect(screen.getByRole("status")).toHaveTextContent("common.loading");
    expect(mainNav()).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Navigate to navigation.faqs" }),
    ).toBeInTheDocument();
  });

  test("does not swap the bar out and back in when the content arrives", () => {
    const { dictionaryArrives } = renderInApp();
    const before = mainNav();

    dictionaryArrives();

    // The screen re-rendered into something real -- and the bar above it is
    // the same element, never unmounted. Re-rendering a bar the screen owns
    // would give a new node here, which is the blink a parent saw.
    expect(screen.getByRole("heading", { name: "resources.title" })).toBeInTheDocument();
    expect(mainNav()).toBe(before);
  });
});

describe("which bar a block gets", () => {
  test("the in-app block gets the in-app bar, once", () => {
    renderInApp(true);

    expect(screen.getAllByRole("navigation", MAIN_NAV)).toHaveLength(1);
    for (const key of ["summary", "support", "rights", "account"]) {
      expect(
        screen.getByRole("button", { name: `Navigate to navigation.${key}` }),
      ).toBeInTheDocument();
    }
    // The public header's items are not a signed-in parent's navigation.
    expect(screen.queryByRole("button", { name: "Navigate to navigation.faqs" })).toBeNull();
  });

  test("the public block gets the public header, once", () => {
    renderPublic(true);

    expect(screen.getAllByRole("navigation", MAIN_NAV)).toHaveLength(1);
    for (const key of ["home", "uploadIEP", "faqs", "about"]) {
      expect(
        screen.getByRole("button", { name: `Navigate to navigation.${key}` }),
      ).toBeInTheDocument();
    }
    // Summary, Support, Rights and Account are all behind the sign-in.
    expect(screen.queryByRole("button", { name: "Navigate to navigation.account" })).toBeNull();
  });

  test("the bar is outside <main>, so the skip link can clear it", () => {
    renderInApp(true);

    expect(screen.getByRole("main")).not.toContainElement(mainNav());
  });
});

// ---------------------------------------------------------------------------
// The regression that a render test cannot see
// ---------------------------------------------------------------------------

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe("the nav bars live in one place", () => {
  test("nothing but RouteChrome imports a top navigation", () => {
    // The import, not the name: half the app refers to these two components
    // in comments, and none of that renders a second bar. Importing one is
    // the only way to render it.
    const importsANav = /from\s+['"][^'"]*(?:Mobile|Landing)TopNavigation['"]/;

    const offenders = walk(SRC)
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => !/components\/(RouteChrome|MobileTopNavigation|LandingTopNavigation)\.tsx$/.test(f))
      .filter((f) => importsANav.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));

    expect(
      offenders,
      "RouteChrome renders the bar for a whole block of routes; these render a second one:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });
});
