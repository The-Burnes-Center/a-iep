/**
 * What the hero card offers a parent who is already signed in.
 *
 * The defect: '/' is where the footer's Home link goes from every page, where
 * ProtectedRoute sends a signed-out parent, and where /login now redirects. A
 * parent who arrived there while still signed in was shown a sign-in form as
 * the only thing on the card, which reads as having been signed out and offers
 * no way onward. LandingTopNavigation already answers this for its own link
 * (its uploadRoute sends a signed-in parent to their documents); the hero form
 * was the last place still asking them to sign in twice.
 */
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import HeroSection from "./HeroSection";
import { LanguageContext } from "../common/language-context";
import type { SupportedLanguage } from "../common/languages";

// The sign-in form drags in Amplify, Turnstile and the API client. None of
// that is what this file is about: the question is only which of the two
// things the card renders.
vi.mock("./CustomLogin", () => ({
  default: () => <div data-testid="sign-in-form">sign in form</div>,
}));

// AuthContext is not exported, deliberately -- useAuth is the whole public
// surface. Stubbing the hook rather than exporting the context keeps the test
// off a seam that exists only for the test.
const authState = vi.hoisted(() => ({ current: { authenticated: false, loading: false } }));
vi.mock("../common/auth-provider", () => ({
  useAuth: () => authState.current,
}));

const languageValue = {
  language: "en" as SupportedLanguage,
  setLanguage: vi.fn(),
  t: (key: string) => key,
  translationsLoaded: true,
  enabledLanguages: ["en"] as SupportedLanguage[],
};

const Here = () => <div data-testid="landed-on">{useLocation().pathname}</div>;

const renderHero = (auth: { authenticated: boolean; loading: boolean }) => {
  authState.current = auth;
  render(
    <MemoryRouter initialEntries={["/"]}>
      <LanguageContext.Provider value={languageValue}>
        <Here />
        <Routes>
          <Route path="/" element={<HeroSection />} />
          <Route path="/iep-documents" element={<div>documents</div>} />
        </Routes>
      </LanguageContext.Provider>
    </MemoryRouter>,
  );
  return userEvent.setup();
};

describe("the hero card", () => {
  test("shows the sign-in form to a visitor who is not signed in", () => {
    renderHero({ authenticated: false, loading: false });

    expect(screen.getByTestId("sign-in-form")).toBeInTheDocument();
    expect(screen.queryByTestId("hero-signed-in")).toBeNull();
  });

  test("shows a signed-in parent a way onward instead of a form", () => {
    renderHero({ authenticated: true, loading: false });

    expect(screen.getByTestId("hero-signed-in")).toBeInTheDocument();
    // The thing that must NOT happen: asking someone to sign in twice.
    expect(screen.queryByTestId("sign-in-form")).toBeNull();
  });

  test("that way onward actually goes to their documents", async () => {
    const user = renderHero({ authenticated: true, loading: false });

    await user.click(screen.getByRole("button", { name: "hero.signedIn.button" }));

    expect(screen.getByTestId("landed-on")).toHaveTextContent("/iep-documents");
  });

  test("renders the form while the session check is still running", () => {
    // Deliberate: `authenticated` is false until the check resolves, so the
    // anonymous case (the overwhelming majority of landing-page visits) is
    // correct immediately and a signed-in parent sees the form only for as
    // long as a cached token read takes. Pinned so a future change to show a
    // spinner for everyone instead is a decision rather than an accident.
    renderHero({ authenticated: false, loading: true });

    expect(screen.getByTestId("sign-in-form")).toBeInTheDocument();
  });

  test("the signed-in card still carries a heading for the #sign-in focus move", () => {
    // HeroSection focuses the first heading inside the card when a parent
    // arrives at #sign-in. Without one here, focus would fall back to the
    // container and a screen reader would read the whole card at once.
    renderHero({ authenticated: true, loading: false });

    const card = screen.getByTestId("hero-signed-in");
    expect(card.querySelector("h1, h2, h3, h4, h5, h6")).not.toBeNull();
  });
});
