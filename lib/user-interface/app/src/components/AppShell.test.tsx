/**
 * The frame every screen renders inside.
 *
 * Three defects this replaces, all of them "the footer is per-screen":
 *
 *  - 20 components rendered `<AIEPFooter>` themselves and 8 screens rendered
 *    none, so whether a parent got a footer depended on which screen they were
 *    on. The last test here is a source scan rather than a render, because the
 *    way this comes back is somebody pasting the component into screen 21.
 *  - which four links the footer carried was decided four different ways by
 *    the caller (bare, a prop, a ternary, a props spread), off an array copied
 *    byte-identical into five files. It is now read from the session, the way
 *    LandingTopNavigation already resolves its own Upload item.
 *  - nothing in the app established a full-height layout and there was no
 *    `<main>` landmark or skip link anywhere.
 *
 * The skip link is asserted by driving the keyboard, not by checking the
 * element exists: a skip link that lands on the nav bar it was supposed to
 * skip is the whole failure mode.
 */
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import AppShell from "./AppShell";
import { LanguageContext } from "../common/language-context";
import { SIGN_IN_ROUTE } from "../common/sign-in-location";
import type { SupportedLanguage } from "../common/languages";

// AuthContext is not exported on purpose -- useAuth is the whole public
// surface -- so the hook is stubbed rather than a seam added for the test.
const authState = vi.hoisted(() => ({ current: { authenticated: false, loading: false } }));
vi.mock("../common/auth-provider", () => ({
  useAuth: () => authState.current,
}));

const languageValue = {
  language: "en" as SupportedLanguage,
  setLanguage: vi.fn(),
  // Identity t(), except for the one string this file asserts is translated
  // at all: a11y.skipToContent renders to a parent, and `translations[key] ||
  // key` would put the raw key on screen if it were ever missed.
  t: (key: string) => (key === "a11y.skipToContent" ? "Skip to content" : key),
  translationsLoaded: true,
  enabledLanguages: ["en"] as SupportedLanguage[],
};

// Hash included on purpose: the sign-in form is a card on the landing page,
// so '/' alone cannot tell "sent to the form" apart from "sent to the top of
// the marketing page".
const Here = () => {
  const { pathname, hash } = useLocation();
  return <div data-testid="landed-on">{pathname + hash}</div>;
};

/**
 * A stand-in for a real screen, shaped like the ones the app has: its own nav
 * bar first, then its content. That order is why the skip link cannot simply
 * focus `<main>`.
 */
const Screen = () => (
  <>
    <nav aria-label="Main navigation">
      <button type="button">Summary</button>
    </nav>
    <div data-testid="page-content">
      <button type="button">Something on the page</button>
    </div>
  </>
);

const renderShell = (authenticated: boolean, loading = false) => {
  authState.current = { authenticated, loading };
  render(
    <MemoryRouter initialEntries={["/start"]}>
      <LanguageContext.Provider value={languageValue}>
        {/* Outside the shell deliberately: in the app `<Routes>` is <main>'s
            only child, so the screen's own nav bar is <main>'s first element.
            A probe inside would sit in front of it and make the skip-link
            assertion below pass for the wrong reason. */}
        <Here />
        <AppShell>
          <Routes>
            <Route path="/start" element={<Screen />} />
            <Route path="*" element={<div>somewhere else</div>} />
          </Routes>
        </AppShell>
      </LanguageContext.Provider>
    </MemoryRouter>,
  );
  return userEvent.setup();
};

const footerLinkRoutes = async (authenticated: boolean, labelKey: string) => {
  const user = renderShell(authenticated);
  await user.click(screen.getByRole("button", { name: labelKey }));
  return screen.getByTestId("landed-on").textContent;
};

describe("the shell's landmarks", () => {
  test("wraps the routed screen in the app's one <main>", () => {
    renderShell(false);

    const main = screen.getByRole("main");
    expect(main).toContainElement(screen.getByTestId("page-content"));
  });

  test("renders exactly one footer, outside <main>", () => {
    renderShell(false);

    const footers = screen.getAllByRole("contentinfo");
    expect(footers).toHaveLength(1);
    // Outside, not inside: the sticky-footer layout gives <main> the free
    // space and puts everything after it on the bottom of the viewport.
    expect(screen.getByRole("main")).not.toContainElement(footers[0]);
  });
});

describe("the skip link", () => {
  test("is the first thing a keyboard reaches, and says so in the parent's language", async () => {
    const user = renderShell(false);

    await user.tab();

    expect(document.activeElement).toHaveTextContent("Skip to content");
    expect(document.activeElement).toHaveAttribute("href", "#main-content");
  });

  test("lands past the nav bar, on the page's own content", async () => {
    const user = renderShell(false);

    await user.tab();
    await user.click(document.activeElement as HTMLElement);

    // The thing that must NOT happen: focus on <main> itself, or inside the
    // nav, either of which leaves the next Tab on the first nav button --
    // exactly what the link exists to skip.
    expect(document.activeElement).toBe(screen.getByTestId("page-content"));
    expect(screen.getByRole("navigation", { name: "Main navigation" })).not.toContainElement(
      document.activeElement as HTMLElement,
    );
  });
});

describe("which footer a parent gets", () => {
  test.each([
    ["footer.home", "/"],
    // The hash matters: a bare '/' drops them several screens above the form.
    ["footer.uploadIEP", SIGN_IN_ROUTE],
    ["footer.faqs", "/faqs"],
    ["footer.aboutUs", "/about-the-project"],
  ])("a visitor's %s goes to %s", async (labelKey, route) => {
    expect(await footerLinkRoutes(false, labelKey)).toBe(route);
  });

  test.each([
    ["footer.home", "/summary-and-translations"],
    ["footer.uploadIEP", "/iep-documents"],
    ["footer.supportCenter", "/support-center"],
    ["footer.aboutUs", "/about-the-app"],
  ])("a signed-in parent's %s goes to %s", async (labelKey, route) => {
    expect(await footerLinkRoutes(true, labelKey)).toBe(route);
  });

  test("a visitor gets the partner strip and the SMS-frequency line", () => {
    renderShell(false);

    expect(screen.getByText("auth.smsFrequencyDisclaimer")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "partnerBanner.label" })).toBeInTheDocument();
  });

  test("a signed-in parent gets neither: both are for someone about to sign up", () => {
    renderShell(true);

    expect(screen.queryByText("auth.smsFrequencyDisclaimer")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "partnerBanner.label" })).toBeNull();
  });

  test("neither appears while the session check is still running", () => {
    // The default before checkAuth answers is `authenticated: false`. Acting on
    // it would pop 73px of footer in and straight back out under the route
    // guard's spinner on every page load of a protected route.
    renderShell(false, true);

    expect(screen.queryByText("auth.smsFrequencyDisclaimer")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "partnerBanner.label" })).toBeNull();
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

describe("the footer lives in one place", () => {
  test("nothing but AppShell renders AIEPFooter", () => {
    const offenders = walk(SRC)
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => !/components\/(AppShell|AIEPFooter)\.tsx$/.test(f))
      .filter((f) => /AIEPFooter/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));

    expect(
      offenders,
      "AppShell renders the footer for every screen; these render a second one:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });
});
