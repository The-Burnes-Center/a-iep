/**
 * The bar's one language spot (NavLanguageSlot.tsx): every signed-in screen
 * shows the picker there, the bar's default unless the screen claims it.
 *
 * The defect this replaced: only the screens that remembered to render a
 * picker had one (Support, Rights, Account and the summary), onboarding drew
 * its own in a different place, and the rest had none.
 */
import React, { useState } from "react";
import { describe, expect, test } from "vitest";
import { act, render, screen } from "@testing-library/react";
import {
  NavLanguageSlot,
  NavLanguageSlotProvider,
  NavLanguageSlotTarget,
} from "./NavLanguageSlot";

const Bar = () => (
  <nav aria-label="bar">
    <NavLanguageSlotTarget fallback={<button type="button">default picker</button>} />
  </nav>
);

const inBar = () => screen.getByRole("navigation", { name: "bar" });

const renderScreen = (page: React.ReactNode) =>
  render(
    <NavLanguageSlotProvider>
      <Bar />
      <main>{page}</main>
    </NavLanguageSlotProvider>,
  );

describe("the bar's language spot", () => {
  test("shows the bar's default on a screen that does nothing", () => {
    renderScreen(<p>a screen</p>);

    expect(inBar()).toContainElement(screen.getByRole("button", { name: "default picker" }));
  });

  test("shows a screen's own picker there instead, and never both", () => {
    renderScreen(
      <NavLanguageSlot>
        <button type="button">summary picker</button>
      </NavLanguageSlot>,
    );

    expect(inBar()).toContainElement(screen.getByRole("button", { name: "summary picker" }));
    expect(screen.queryByRole("button", { name: "default picker" })).toBeNull();
  });

  test("is left empty by a screen that claims it with nothing", () => {
    // The language step of onboarding: that whole screen is a language picker.
    renderScreen(<NavLanguageSlot />);

    expect(screen.queryByRole("button")).toBeNull();
  });

  test("goes back to the default when the claiming screen leaves", () => {
    function Toggle() {
      const [claimed, setClaimed] = useState(true);
      return (
        <>
          {claimed && (
            <NavLanguageSlot>
              <button type="button">summary picker</button>
            </NavLanguageSlot>
          )}
          <button type="button" onClick={() => setClaimed(false)}>
            leave
          </button>
        </>
      );
    }
    renderScreen(<Toggle />);
    act(() => screen.getByRole("button", { name: "leave" }).click());

    expect(inBar()).toContainElement(screen.getByRole("button", { name: "default picker" }));
    expect(screen.queryByRole("button", { name: "summary picker" })).toBeNull();
  });

  test("renders a screen's picker where it stands when there is no bar", () => {
    // A screen rendered bare in a test keeps its control.
    render(
      <NavLanguageSlot>
        <button type="button">summary picker</button>
      </NavLanguageSlot>,
    );

    expect(screen.getByRole("button", { name: "summary picker" })).toBeInTheDocument();
  });
});
