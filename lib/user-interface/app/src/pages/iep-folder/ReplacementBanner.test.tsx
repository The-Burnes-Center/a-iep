/**
 * ReplacementBanner on its own: the three things a parent can be shown, the
 * real English copy behind them, and the contrast of the two colour pairs the
 * stylesheet gives them (WCAG 2.2 AA needs 4.5:1 for this text).
 */
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ReplacementBanner from "./ReplacementBanner";
import en from "../../translations/en.json";

const t = (key: string) => (en as Record<string, string>)[key] ?? key;

const renderBanner = (
  replacement: Parameters<typeof ReplacementBanner>[0]["replacement"],
  pollingStopped = false,
) => {
  const onCheckAgain = vi.fn();
  const onUploadAgain = vi.fn();
  render(
    <ReplacementBanner
      replacement={replacement}
      pollingStopped={pollingStopped}
      t={t}
      onCheckAgain={onCheckAgain}
      onUploadAgain={onUploadAgain}
    />,
  );
  return { onCheckAgain, onUploadAgain };
};

describe("ReplacementBanner", () => {
  test("processing says the current IEP stays until the new one is ready", () => {
    renderBanner({ iepId: "iep-new", status: "PROCESSING" });

    expect(screen.getByTestId("replacement-processing")).toHaveTextContent(
      "We're processing your new IEP. Your current one stays here until the new one is ready.",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("failed says the previous IEP is still here and offers the upload again", () => {
    const { onUploadAgain } = renderBanner({ iepId: "iep-new", status: "FAILED" });

    expect(screen.getByTestId("replacement-failed")).toHaveTextContent(
      "We couldn't process your new IEP. Your previous one is still here.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Upload Again" }));
    expect(onUploadAgain).toHaveBeenCalledTimes(1);
  });

  test("a stalled wait offers to check again, not to upload", () => {
    const { onCheckAgain, onUploadAgain } = renderBanner(
      { iepId: "iep-new", status: "PROCESSING" }, true);

    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    expect(onCheckAgain).toHaveBeenCalledTimes(1);
    expect(onUploadAgain).not.toHaveBeenCalled();
  });

  test("with no replacement it renders an empty polite live region", () => {
    renderBanner(undefined);

    const region = screen.getByTestId("replacement-region");
    expect(region).toBeEmptyDOMElement();
    expect(region).toHaveAttribute("role", "status");
    expect(region).toHaveAttribute("aria-live", "polite");
  });

  test("a stalled flag does not show a stall for a failed or absent replacement", () => {
    renderBanner({ iepId: "iep-new", status: "FAILED" }, true);
    expect(screen.queryByTestId("replacement-stalled")).toBeNull();
    expect(screen.getByTestId("replacement-failed")).toBeInTheDocument();
  });
});

// The palette's info and danger alert pairs, which .replacement-banner-* use
// (styles/palette.css; the palette test measures them too).
const luminance = (hex: string) => {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("ReplacementBanner colours", () => {
  test.each([
    ["processing", "#055160", "#d1ecf1"],
    ["failed", "#842029", "#f8d7da"],
  ])("%s text meets 4.5:1 on its background", (_state, text, background) => {
    expect(contrast(text, background)).toBeGreaterThanOrEqual(4.5);
  });
});
