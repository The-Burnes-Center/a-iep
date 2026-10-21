/**
 * The language menu every picker renders (LanguageMenu.tsx), against the
 * WCAG 2.2 AA failures a live audit found on the in-bar pickers:
 *
 *  - the toggle was named "Preferred Language" while it showed "ENGLISH"
 *    (2.5.3 Label in Name), or named only "ESPAÑOL", with no word for what it
 *    is (2.4.6);
 *  - every language name was read in the page's language (3.1.2);
 *  - the chosen language was a background colour and nothing else, and
 *    react-bootstrap put aria-selected on a button (axe aria-allowed-attr,
 *    critical);
 *  - a locked picker was `disabled`, which drops keyboard focus and says
 *    nothing about why.
 */
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LanguageMenu, { LanguageMenuOption } from "./LanguageMenu";

const OPTIONS: LanguageMenuOption[] = [
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
  { value: "zh", label: "中文", hint: "Not translated yet" },
  { value: "ar", label: "العربية" },
];

const renderMenu = (props: Partial<React.ComponentProps<typeof LanguageMenu>> = {}) => {
  const onSelect = vi.fn();
  const user = userEvent.setup();
  render(
    <LanguageMenu
      options={OPTIONS}
      selected="es"
      onSelect={onSelect}
      name="Language"
      testIdPrefix="picker"
      {...props}
    />,
  );
  const toggle = screen.getByTestId("picker-toggle");
  return { user, onSelect, toggle };
};

describe("the toggle's name", () => {
  test("says what the control is and contains the visible language name", () => {
    const { toggle } = renderMenu();

    expect(toggle).toHaveAccessibleName("Language: Español");
    expect(toggle).not.toHaveAttribute("aria-label");
  });

  test("is the same with the phone's icon-only button", () => {
    renderMenu({ variant: "bar" });

    expect(screen.getByRole("button", { name: "Language: Español" })).toBeInTheDocument();
  });

  test("marks the shown language name up in that language", () => {
    const { toggle } = renderMenu({ selected: "ar" });

    const name = toggle.querySelector("[lang]");
    expect(name).toHaveAttribute("lang", "ar");
    expect(name).toHaveAttribute("dir", "rtl");
  });

  test("keeps the natural spelling when shown in capitals", () => {
    // Capitals are CSS; the text a screen reader gets is the endonym.
    const { toggle } = renderMenu({ uppercase: true });

    expect(toggle).toHaveTextContent("Español");
    expect(toggle).not.toHaveTextContent("ESPAÑOL");
  });
});

describe("the menu", () => {
  test("opens from the keyboard and closes back onto the toggle", async () => {
    const { user, toggle } = renderMenu();

    toggle.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByTestId("picker-option-en")).toBeVisible();

    await user.keyboard("{Escape}");
    expect(toggle).toHaveFocus();
  });

  test("offers real buttons, each named in its own language", async () => {
    const { user, toggle } = renderMenu();
    await user.click(toggle);

    for (const option of OPTIONS) {
      const item = screen.getByTestId(`picker-option-${option.value}`);
      expect(item.tagName).toBe("BUTTON");
      expect(item).toHaveAttribute("type", "button");
      expect(item.querySelector(`[lang="${option.value}"]`)).toHaveTextContent(option.label);
    }
    expect(screen.getByTestId("picker-option-ar").querySelector("[lang]")).toHaveAttribute("dir", "rtl");
  });

  test("announces the chosen language as current, and only that one", async () => {
    const { user, toggle } = renderMenu();
    await user.click(toggle);

    expect(screen.getByTestId("picker-option-es")).toHaveAttribute("aria-current", "true");
    for (const value of ["en", "zh", "ar"]) {
      expect(screen.getByTestId(`picker-option-${value}`)).not.toHaveAttribute("aria-current");
    }
  });

  test("never puts aria-selected on an item", async () => {
    // What react-bootstrap's `active` does, and what axe rejects on a button.
    const { user, toggle } = renderMenu();
    await user.click(toggle);

    expect(document.querySelectorAll("[aria-selected]")).toHaveLength(0);
  });

  test("reads a hint with its language", async () => {
    const { user, toggle } = renderMenu();
    await user.click(toggle);

    expect(screen.getByTestId("picker-option-zh")).toHaveAccessibleName("中文 Not translated yet");
  });

  test("hands the choice to the caller", async () => {
    const { user, toggle, onSelect } = renderMenu();
    await user.click(toggle);
    await user.click(screen.getByTestId("picker-option-en"));

    expect(onSelect).toHaveBeenCalledWith("en");
  });
});

describe("when the picker cannot be used", () => {
  test("stays focusable, says why, and does not open", async () => {
    const { user, toggle } = renderMenu({ unavailableReason: "Wait for your document." });

    expect(toggle).toHaveAttribute("aria-disabled", "true");
    expect(toggle).not.toBeDisabled();
    expect(toggle).toHaveAccessibleDescription("Wait for your document.");

    toggle.focus();
    expect(toggle).toHaveFocus();
    await user.click(toggle);
    // The menu mounts only when it opens.
    expect(screen.queryByTestId("picker-option-en")).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});
