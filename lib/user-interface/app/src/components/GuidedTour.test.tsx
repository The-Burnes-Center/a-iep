/**
 * The guided tour's dialog behaviour, with the page it points at stubbed out:
 * a few plain elements whose boxes the test controls.
 *
 * jsdom has no layout, so every element reports an empty box unless a test
 * sets one (see `boxes`). What is pinned here is the part that has to work
 * for a keyboard or screen reader user, since nothing else would notice it
 * breaking: the dialog's name and description, where focus goes and stays,
 * how it closes, and that it follows the page when the page moves.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GuidedTour, { TourCloseReason, TourStep } from "./GuidedTour";
import { HIGHLIGHT_PADDING } from "./guided-tour-layout";

const labels = {
  back: "Back",
  next: "Next",
  done: "Done",
  skip: "Skip",
  stepOf: (number: number, total: number) => `Step ${number} of ${total}`,
};

const box = (top: number, left: number, width: number, height: number) => ({
  top,
  left,
  width,
  height,
  right: left + width,
  bottom: top + height,
  x: left,
  y: top,
  toJSON: () => ({}),
});

/** The box each `data-box` element reports; anything else reports an empty one. */
let boxes: Record<string, ReturnType<typeof box>>;
let rectSpy: ReturnType<typeof vi.spyOn>;

const byAttribute = (name: string) => () =>
  Array.from(document.querySelectorAll(`[data-box="${name}"]`));

const makeSteps = (
  names: string[],
  extra: Partial<Record<string, Partial<TourStep>>> = {},
): TourStep[] =>
  names.map((name) => ({
    id: name,
    title: `Title ${name}`,
    text: `Text ${name}`,
    getTargets: byAttribute(name),
    ...extra[name],
  }));

const Page: React.FC<{ names: string[] }> = ({ names }) => (
  <div>
    <button type="button">Opener</button>
    <h1 data-testid="heading">Heading</h1>
    {names.map((name) => (
      <div key={name} data-box={name}>
        target {name}
      </div>
    ))}
  </div>
);

interface Options {
  names?: string[];
  steps?: TourStep[];
  dir?: "ltr" | "rtl";
  fallbackFocus?: () => HTMLElement | null;
}

const renderTour = ({ names = ["a", "b", "c"], steps, dir = "ltr", fallbackFocus }: Options = {}) => {
  const onClose = vi.fn<(reason: TourCloseReason) => void>();
  const ui = (
    <>
      <Page names={names} />
      <GuidedTour
        steps={steps ?? makeSteps(names)}
        heading="Where to find things"
        dir={dir}
        lang={dir === "rtl" ? "ar" : "en"}
        labels={labels}
        onClose={onClose}
        fallbackFocus={fallbackFocus}
      />
    </>
  );
  const view = render(ui);
  return { onClose, view, ui };
};

const dialog = () => screen.getByRole("dialog");

beforeEach(() => {
  boxes = {
    a: box(100, 24, 200, 80),
    b: box(300, 24, 200, 80),
    c: box(500, 24, 200, 80),
  };
  rectSpy = vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Element) {
      return (boxes[this.getAttribute("data-box") ?? ""] ?? box(0, 0, 0, 0)) as DOMRect;
    });
});

afterEach(() => {
  rectSpy.mockRestore();
  vi.restoreAllMocks();
});

