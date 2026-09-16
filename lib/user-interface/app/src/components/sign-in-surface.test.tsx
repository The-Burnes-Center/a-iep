/**
 * The app has one sign-in form, and this is what has to stay true about
 * getting to it.
 *
 * There used to be two: the card in the landing page's hero, and a whole page
 * at /login rendering a second <CustomLogin/> in its own layout. Two copies of
 * a sign-in screen means two sets of copy, two Turnstile widgets and two
 * places for an auth fix to be applied to only one of them. /login is now a
 * redirect (LoginRedirect.tsx) and the hero card is the form.
 *
 * Three things have to survive that, and all three are silent when they break:
 *
 * - The URL keeps working. a-iep.org/login is in outreach material and in
 *   parents' history; it must not 404, and it must not drop them at the top of
 *   a marketing page with the form four screens below.
 * - `state.from` survives. It is how a parent who tapped a link to a page they
 *   were not signed in for gets taken back to that page afterwards, and it now
 *   has to cross a redirect to get to the form.
 * - Focus lands on the form. A scroll that leaves focus on <body> is invisible
 *   to a screen reader and starts a keyboard parent back at the page's first
 *   link, so arriving "at" the card would announce nothing at all.
 *
 * These drive the real router, the real ScrollToTop and the real HeroSection
 * (and therefore the real CustomLogin); only Amplify and `fetch` are mocked.
 */
import React, { useEffect } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import HeroSection from "./HeroSection";
import LoginRedirect from "./LoginRedirect";
import ScrollToTop from "./ScrollToTop";
import { ProtectedRoute } from "./ProtectedRoute";
import { AuthProvider } from "../common/auth-provider";
import { AppContext } from "../common/app-context";
import { LanguageContext } from "../common/language-context";
import { SIGN_IN_CARD_ID, SIGN_IN_HASH, SIGN_IN_ROUTE } from "../common/sign-in-location";
import type { SupportedLanguage } from "../common/languages";
import en from "../translations/en.json";

