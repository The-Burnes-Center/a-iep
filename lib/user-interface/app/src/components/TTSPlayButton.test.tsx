/**
 * The listen control's contract, which tts.spec.ts and the summary's tests
 * depend on: it is a named button, its playback state is carried in
 * data-tts-state, and it is a whole target (at least 48px) rather than the
 * 32px circle it was. Playback itself is covered by the E2E journey.
 */
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import TTSPlayButton from "./TTSPlayButton";
import { LanguageContext } from "../common/language-context";
import type { SupportedLanguage } from "../common/languages";

const languageValue = {
  language: "en" as SupportedLanguage,
  setLanguage: vi.fn(),
  t: (key: string) => key,
  translationsLoaded: true,
  enabledLanguages: ["en"] as SupportedLanguage[],
};

const renderButton = (props: Partial<React.ComponentProps<typeof TTSPlayButton>> = {}) =>
  render(
    <LanguageContext.Provider value={languageValue}>
      <TTSPlayButton iepId="doc-1" language="en" target="summary" {...props} />
    </LanguageContext.Provider>,
  );

describe("TTSPlayButton", () => {
  test("is a button named for what it does, before anything has played", () => {
    renderButton();

    const button = screen.getByTestId("tts-play-button");
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAccessibleName("tts.listen");
    expect(button).toHaveAttribute("data-tts-state", "idle");
  });

  test("renders nothing without a document to read", () => {
    renderButton({ iepId: undefined });

    expect(screen.queryByTestId("tts-play-button")).toBeNull();
  });
});
