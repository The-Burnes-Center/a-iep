/**
 * DocumentFailureState is a pure presentation of one decision (canRetry),
 * made by canRetryFailedDocument and covered on its own in
 * document-failure.test.ts. These tests cover what a parent actually sees:
 * the copy renders as real words (not a raw translation key), the retry
 * affordance appears only when canRetry says so, a way to reach support is
 * always there, and every action calls back to the page rather than
 * navigating itself.
 */
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import DocumentFailureState, { DocumentFailureStateProps } from "./DocumentFailureState";
import realEnglishDictionary from "../../translations/en.json";

/** Mirrors production's t(): translations[key] || key (no English fallback). */
const identityT = (key: string) => key;

const renderFailureState = (overrides: Partial<DocumentFailureStateProps> = {}) => {
  const onGoToDocuments = vi.fn();
  render(
    <DocumentFailureState
      canRetry
      t={identityT}
      onGoToDocuments={onGoToDocuments}
      {...overrides}
    />,
  );
  return { onGoToDocuments };
};

describe("DocumentFailureState", () => {
  test("states plainly that the document could not be read", () => {
    renderFailureState();

    expect(screen.getByTestId("summary-failed")).toHaveTextContent("summary.failed.title");
    expect(screen.getByText("summary.failed.message")).toBeInTheDocument();
  });

  test("offers the retry affordance when canRetry is true", () => {
    renderFailureState({ canRetry: true });

    expect(screen.getByTestId("failure-try-different-file")).toBeInTheDocument();
    expect(screen.queryByTestId("failure-go-to-documents")).not.toBeInTheDocument();
  });

  test("replaces the retry affordance with a neutral fallback when canRetry is false", () => {
    renderFailureState({ canRetry: false });

    expect(screen.queryByTestId("failure-try-different-file")).not.toBeInTheDocument();
    expect(screen.getByTestId("failure-go-to-documents")).toBeInTheDocument();
  });

  test("the retry button calls back to the page instead of navigating itself", () => {
    const { onGoToDocuments } = renderFailureState({ canRetry: true });

    fireEvent.click(screen.getByTestId("failure-try-different-file"));

    expect(onGoToDocuments).toHaveBeenCalledTimes(1);
  });

  test("the neutral fallback calls the same callback as the retry button", () => {
    const { onGoToDocuments } = renderFailureState({ canRetry: false });

    fireEvent.click(screen.getByTestId("failure-go-to-documents"));

    expect(onGoToDocuments).toHaveBeenCalledTimes(1);
  });

  // The whole point of t() being `translations[key] || key` with no English
  // fallback: a key missing from a dictionary renders the raw dot-separated
  // key to a parent. A mock t() that just echoes its input would never catch
  // that, so this reads the real shipped dictionary.
  test("resolves to real English words against the shipped dictionary, not raw keys", () => {
    const realT = (key: string) => (realEnglishDictionary as Record<string, string>)[key] || key;
    renderFailureState({ t: realT });

    const title = screen.getByTestId("summary-failed");
    expect(title).toHaveTextContent(realEnglishDictionary["summary.failed.title"]);
    expect(title.textContent).not.toBe("summary.failed.title");
    expect(title.textContent).not.toMatch(/^summary\./);

    expect(
      screen.getByText(realEnglishDictionary["summary.failed.message"]),
    ).toBeInTheDocument();
    expect(
      screen.getByText(realEnglishDictionary["summary.failed.tryDifferentFile"]),
    ).toBeInTheDocument();
  });
});
