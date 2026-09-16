/**
 * Presentational tests only: this component knows nothing about pdf.js or
 * pdf-decrypt.ts (see its own file header). What matters here is that it
 * reports back exactly what the parent typed or that they cancelled, that a
 * wrong-password retry does not require re-mounting the modal, and that the
 * password field is cleared promptly rather than left sitting in state --
 * see UploadIEPDocument.test.tsx and pdf-decrypt.test.ts for the actual
 * decrypt flow this drives.
 */
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import PdfPasswordPromptModal from "./PdfPasswordPromptModal";
import { LanguageContext } from "../common/language-context";
import type { SupportedLanguage } from "../common/languages";

const languageValue = {
  language: "en" as SupportedLanguage,
  setLanguage: vi.fn(),
  t: (key: string) => key, // identity t(): assertions read translation keys, matching this repo's other component tests
  translationsLoaded: true,
  enabledLanguages: ["en"] as SupportedLanguage[],
};

const renderModal = (props: Partial<React.ComponentProps<typeof PdfPasswordPromptModal>> = {}) =>
  render(
    <LanguageContext.Provider value={languageValue}>
      <PdfPasswordPromptModal
        show={true}
        wrongPassword={false}
        checking={false}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        {...props}
      />
    </LanguageContext.Provider>,
  );

describe("PdfPasswordPromptModal", () => {
  test("shows nothing when not asked to", () => {
    renderModal({ show: false });
    expect(screen.queryByText("upload.passwordProtected.title")).not.toBeInTheDocument();
  });

  test("the first prompt for a file shows no wrong-password warning", () => {
    renderModal({ wrongPassword: false });
    expect(screen.getByText("upload.passwordProtected.title")).toBeInTheDocument();
    expect(screen.getByText("upload.passwordProtected.explanation")).toBeInTheDocument();
    expect(screen.queryByText("upload.passwordProtected.wrongPassword")).not.toBeInTheDocument();
  });

  test("a retry shows the wrong-password warning, in the same modal", () => {
    renderModal({ wrongPassword: true });
    expect(screen.getByText("upload.passwordProtected.title")).toBeInTheDocument();
    expect(screen.getByText("upload.passwordProtected.wrongPassword")).toBeInTheDocument();
  });

  test("submit is disabled until something is typed", () => {
    renderModal();
    expect(screen.getByText("upload.passwordProtected.submit")).toBeDisabled();
  });

  test("typing a password and submitting reports it, then clears the field", () => {
    const onSubmit = vi.fn();
    renderModal({ onSubmit });

    const field = screen.getByPlaceholderText("auth.enterPassword") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "correct-horse" } });
    fireEvent.click(screen.getByText("upload.passwordProtected.submit"));

    expect(onSubmit).toHaveBeenCalledWith("correct-horse");
    expect(field.value).toBe(""); // held as briefly as possible: cleared right after submit
  });

  test("cancelling reports it and clears whatever had been typed", () => {
    const onCancel = vi.fn();
    renderModal({ onCancel });

    const field = screen.getByPlaceholderText("auth.enterPassword") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "a-guess-typed-then-abandoned" } });
    fireEvent.click(screen.getByText("common.cancel"));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(field.value).toBe("");
  });

  test("while checking, the form is disabled and shows an unlocking state instead of submit/cancel labels", () => {
    renderModal({ checking: true });
    expect(screen.getByText("common.cancel")).toBeDisabled();
    expect(screen.getByText("upload.passwordProtected.unlocking")).toBeInTheDocument();
    expect(screen.queryByText("upload.passwordProtected.submit")).not.toBeInTheDocument();
  });

  test("the password field is never rendered as anything but a masked input", () => {
    renderModal();
    const field = screen.getByPlaceholderText("auth.enterPassword") as HTMLInputElement;
    expect(field.type).toBe("password");
    // Not an account credential: must not be offered to the browser's saved-password store.
    expect(field.autocomplete).toBe("off");
  });
});