describe("the dialog", () => {
  test("is a modal named by the step's title and described by its text", () => {
    renderTour();

    expect(dialog()).toHaveAttribute("aria-modal", "true");
    expect(dialog()).toHaveAccessibleName("Title a");
    expect(dialog()).toHaveAccessibleDescription("Text a");
  });

  test("shows the heading, and which step of how many", () => {
    renderTour();

    expect(screen.getByText("Where to find things")).toBeInTheDocument();
    expect(screen.getByTestId("guided-tour-step")).toHaveTextContent("Step 1 of 3");
  });

  test("takes focus when it opens", () => {
    renderTour();

    expect(dialog()).toHaveFocus();
  });

  test("is a new dialog, with focus, on every step", async () => {
    renderTour();

    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(dialog()).toHaveAccessibleName("Title b");
    expect(dialog()).toHaveAccessibleDescription("Text b");
    expect(dialog()).toHaveFocus();
    // One dialog at a time, so a screen reader is not left with the old one.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });
});

describe("moving between steps", () => {
  test("Next and Back walk the steps in order", async () => {
    renderTour();

    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(dialog()).toHaveAccessibleName("Title b");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(dialog()).toHaveAccessibleName("Title c");
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(dialog()).toHaveAccessibleName("Title b");
    expect(screen.getByTestId("guided-tour-step")).toHaveTextContent("Step 2 of 3");
  });

  test("has no Back on the first step, and Done instead of Next on the last", async () => {
    renderTour();

    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    // Done already ends it; a second way out beside it is noise.
    expect(screen.queryByRole("button", { name: "Skip" })).not.toBeInTheDocument();
  });

  test("skips a step whose target is not on the page, and counts without it", async () => {
    renderTour({ names: ["a", "c"], steps: makeSteps(["a", "b", "c"]) });

    expect(screen.getByTestId("guided-tour-step")).toHaveTextContent("Step 1 of 2");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(dialog()).toHaveAccessibleName("Title c");
    expect(screen.getByTestId("guided-tour-step")).toHaveTextContent("Step 2 of 2");
  });

  test("opens on the first step that has a target", () => {
    renderTour({ names: ["b", "c"], steps: makeSteps(["a", "b", "c"]) });

    expect(dialog()).toHaveAccessibleName("Title b");
  });

  test("ends without an answer when no step has a target", () => {
    const { onClose } = renderTour({ names: [], steps: makeSteps(["a", "b"]) });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledExactlyOnceWith("aborted");
  });

  test("carries on from the next step when the current target goes away", async () => {
    const { view, ui } = renderTour();
    expect(dialog()).toHaveAccessibleName("Title a");

    // The page re-renders without a's element (a tab swapped under the tour).
    view.rerender(
      <>
        <Page names={["b", "c"]} />
        {ui.props.children[1]}
      </>,
    );

    await waitFor(() => expect(dialog()).toHaveAccessibleName("Title b"));
    expect(screen.getByTestId("guided-tour-step")).toHaveTextContent("Step 1 of 2");
  });

  test("runs a step's prepare when that step opens, and not before", async () => {
    const prepare = vi.fn();
    renderTour({ steps: makeSteps(["a", "b", "c"], { b: { prepare } }) });
    expect(prepare).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(prepare).toHaveBeenCalledTimes(1);
  });
});

describe("focus", () => {
  const tab = (shift = false) => userEvent.tab({ shift });

  test("Tab cycles Back, Next and Skip, and wraps", async () => {
    renderTour();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    const back = screen.getByRole("button", { name: "Back" });
    const next = screen.getByRole("button", { name: "Next" });
    const skip = screen.getByRole("button", { name: "Skip" });

    await tab();
    expect(back).toHaveFocus();
    await tab();
    expect(next).toHaveFocus();
    await tab();
    expect(skip).toHaveFocus();
    await tab();
    expect(back).toHaveFocus();
  });

  test("Shift+Tab wraps backwards from the first button, and from the card itself", async () => {
    renderTour();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    const skip = screen.getByRole("button", { name: "Skip" });

    // From the card (focused when the step opened).
    await tab(true);
    expect(skip).toHaveFocus();
    // From the first button.
    await tab();
    expect(screen.getByRole("button", { name: "Back" })).toHaveFocus();
    await tab(true);
    expect(skip).toHaveFocus();
  });

  test("keeps focus in the card when it lands outside", () => {
    renderTour();

    act(() => screen.getByRole("button", { name: "Opener", hidden: true }).focus());

    expect(dialog()).toHaveFocus();
  });

  test.each([
    ["Done", "done"],
    ["Skip", "skip"],
  ] as const)("returns focus to what had it before when %s closes it", async (label, reason) => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { onClose } = renderTour();
    // The tour took it, and Done is only on the last step.
    if (label === "Done") {
      await userEvent.click(screen.getByRole("button", { name: "Next" }));
      await userEvent.click(screen.getByRole("button", { name: "Next" }));
    }

    await userEvent.click(screen.getByRole("button", { name: label }));

    expect(onClose).toHaveBeenCalledExactlyOnceWith(reason);
    expect(opener).toHaveFocus();
    opener.remove();
  });

  test("returns focus to the fallback when nothing had it", async () => {
    const { onClose } = renderTour({
      fallbackFocus: () => screen.getByTestId("heading"),
    });

    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledExactlyOnceWith("escape");
    expect(screen.getByTestId("heading")).toHaveFocus();
  });
});

describe("closing", () => {
  test("Escape closes it, counted as skipped, once", async () => {
    const { onClose } = renderTour();

    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledExactlyOnceWith("escape");
  });

  test("Escape works wherever focus is", async () => {
    const { onClose } = renderTour();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    screen.getByRole("button", { name: "Skip" }).focus();

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(onClose).toHaveBeenCalledExactlyOnceWith("escape");
  });
});

describe("the dim and the cut-out", () => {
  test("clicking the dim does nothing: it neither closes nor advances", async () => {
    const { onClose } = renderTour();
    const shield = document.querySelector(".guided-tour-shield") as HTMLElement;

    await userEvent.click(shield);

    expect(onClose).not.toHaveBeenCalled();
    expect(dialog()).toHaveAccessibleName("Title a");
  });

  test("a click over the highlighted target lands on the shield, not the page", () => {
    renderTour();
    const host = document.querySelector(".guided-tour") as HTMLElement;
    const shield = host.querySelector(".guided-tour-shield") as HTMLElement;
    const highlight = host.querySelector(".guided-tour-highlight") as HTMLElement;

    // jsdom cannot hit-test, so pin what decides it: the shield is a full
    // viewport layer that takes pointer events, the highlight is not one,
    // and the shield paints under the highlight and card (document order).
    expect(shield.className).toBe("guided-tour-shield");
    expect(highlight.compareDocumentPosition(shield) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(host.children[0]).toBe(shield);
  });
});

describe("placement", () => {
  test("cuts out the target with padding and puts the card below it", () => {
    renderTour();

    const highlight = screen.getByTestId("guided-tour-highlight");
    expect(highlight.style.top).toBe(`${100 - HIGHLIGHT_PADDING}px`);
    expect(highlight.style.left).toBe(`${24 - HIGHLIGHT_PADDING}px`);
    expect(highlight.style.width).toBe(`${200 + 2 * HIGHLIGHT_PADDING}px`);
    expect(parseFloat(dialog().style.top)).toBeGreaterThan(100 + 80);
  });

  test("hangs from the target's right edge in right-to-left", () => {
    boxes.a = box(100, 300, 200, 80);
    renderTour({ dir: "rtl" });

    const left = parseFloat(dialog().style.left);
    const width = parseFloat(dialog().style.width);
    expect(left + width).toBe(500 + HIGHLIGHT_PADDING);
    expect(document.querySelector(".guided-tour")).toHaveAttribute("dir", "rtl");
  });

  test("follows the target when the window resizes", async () => {
    renderTour();
    expect(screen.getByTestId("guided-tour-highlight").style.top).toBe(`${100 - HIGHLIGHT_PADDING}px`);

    boxes.a = box(160, 24, 200, 120);
    fireEvent(window, new Event("resize"));

    await waitFor(() =>
      expect(screen.getByTestId("guided-tour-highlight").style.top).toBe(`${160 - HIGHLIGHT_PADDING}px`),
    );
    expect(screen.getByTestId("guided-tour-highlight").style.height).toBe(`${120 + 2 * HIGHLIGHT_PADDING}px`);
  });

  test("follows the target when the page scrolls", async () => {
    renderTour();

    boxes.a = box(40, 24, 200, 80);
    fireEvent.scroll(window);

    await waitFor(() =>
      expect(screen.getByTestId("guided-tour-highlight").style.top).toBe(`${40 - HIGHLIGHT_PADDING}px`),
    );
  });
});

describe("scrolling the target into view", () => {
  const offScreen = () => {
    boxes.a = box(2000, 24, 200, 80);
  };

  const mockReducedMotion = (reduced: boolean) => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) => ({ matches: reduced, media: query }) as MediaQueryList,
    );
  };

  test("scrolls smoothly by default", () => {
    const scrollBy = vi.spyOn(window, "scrollBy");
    mockReducedMotion(false);
    offScreen();
    renderTour();

    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
  });

  test("jumps instead when the parent prefers reduced motion", () => {
    const scrollBy = vi.spyOn(window, "scrollBy");
    mockReducedMotion(true);
    offScreen();
    renderTour();

    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
    expect(scrollBy).not.toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
  });

  test("leaves the page alone when the target is already on screen with room for the card", () => {
    const scrollBy = vi.spyOn(window, "scrollBy");
    renderTour();

    expect(scrollBy).not.toHaveBeenCalled();
  });
});
