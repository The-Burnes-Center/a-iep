/**
 * The boundary that stands between a render-time throw and a blank page.
 *
 * React unmounts the whole tree when a render throws and nothing catches it.
 * That is how one legacy document with a mistyped summary field turned into a
 * white screen for a parent, with a healthy 200 in the network tab. That
 * specific defect is fixed at both ends; this component is what keeps the
 * NEXT one from costing a parent the entire app.
 *
 * The assertions are deliberately about what a parent is left with: a
 * sentence, a way forward, and a route change that recovers.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import AppErrorBoundary, { ErrorBoundary } from "./ErrorBoundary";
import { LanguageContext } from "../common/language-context";
import type { SupportedLanguage } from "../common/languages";

/** Identity t(): assertions read translation KEYS, as elsewhere in the suite. */
const translate = (key: string) => key;

const Boom = (): React.ReactElement => {
  throw new Error("render exploded");
};

const Safe = () => <div>the page rendered</div>;

let consoleError: ReturnType<typeof vi.spyOn>;
const goToDocuments = vi.fn();

beforeEach(() => {
  goToDocuments.mockClear();
  // React logs the caught error itself, on top of componentDidCatch. Silenced
  // so a passing run is readable, but spied rather than stubbed so the test
  // below can prove the boundary does not swallow the failure.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe("ErrorBoundary", () => {
  test("renders its children untouched when nothing throws", () => {
    render(
      <ErrorBoundary t={translate} onGoToDocuments={goToDocuments}>
        <Safe />
      </ErrorBoundary>,
    );

    expect(screen.getByText("the page rendered")).toBeInTheDocument();
  });

  test("replaces a throwing subtree with a message and a way forward", () => {
    render(
      <ErrorBoundary t={translate} onGoToDocuments={goToDocuments}>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText("errorBoundary.title")).toBeInTheDocument();
    expect(screen.getByText("errorBoundary.message")).toBeInTheDocument();
    // Both keys already exist, so the fallback adds no sixth translation of
    // "Try Again" and no seventh of "Go to My Documents".
    expect(screen.getByRole("button", { name: "common.tryAgain" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "summary.failed.goToDocuments" }),
    ).toBeInTheDocument();
  });

  test("offers an escape that is not the URL that just threw", () => {
    // Reload re-runs the same render, so for a deterministic fault it loops.
    // The second action is the one that actually ends the failure.
    render(
      <ErrorBoundary t={translate} onGoToDocuments={goToDocuments}>
        <Boom />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: "summary.failed.goToDocuments" }));

    expect(goToDocuments).toHaveBeenCalledTimes(1);
  });

  test("reports the failure instead of swallowing it", () => {
    render(
      <ErrorBoundary t={translate} onGoToDocuments={goToDocuments}>
        <Boom />
      </ErrorBoundary>,
    );

    const reported = consoleError.mock.calls.some(
      (args) => String(args[0]).includes("Unhandled render error"),
    );
    expect(reported).toBe(true);
  });

  test("a changed resetKey clears the fallback and re-renders the children", () => {
    const { rerender } = render(
      <ErrorBoundary t={translate} resetKey="/summary" onGoToDocuments={goToDocuments}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText("errorBoundary.title")).toBeInTheDocument();

    rerender(
      <ErrorBoundary t={translate} resetKey="/account" onGoToDocuments={goToDocuments}>
        <Safe />
      </ErrorBoundary>,
    );

    expect(screen.getByText("the page rendered")).toBeInTheDocument();
    expect(screen.queryByText("errorBoundary.title")).not.toBeInTheDocument();
  });

  test("an unchanged resetKey keeps the fallback up", () => {
    const { rerender } = render(
      <ErrorBoundary t={translate} resetKey="/summary" onGoToDocuments={goToDocuments}>
        <Boom />
      </ErrorBoundary>,
    );

    rerender(
      <ErrorBoundary t={translate} resetKey="/summary" onGoToDocuments={goToDocuments}>
        <Safe />
      </ErrorBoundary>,
    );

    // Without this, any re-render of a still-broken page would flap between
    // the fallback and a second throw.
    expect(screen.getByText("errorBoundary.title")).toBeInTheDocument();
  });
});

describe("AppErrorBoundary, as the app mounts it", () => {
  const languageValue = {
    language: "en" as SupportedLanguage,
    setLanguage: vi.fn(),
    t: translate,
    translationsLoaded: true,
    enabledLanguages: ["en"] as SupportedLanguage[],
  };

  /**
   * A route change from OUTSIDE the boundary.
   *
   * This is the browser's back button, not the bottom nav: the nav is
   * mounted per page, so it sits inside the subtree the fallback replaces
   * and is gone from the screen once the boundary trips.
   */
  const BackButton = () => {
    const navigate = useNavigate();
    return <button onClick={() => navigate("/account")}>back</button>;
  };

  const renderApp = () =>
    render(
      <MemoryRouter initialEntries={["/summary"]}>
        <LanguageContext.Provider value={languageValue}>
          <BackButton />
          <AppErrorBoundary>
            <Routes>
              <Route path="/summary" element={<Boom />} />
              <Route path="/account" element={<Safe />} />
              <Route path="/iep-documents" element={<div>documents page</div>} />
            </Routes>
          </AppErrorBoundary>
        </LanguageContext.Provider>
      </MemoryRouter>,
    );

  test("a broken route shows the fallback instead of an empty page", () => {
    renderApp();

    expect(screen.getByTestId("app-error-boundary")).toBeInTheDocument();
    expect(screen.queryByText("the page rendered")).not.toBeInTheDocument();
  });

  test("going back recovers, because the pathname is the reset key", () => {
    renderApp();
    expect(screen.getByTestId("app-error-boundary")).toBeInTheDocument();

    fireEvent.click(screen.getByText("back"));

    expect(screen.getByText("the page rendered")).toBeInTheDocument();
    expect(screen.queryByTestId("app-error-boundary")).not.toBeInTheDocument();
  });

  test("the escape button lands on a real page, wired to the router", () => {
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "summary.failed.goToDocuments" }));

    // Both halves matter: the route changed AND the changed pathname reset
    // the boundary, so the parent sees the destination rather than the
    // fallback still sitting on top of it.
    expect(screen.getByText("documents page")).toBeInTheDocument();
    expect(screen.queryByTestId("app-error-boundary")).not.toBeInTheDocument();
  });
});
