/**
 * The shared form parts of sign-in, and the bar a parent uses after it, read
 * the way a screen reader reads them: each field by its visible label, the
 * icon-only eye toggle by a name and its pressed state, and the bar's four
 * links in the language on screen rather than in English.
 */
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { LanguageContext } from "../common/language-context";
import { ALL_LANGUAGES } from "../common/languages";
import CreateAccountButton from "./CreateAccountButton";
import EmailInput from "./EmailInput";
import MobileTopNavigation from "./MobileTopNavigation";
import PasswordInput from "./PasswordInput";

/** Identity t(): assertions read the key the component chose. */
const languageValue = (t: (key: string) => string = (key) => key) => ({
  language: "en" as const,
  setLanguage: vi.fn(),
  t,
  translationsLoaded: true,
  enabledLanguages: ALL_LANGUAGES,
});

const withLanguage = (ui: React.ReactElement, t?: (key: string) => string) => (
  <LanguageContext.Provider value={languageValue(t)}>{ui}</LanguageContext.Provider>
);

describe("PasswordInput", () => {
  test("the field is named by its visible label", () => {
    render(
      withLanguage(
        <PasswordInput
          label="auth.password"
          placeholder="auth.enterPassword"
          value=""
          onChange={vi.fn()}
          showPassword={false}
          onToggleVisibility={vi.fn()}
        />,
      ),
    );
    expect(screen.getByLabelText("auth.password")).toHaveAccessibleName("auth.password");
  });

  test("the eye toggle has a name, and says whether the password is showing", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      withLanguage(
        <PasswordInput
          label="auth.password"
          placeholder="auth.enterPassword"
          value="secret"
          onChange={vi.fn()}
          showPassword={false}
          onToggleVisibility={onToggle}
        />,
      ),
    );

    const toggle = screen.getByRole("button", { name: "auth.showPassword" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      withLanguage(
        <PasswordInput
          label="auth.password"
          placeholder="auth.enterPassword"
          value="secret"
          onChange={vi.fn()}
          showPassword={true}
          onToggleVisibility={onToggle}
        />,
      ),
    );
    // The name stays put and the state moves: a name that changed with the
    // state would be announced as a new button each time.
    const shown = screen.getByRole("button", { name: "auth.showPassword" });
    expect(shown).toHaveAttribute("aria-pressed", "true");
  });
});

describe("EmailInput", () => {
  test("the field is named by its visible label, not only by its placeholder", () => {
    render(
      withLanguage(
        <EmailInput label="auth.email" placeholder="auth.enterEmail" value="" onChange={vi.fn()} />,
      ),
    );
    expect(screen.getByRole("textbox", { name: "auth.email" })).toHaveAttribute("type", "email");
  });
});

describe("CreateAccountButton", () => {
  test("is the shared primary Button, and presses through to its handler", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<CreateAccountButton onClick={onClick} buttonText="landing.greenBanner.createAccountButton" />);

    const button = screen.getByRole("button", { name: "landing.greenBanner.createAccountButton" });
    expect(button).toHaveClass("ui-button", "ui-button--primary", "create-account-button");
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("MobileTopNavigation", () => {
  // The four links' names come from one translated pattern, not from English
  // written into the component.
  const navWords: Record<string, string> = {
    "a11y.navigateTo": "Navegar a {label}",
    "navigation.summary": "Resumen",
    "navigation.support": "Ayuda",
    "navigation.rights": "Derechos",
    "navigation.account": "Cuenta",
  };

  test("each link is named in the language on screen, with its visible label", () => {
    render(
      <MemoryRouter initialEntries={["/support-center"]}>
        {withLanguage(<MobileTopNavigation />, (key) => navWords[key] ?? key)}
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "Navegar a Cuenta" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Navegar a Ayuda" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Navigate to/ })).not.toBeInTheDocument();
  });
});
