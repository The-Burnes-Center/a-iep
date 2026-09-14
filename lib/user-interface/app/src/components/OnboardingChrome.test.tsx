/**
 * The onboarding top bar: when Back is offered, and where the language
 * selector belongs.
 *
 * Two defects, both reported from the language step:
 *
 *  - Back left the app. Covered in depth by common/app-history.test.tsx; what
 *    is pinned here is that the bar actually asks that question rather than
 *    re-deriving its own answer.
 *  - The bar drew a language dropdown on the screen whose entire purpose is
 *    picking a language, so a parent was offered the same choice twice on one
 *    screen, once as a dropdown and once as the list of buttons the design
 *    asks for.
 */
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import OnboardingTopBar from "./OnboardingChrome";
import { AppHistoryDepthProvider } from "../common/app-history";
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

const Here = () => <div data-testid="landed-on">{useLocation().pathname}</div>;

/** Pushes a real entry, so the bar sees history the way a parent creates it. */
const GoDeeper = () => {
  const navigate = useNavigate();
  return <button onClick={() => navigate("/view-update-add-child")}>go deeper</button>;
};

const renderBar = (element: React.ReactElement) => {
  render(
    <MemoryRouter initialEntries={["/consent-form"]}>
      <LanguageContext.Provider value={languageValue}>
        <AppHistoryDepthProvider>
          <Here />
          <Routes>
            <Route path="/consent-form" element={<GoDeeper />} />
            <Route path="/view-update-add-child" element={element} />
            <Route path="/preferred-language" element={<div>language step</div>} />
          </Routes>
        </AppHistoryDepthProvider>
      </LanguageContext.Provider>
    </MemoryRouter>,
  );
  return userEvent.setup();
};

/** Mounts the bar directly, with nothing of ours behind it. */
const renderBarAtEntry = (element: React.ReactElement) => {
  render(
    <MemoryRouter initialEntries={["/view-update-add-child"]}>
      <LanguageContext.Provider value={languageValue}>
        <AppHistoryDepthProvider>
          <Here />
          <Routes>
            <Route path="/view-update-add-child" element={element} />
            <Route path="/preferred-language" element={<div>language step</div>} />
          </Routes>
        </AppHistoryDepthProvider>
      </LanguageContext.Provider>
    </MemoryRouter>,
  );
  return userEvent.setup();
};

const backButton = () => screen.queryByRole("button", { name: "common.back" });

/** What LanguageDropdown's toggle renders for the selected option. */
const languageToggle = () => screen.queryByRole("button", { name: "English" });

describe("the onboarding Back button", () => {
  test("is not offered when nothing of ours is behind the screen", () => {
    // The state a parent is in immediately after signing in. The old guard
    // drew a Back button here, and pressing it left the app.
    renderBarAtEntry(<OnboardingTopBar />);

    expect(backButton()).toBeNull();
  });

  test("is offered once a screen of ours is behind it", async () => {
    const user = renderBar(<OnboardingTopBar />);

    await user.click(screen.getByRole("button", { name: "go deeper" }));

    expect(backButton()).toBeInTheDocument();
  });

  test("is always offered by a screen that names its own previous step", async () => {
    // backTo does not consult the stack: the consent form is reachable as a
    // first navigation and still knows what comes before it.
    const user = renderBarAtEntry(<OnboardingTopBar backTo="/preferred-language" />);

    expect(backButton()).toBeInTheDocument();
    await user.click(backButton() as HTMLElement);

    expect(screen.getByTestId("landed-on")).toHaveTextContent("/preferred-language");
  });
});

describe("the onboarding language selector", () => {
  test("is shown by default, so every other step keeps it", () => {
    renderBarAtEntry(<OnboardingTopBar />);

    expect(languageToggle()).toBeInTheDocument();
  });

  test("is withheld on the step that is itself a language picker", () => {
    renderBarAtEntry(<OnboardingTopBar showLanguagePicker={false} />);

    expect(languageToggle()).toBeNull();
  });

  test("withholding it does not take the Back button with it", () => {
    renderBarAtEntry(
      <OnboardingTopBar backTo="/preferred-language" showLanguagePicker={false} />,
    );

    expect(backButton()).toBeInTheDocument();
    expect(languageToggle()).toBeNull();
  });
});