const Auth = vi.hoisted(() => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
  confirmSignIn: vi.fn(),
  confirmSignUp: vi.fn(),
  resendSignUpCode: vi.fn(),
  getCurrentUser: vi.fn(),
  fetchAuthSession: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("aws-amplify/auth", () => Auth);

const PROTECTED_PATH = "/summary-and-translations";

/** Where the router is, and what state it is carrying, as readable DOM. */
const LocationProbe = () => {
  const location = useLocation();
  return (
    <>
      <div data-testid="landed-on">{location.pathname + location.search + location.hash}</div>
      <div data-testid="from">
        {(location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? "none"}
      </div>
    </>
  );
};

/** Every location the router settles on, in order, hash included. */
const visitedLocations = (): { VisitLogger: React.FC; visited: string[] } => {
  const visited: string[] = [];
  const VisitLogger: React.FC = () => {
    const location = useLocation();
    const here = location.pathname + location.hash;
    useEffect(() => {
      visited.push(here);
    }, [here]);
    return null;
  };
  return { VisitLogger, visited };
};

const languageValue = {
  language: "en" as SupportedLanguage,
  setLanguage: vi.fn(),
  // The real dictionary, because one assertion below is about the card's
  // heading being the thing focus lands on, and a heading that renders its own
  // dot-key is not a heading a parent can read.
  t: (key: string) => (en as Record<string, string>)[key] || key,
  translationsLoaded: true,
  enabledLanguages: ["en"] as SupportedLanguage[],
};

const appConfig = {
  httpEndpoint: "https://api.example.test/",
  enabledFeatures: ["passwordlessAuth"],
} as never;

/**
 * The landing page, cut down to the part under test: the hero (which is what
 * actually holds the sign-in card) plus enough page above and below it that
 * "scrolled to the card" and "at the top of the page" are different outcomes.
 */
const Landing = () => (
  <>
    <div style={{ height: "2000px" }}>marketing copy</div>
    <HeroSection />
  </>
);

const renderApp = (initialEntry: string) => {
  const { VisitLogger, visited } = visitedLocations();

  const view = render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AppContext.Provider value={appConfig}>
        <LanguageContext.Provider value={languageValue}>
          <AuthProvider>
            <ScrollToTop />
            <VisitLogger />
            <LocationProbe />
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/login" element={<LoginRedirect />} />
              <Route element={<ProtectedRoute />}>
                <Route path={PROTECTED_PATH} element={<div>the summary page</div>} />
              </Route>
            </Routes>
          </AuthProvider>
        </LanguageContext.Provider>
      </AppContext.Provider>
    </MemoryRouter>,
  );

  return { ...view, visited };
};

const landedOn = () => screen.getByTestId("landed-on").textContent;

/** The card's own heading — AuthHeader's, inside the hero's <CustomLogin/>. */
const signInHeading = () => screen.getByRole("heading", { name: en["auth.signInHeader"] });

let scrollIntoView: ReturnType<typeof vi.fn>;
let scrollTo: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  Auth.getCurrentUser.mockRejectedValue(new Error("not authenticated"));
  vi.stubGlobal("fetch", vi.fn());
  // jsdom has no layout and ships neither of these: scrollIntoView does not
  // exist on Element at all, and scrollTo logs "not implemented". Stubbed, not
  // asserted on for their own sake — what each test actually claims is which
  // one of the two ran for a given arrival.
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

describe("/login, the URL that is in outreach material and in parents' history", () => {
  test("lands on the landing page's sign-in card rather than 404ing or going to the top of the page", async () => {
    const { visited } = renderApp("/login");

    await waitFor(() => expect(landedOn()).toBe(SIGN_IN_ROUTE));
    expect(signInHeading()).toBeInTheDocument();
    // One hop and it settles. A repeat here is the redirect loop.
    expect(visited).toEqual(["/login", SIGN_IN_ROUTE]);
  });

  test("leaves no history entry behind, so Back is not a trip through the redirect", async () => {
    const Back = () => {
      const navigate = useNavigate();
      return <button onClick={() => navigate(-1)}>back</button>;
    };

    render(
      <MemoryRouter initialEntries={["/faqs", "/login"]} initialIndex={1}>
        <AppContext.Provider value={appConfig}>
          <LanguageContext.Provider value={languageValue}>
            <AuthProvider>
              <LocationProbe />
              <Back />
              <Routes>
                <Route path="/" element={<div>the landing page</div>} />
                <Route path="/faqs" element={<div>the faqs page</div>} />
                <Route path="/login" element={<LoginRedirect />} />
              </Routes>
            </AuthProvider>
          </LanguageContext.Provider>
        </AppContext.Provider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(landedOn()).toBe(SIGN_IN_ROUTE));
    await userEvent.setup().click(screen.getByRole("button", { name: "back" }));

    // Without `replace` on the redirect, /login is still on the stack: Back
    // lands there, it redirects forward again, and the parent cannot get off
    // the sign-in page at all.
    await waitFor(() => expect(landedOn()).toBe("/faqs"));
  });

  test("carries ?ref= across, so a referral link through /login is still a referral", async () => {
    renderApp("/login?ref=ABC123");

    await waitFor(() => expect(landedOn()).toBe(`/?ref=ABC123${SIGN_IN_HASH}`));
  });

  test("does not let ScrollToTop yank the parent back up to the marketing copy", async () => {
    renderApp("/login");

    await waitFor(() => expect(landedOn()).toBe(SIGN_IN_ROUTE));
    // The whole point of the hash: ScrollToTop skips a location carrying one
    // (see its docblock), so the arrival scroll below is the one that runs.
    // Without it this navigation resets the offset to 0 and the parent is
    // looking at 2000px of marketing with the form somewhere below the fold.
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollIntoView).toHaveBeenCalled();
  });

  test("puts focus on the card's heading, not on the box around it", async () => {
    renderApp("/login");

    await waitFor(() => expect(signInHeading()).toHaveFocus());
    // Named, so a screen reader says something on arrival. A focused wrapper
    // <div> or an untouched <body> both "scroll" just as well and announce
    // nothing, which is the failure this is here to catch.
    expect(document.activeElement?.tagName).toMatch(/^H[1-6]$/);
    expect(document.getElementById(SIGN_IN_CARD_ID)).toContainElement(
      document.activeElement as HTMLElement,
    );
  });
});

