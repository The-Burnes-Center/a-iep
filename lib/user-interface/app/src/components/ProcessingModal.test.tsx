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

const PROCESSING_DOCUMENT = {
  status: "PROCESSING",
  progress: 40,
  current_step: "summarizing",
  updatedAt: 1700000000,
};

const renderModal = (
  overrides: Partial<React.ComponentProps<typeof ProcessingModal>> = {},
) =>
  render(
    <ProcessingModal
      error={null}
      tutorialPhase="parent-rights"
      t={(key: string) => key}
      parentRightsSlideData={[]}
      headerPinkTitle="pink"
      headerGreenTitle="green"
      rightsIndicatorTemplate="{number}. {title}"
      sectionHint="hint"
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

describe("once polling has stopped", () => {
  test.each(["parent-rights", "completed"] as const)(
    "%s: the message is announced once and the moving wait is removed",
    (tutorialPhase) => {
      const { container } = renderModal({ tutorialPhase, pollingStopped: true });

      // Announced through the live region, which is always mounted.
      expect(liveRegion(container)).toHaveTextContent("summary.processing.stalled");
      // The visible notice repeats the words but is not a second live region.
      expect(screen.getAllByText("summary.processing.stalled")).toHaveLength(2);
      expect(container.querySelectorAll('[aria-live]')).toHaveLength(1);

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
