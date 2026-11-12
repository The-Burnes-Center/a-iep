/**
 * The rights deck moves on its own on the processing screen, and has to meet
 * WCAG 2.2.2 (pause, stop, hide) while it does.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import ParentRightsCarousel, { SlideData } from "./ParentRightsCarousel";

const SLIDES: SlideData[] = [1, 2, 3].map((n) => ({
  id: `s-${n}`,
  type: "rights",
  title: `Right ${n}`,
  content: `Content ${n}`,
  image: "/x.png",
}));
const MS = 8000;

const activeSlide = () => screen.getByTestId("carousel-active-slide").getAttribute("data-slide-id");
const wait = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const mockReducedMotion = (reduce: boolean) => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query.includes("reduce"), media: query }));
};

beforeEach(() => {
  vi.useFakeTimers();
  mockReducedMotion(false);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the rights deck on its own", () => {
  test("moves to the next slide after its time, and wraps round", async () => {
    render(<ParentRightsCarousel slides={SLIDES} autoAdvanceMs={MS} />);
    expect(activeSlide()).toBe("s-1");
    await wait(MS - 100);
    expect(activeSlide()).toBe("s-1");
    await wait(200);
    expect(activeSlide()).toBe("s-2");
    await wait(MS);
    expect(activeSlide()).toBe("s-3");
    await wait(MS);
    expect(activeSlide()).toBe("s-1");
  });

  test("holds while the pointer or keyboard focus is in the deck", async () => {
    const { container } = render(<ParentRightsCarousel slides={SLIDES} autoAdvanceMs={MS} />);
    const deck = container.querySelector(".parent-rights-container") as HTMLElement;
    fireEvent.mouseEnter(deck);
    await wait(MS * 2);
    expect(activeSlide()).toBe("s-1");
    fireEvent.mouseLeave(deck);
    await wait(MS + 10);
    expect(activeSlide()).toBe("s-2");
  });

  test("stops for good when the parent presses Pause, and starts again on Play", async () => {
    render(<ParentRightsCarousel slides={SLIDES} autoAdvanceMs={MS} />);
    const pause = screen.getByTestId("carousel-pause");
    expect(pause).toHaveAccessibleName("Pause the slides");
    fireEvent.click(pause);
    await wait(MS * 3);
    expect(activeSlide()).toBe("s-1");
    expect(pause).toHaveAccessibleName("Play the slides");
    fireEvent.click(pause);
    await wait(MS + 10);
    expect(activeSlide()).toBe("s-2");
  });

  test("does not move, and offers no Pause, for a parent who asked for reduced motion", async () => {
    mockReducedMotion(true);
    render(<ParentRightsCarousel slides={SLIDES} autoAdvanceMs={MS} />);
    await wait(MS * 2);
    expect(activeSlide()).toBe("s-1");
    expect(screen.queryByTestId("carousel-pause")).toBeNull();
  });

  test("does not announce each slide while it moves on its own, only once paused", async () => {
    const { container } = render(<ParentRightsCarousel slides={SLIDES} autoAdvanceMs={MS} />);
    const live = () => container.querySelector("[aria-atomic='true']") as HTMLElement;
    expect(live()).toHaveAttribute("aria-live", "off");
    fireEvent.click(screen.getByTestId("carousel-pause"));
    expect(live()).toHaveAttribute("aria-live", "polite");
  });

  test("without autoAdvanceMs it never moves on its own (the standalone rights page)", async () => {
    render(<ParentRightsCarousel slides={SLIDES} />);
    await wait(MS * 3);
    expect(activeSlide()).toBe("s-1");
    expect(screen.queryByTestId("carousel-pause")).toBeNull();
  });
});
