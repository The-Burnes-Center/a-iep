/**
 * What a parent sees when the poller gives up on a document that stayed in
 * processing. The poller's timing is pinned in pages/utils/polling-utility.test.ts;
 * these tests are about the screen: the message is announced once, the wait
 * stops looking like it is moving, and "try again" asks for a fresh read.
 */
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ProcessingModal from "./ProcessingModal";
import en from "../translations/en.json";

const PROCESSING_DOCUMENT = {
  status: "PROCESSING",
  progress: 40,
  current_step: "summarizing",
  updatedAt: 1700000000,
};

const SLIDES: React.ComponentProps<typeof ProcessingModal>["parentRightsSlideData"] = [
  { id: "privacy-slide-1", type: "privacy", title: "Private", content: "Kept private.", image: "/images/carousel/joyful.png" },
  { id: "rights-slide-1", type: "rights", title: "A right", content: "You have it.", image: "/images/carousel/blissful.png" },
];

const renderModal = (
  overrides: Partial<React.ComponentProps<typeof ProcessingModal>> = {},
) =>
  render(
    <ProcessingModal
      error={null}
      tutorialPhase="parent-rights"
      t={(key: string) => key}
      parentRightsSlideData={SLIDES}
      headerPinkTitle="pink"
      headerGreenTitle="green"
      rightsIndicatorTemplate="{number}. {title}"
      progressDocument={PROCESSING_DOCUMENT}
      progressStepLabel="summary.processing.step.summarizing"
      pollingStopped={false}
      onCheckAgain={vi.fn()}
      {...overrides}
    />,
  );

const liveRegion = (container: HTMLElement) =>
  container.querySelector('[aria-live="polite"]');

describe("while the document is still being polled", () => {
  test.each(["parent-rights", "completed"] as const)(
    "%s: shows the wait and no check-again control",
    (tutorialPhase) => {
      const { container } = renderModal({ tutorialPhase });

      expect(screen.getByText("summary.processing.hangTight")).toBeInTheDocument();
      expect(screen.getByRole("progressbar")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "common.tryAgain" })).toBeNull();
      expect(liveRegion(container)).toBeEmptyDOMElement();
    },
  );
});

describe("the screen's outline", () => {
  test.each(["parent-rights", "completed"] as const)(
    "%s: the headline is the one h1, and nothing else is",
    (tutorialPhase) => {
      const { container } = renderModal({ tutorialPhase });

      const headings = container.querySelectorAll("h1");
      expect(headings).toHaveLength(1);
      expect(headings[0]).toHaveTextContent("summary.processing.hangTight");
    },
  );

  test("the carousel's slides are h2, so the h1 is not repeated per slide", () => {
    const { container } = renderModal({ tutorialPhase: "parent-rights" });

    // Walk the whole deck: an h1 that only appears on some slides is how the
    // old divider cards put one on three of fifteen.
    for (let i = 0; i < SLIDES.length; i += 1) {
      expect(container.querySelectorAll("h1")).toHaveLength(1);
      expect(container.querySelectorAll(".carousel-item.active h2")).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
    }
  });

  test("a stalled wait has no headline claiming to be moving", () => {
    const { container } = renderModal({ pollingStopped: true });

    expect(container.querySelector("h1.processing-status-headline")).toBeNull();
  });
});

describe("the expectation line", () => {
  test.each(["parent-rights", "completed"] as const)(
    "%s: says what to expect, once, under the bar",
    (tutorialPhase) => {
      renderModal({ tutorialPhase });

      const line = screen.getByText("summary.processing.expectation");
      const bar = screen.getByRole("progressbar");
      expect(screen.getAllByText("summary.processing.expectation")).toHaveLength(1);
      // After the bar in reading order.
      expect(bar.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    },
  );

  test("goes away with the rest of the wait once polling has stopped", () => {
    renderModal({ pollingStopped: true });

    expect(screen.queryByText("summary.processing.expectation")).toBeNull();
  });
});

describe("the step count", () => {
  const english = (key: string) => (en as Record<string, string>)[key] ?? key;

  test("shows 'Step N of 5' beside the step, from the document's own step", () => {
    renderModal({
      t: english,
      progressDocument: { status: "PROCESSING", progress: 40, current_step: "cleanup_complete" },
      progressStepLabel: english("summary.processing.step.summarizing"),
    });

    expect(screen.getByText("Step 3 of 5")).toBeInTheDocument();
    expect(screen.getByText("Writing your plain-language summary")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuetext",
      "Step 3 of 5, Writing your plain-language summary",
    );
  });

  test("the count is the same on the final screen", () => {
    renderModal({
      t: english,
      tutorialPhase: "completed",
      progressDocument: { status: "PROCESSING", current_step: "analysis_complete" },
      progressStepLabel: english("summary.processing.step.translating"),
    });

    expect(screen.getByText("Step 4 of 5")).toBeInTheDocument();
  });
});

describe("once polling has stopped", () => {
  test.each(["parent-rights", "completed"] as const)(
    "%s: the message is announced once and the moving wait is removed",
    (tutorialPhase) => {
      const { container } = renderModal({ tutorialPhase, pollingStopped: true });

      // Announced through the live region, which is always mounted.
      expect(liveRegion(container)).toHaveTextContent("summary.processing.stalled");
      // The visible notice repeats the words but is not a second live region.
      expect(screen.getAllByText("summary.processing.stalled")).toHaveLength(2);
      // The stall is the one announcement on the status side. The carousel,
      // while it is still up, has its own live region for the current slide.
      expect(container.querySelectorAll('[aria-live]:not(.parent-rights-container *)')).toHaveLength(1);

      // Nothing on screen still claims to be moving.
      expect(screen.queryByText("summary.processing.hangTight")).toBeNull();
      expect(screen.queryByRole("progressbar")).toBeNull();
      expect(container.querySelector(".aiep-spinner")).toBeNull();
    },
  );

  test("the check-again control asks for a fresh read, once per press", () => {
    const onCheckAgain = vi.fn();
    renderModal({ pollingStopped: true, onCheckAgain });

    fireEvent.click(screen.getByRole("button", { name: "common.tryAgain" }));

    expect(onCheckAgain).toHaveBeenCalledTimes(1);
  });

  test("the control is a real button, so it can be reached and used by keyboard", () => {
    renderModal({ pollingStopped: true });

    const button = screen.getByRole("button", { name: "common.tryAgain" });
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAttribute("type", "button");
  });
});