describe("a signed-out parent opening a page that needs an account", () => {
  test("gets the sign-in card, and the page they wanted is remembered across the redirect", async () => {
    const { visited } = renderApp(PROTECTED_PATH);

    await waitFor(() => expect(landedOn()).toBe(SIGN_IN_ROUTE));
    expect(screen.queryByText("the summary page")).not.toBeInTheDocument();
    // What CustomLogin reads back after a successful sign-in to finish the
    // journey the parent started, instead of dropping them on
    // /preferred-language. It has to survive the redirect to be worth setting.
    expect(screen.getByTestId("from").textContent).toBe(PROTECTED_PATH);
    // Once. A second entry here would be the redirect loop.
    expect(visited).toEqual([PROTECTED_PATH, SIGN_IN_ROUTE]);
  });

  test("is taken to the card the same way when the protected page was reached via /login", async () => {
    // The old bookmark, now with somewhere to go back to: /login itself is
    // reached carrying `from`, and both hops have to keep it.
    render(
      <MemoryRouter initialEntries={[{ pathname: "/login", state: { from: { pathname: PROTECTED_PATH } } }]}>
        <AppContext.Provider value={appConfig}>
          <LanguageContext.Provider value={languageValue}>
            <AuthProvider>
              <LocationProbe />
              <Routes>
                <Route path="/" element={<div>the landing page</div>} />
                <Route path="/login" element={<LoginRedirect />} />
              </Routes>
            </AuthProvider>
          </LanguageContext.Provider>
        </AppContext.Provider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(landedOn()).toBe(SIGN_IN_ROUTE));
    expect(screen.getByTestId("from").textContent).toBe(PROTECTED_PATH);
  });
});

describe("arriving at the landing page without asking for the form", () => {
  test("leaves the parent at the top of the page, and does not steal focus", async () => {
    // The negative case, and the reason the hash exists rather than the hero
    // simply grabbing focus whenever it mounts: somebody who opened '/' is
    // reading the page, not signing in, and a form that yanks the viewport and
    // the screen-reader cursor on every visit is worse than no shortcut.
    renderApp("/");

    await waitFor(() => expect(landedOn()).toBe("/"));
    expect(signInHeading()).toBeInTheDocument();
    expect(signInHeading()).not.toHaveFocus();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("tapping the same sign-in link twice without leaving the page", () => {
  test("scrolls back to the card the second time too", async () => {
    // The hash is identical across the two taps, so an arrival keyed on the
    // hash alone fires once and the second tap does nothing at all. A parent
    // who read down the page and tapped "Upload An IEP" again would be looking
    // at a link that visibly does not work.
    const UploadLink = () => {
      const navigate = useNavigate();
      return <button onClick={() => navigate(SIGN_IN_ROUTE)}>upload an iep</button>;
    };

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppContext.Provider value={appConfig}>
          <LanguageContext.Provider value={languageValue}>
            <AuthProvider>
              <ScrollToTop />
              <LocationProbe />
              <UploadLink />
              <HeroSection />
            </AuthProvider>
          </LanguageContext.Provider>
        </AppContext.Provider>
      </MemoryRouter>,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "upload an iep" }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "upload an iep" }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));
    expect(landedOn()).toBe(SIGN_IN_ROUTE);
  });
});
