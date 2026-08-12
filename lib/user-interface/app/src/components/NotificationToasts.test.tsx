/**
 * The notification queue existed since 2024 but was never rendered: its only
 * mount lived in a layout component nothing routed imported, so every
 * addNotification call in the profile flow and on the summary page went into a
 * context default whose addNotification was `() => ''`. These tests pin the
 * renderer that finally shows them, and the parts of it a parent depends on:
 * that the message appears at all, that it can be got rid of, that a success
 * confirmation goes away by itself while a failure does not, and that a screen
 * reader is interrupted for the failure and not for the confirmation.
 *
 * Nothing is mocked here except the clock. The provider, the toast markup and
 * the Bootstrap classes are the real ones.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { LanguageContext } from "../common/language-context";
import type { SupportedLanguage } from "../common/languages";
import { NotificationProvider, useNotifications } from "./notif-manager";
import NotificationToasts from "./NotificationToasts";

/** Must match SUCCESS_AUTO_DISMISS_MS in NotificationToasts.tsx. */
const SUCCESS_AUTO_DISMISS_MS = 8000;

const SUCCESS_TEXT = "Your translation is ready";
const ERROR_TEXT = "Saving failed";

/** The key the dismiss control is labelled with; t() is the identity below. */
const DISMISS_KEY = "notifications.dismiss";

/** Raises notifications the way a page does: from an event handler. */
const Raiser = () => {
  const { addNotification } = useNotifications();
  return (
    <>
      <button onClick={() => addNotification("success", SUCCESS_TEXT)}>raise success</button>
      <button onClick={() => addNotification("error", ERROR_TEXT)}>raise error</button>
    </>
  );
};

const renderToasts = () => {
  render(
    <NotificationProvider>
      <NotificationToasts />
      <Raiser />
    </NotificationProvider>,
  );
};

const raiseSuccess = () => fireEvent.click(screen.getByText("raise success"));
const raiseError = () => fireEvent.click(screen.getByText("raise error"));

/** Let the auto-dismiss timer fire and React flush the resulting unmount. */
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const toastContainer = () => document.querySelector(".toast-container");

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("rendering the queue", () => {
  test("a notification raised from a page becomes a visible toast", () => {
    renderToasts();
    // The whole point: before this component existed the call was swallowed.
    expect(screen.queryByText(SUCCESS_TEXT)).not.toBeInTheDocument();

    raiseSuccess();

    expect(screen.getByText(SUCCESS_TEXT)).toBeInTheDocument();
  });

  test("several notifications queue up rather than replacing each other", () => {
    renderToasts();

    raiseSuccess();
    raiseError();

    expect(screen.getByText(SUCCESS_TEXT)).toBeInTheDocument();
    expect(screen.getByText(ERROR_TEXT)).toBeInTheDocument();
  });

  test("the container is a stable node even with nothing to show", () => {
    // A live region has to be in the document before content lands in it.
    renderToasts();
    expect(toastContainer()).not.toBeNull();
  });
});

describe("dismissing", () => {
  test("the close control removes the toast it belongs to", () => {
    renderToasts();
    raiseSuccess();
    raiseError();

    const errorToast = screen.getByTestId("notification-error");
    fireEvent.click(within(errorToast).getByRole("button", { name: DISMISS_KEY }));

    expect(screen.queryByText(ERROR_TEXT)).not.toBeInTheDocument();
    // The other one is untouched: dismissing is per notification, not a purge.
    expect(screen.getByText(SUCCESS_TEXT)).toBeInTheDocument();
  });

  test("the close control is labelled from the dictionary, not hardcoded", () => {
    const languageValue = {
      language: "es" as SupportedLanguage,
      setLanguage: vi.fn(),
      t: (key: string) => (key === DISMISS_KEY ? "Descartar notificación" : key),
      translationsLoaded: true,
      enabledLanguages: ["en", "es"] as SupportedLanguage[],
    };

    render(
      <LanguageContext.Provider value={languageValue}>
        <NotificationProvider>
          <NotificationToasts />
          <Raiser />
        </NotificationProvider>
      </LanguageContext.Provider>,
    );
    raiseSuccess();

    expect(
      screen.getByRole("button", { name: "Descartar notificación" }),
    ).toBeInTheDocument();
  });
});

describe("how long a toast stays", () => {
  test("a success confirmation clears itself", async () => {
    renderToasts();
    raiseSuccess();

    // Still there a moment before the deadline, so the assertion below is
    // about the timeout and not about the toast never rendering.
    await advance(SUCCESS_AUTO_DISMISS_MS - 1000);
    expect(screen.getByText(SUCCESS_TEXT)).toBeInTheDocument();

    await advance(1000);
    expect(screen.queryByText(SUCCESS_TEXT)).not.toBeInTheDocument();
  });

  test("an error stays until the parent dismisses it", async () => {
    renderToasts();
    raiseError();

    // Far past any success timeout. A failure that vanished on its own would
    // leave a parent with no record of what went wrong.
    await advance(SUCCESS_AUTO_DISMISS_MS * 10);

    expect(screen.getByText(ERROR_TEXT)).toBeInTheDocument();
  });

  test("a later notification does not restart the timer of an earlier one", async () => {
    renderToasts();
    raiseSuccess();

    await advance(SUCCESS_AUTO_DISMISS_MS - 1000);
    raiseError();
    await advance(1000);

    expect(screen.queryByText(SUCCESS_TEXT)).not.toBeInTheDocument();
  });
});

describe("what a screen reader is told", () => {
  test("a success confirmation is announced politely", () => {
    renderToasts();
    raiseSuccess();

    const toast = screen.getByTestId("notification-success");
    // Assertive would cut the reader off mid-sentence to say "saved".
    expect(toast).toHaveAttribute("role", "status");
    expect(toast).toHaveAttribute("aria-live", "polite");
    expect(toast).toHaveAttribute("aria-atomic", "true");
  });

  test("a failure interrupts", () => {
    renderToasts();
    raiseError();

    const toast = screen.getByTestId("notification-error");
    expect(toast).toHaveAttribute("role", "alert");
    expect(toast).toHaveAttribute("aria-live", "assertive");
  });
});

describe("placement", () => {
  test("uses direction-relative utilities, so Arabic is not mirrored wrong", () => {
    // common/direction.ts swaps the whole Bootstrap stylesheet for the RTL
    // build, which mirrors start-*/translate-middle-x. A `left`/`right` class
    // or an inline offset would survive that swap and pin the toast to the
    // same physical side in both directions.
    renderToasts();
    const classes = (toastContainer() as HTMLElement).className.split(/\s+/);

    expect(classes).toEqual(
      expect.arrayContaining([
        "toast-container",
        "position-fixed",
        "bottom-0",
        "start-50",
        "translate-middle-x",
      ]),
    );
    expect(classes).not.toContain("start-0");
    expect(classes).not.toContain("end-0");
    expect(toastContainer()).not.toHaveAttribute("style");
  });
});
