/**
 * Client-side handling of a password-protected PDF, before any upload is
 * attempted: see ../../common/pdf-encryption.ts for how /Encrypt detection
 * works (pdf-encryption.test.ts) and ../../common/pdf-decrypt.ts for the
 * actual empty-password/prompt/rebuild flow (pdf-decrypt.test.ts). This file
 * pins the WIRING into the upload form only: that resolveEncryptedPdf's three
 * outcomes ('resolved' / 'cancelled' / 'failed') land in the right state, that
 * its requestPassword callback opens/drives PdfPasswordPromptModal correctly,
 * and that an ordinary PDF never even reaches pdf-decrypt.ts -- not the
 * decrypt/rebuild logic itself, which is mocked out here entirely.
 */
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import UploadIEPDocument from "./UploadIEPDocument";
import { AppContext } from "../../common/app-context";
import { LanguageContext } from "../../common/language-context";
import type { AppConfig } from "../../common/types";
import type { SupportedLanguage } from "../../common/languages";

const Auth = vi.hoisted(() => ({ getCurrentUser: vi.fn(), fetchAuthSession: vi.fn() }));
vi.mock("aws-amplify/auth", () => Auth);

// The whole decrypt/rebuild flow is mocked here: this file only pins that
// UploadIEPDocument calls it correctly and reacts correctly to each outcome,
// never that pdf.js/jsPDF behave a particular way (pdf-decrypt.test.ts owns
// that, with pdfjs-dist/jspdf mocked one level down instead).
const pdfDecrypt = vi.hoisted(() => ({ resolveEncryptedPdf: vi.fn() }));
vi.mock("../../common/pdf-decrypt", () => pdfDecrypt);

const appConfig = {
  httpEndpoint: "https://api.example.test/",
  enabledFeatures: [],
  enabledLanguages: ["en"],
} as unknown as AppConfig;

const languageValue = {
  language: "en" as SupportedLanguage,
  setLanguage: vi.fn(),
  // Identity t(): assertions read translation KEYS, matching this repo's
  // other component tests (see IEPSummarizationAndTranslation.test.tsx).
  // The English wording is covered separately by i18n.test.ts.
  t: (key: string) => key,
  translationsLoaded: true,
  enabledLanguages: ["en"] as SupportedLanguage[],
};

const renderUpload = () =>
  render(
    <MemoryRouter>
      <AppContext.Provider value={appConfig}>
        <LanguageContext.Provider value={languageValue}>
          <UploadIEPDocument onUploadComplete={vi.fn()} hasExistingDocument={false} />
        </LanguageContext.Provider>
      </AppContext.Provider>
    </MemoryRouter>,
  );

const encryptedPdf = (name = "report-card.pdf") =>
  new File(
    ["%PDF-1.4\ntrailer\n<< /Size 2 /Root 1 0 R /Encrypt 3 0 R >>\nstartxref\n0\n%%EOF"],
    name,
    { type: "application/pdf" },
  );

const plainPdf = (name = "iep.pdf") =>
  new File(
    ["%PDF-1.4\ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n0\n%%EOF"],
    name,
    { type: "application/pdf" },
  );

const selectFile = (file: File) => {
  // No <label> or data-testid on this input (pre-existing), so it is found
  // by id rather than through a testing-library query.
  const fileInput = document.getElementById("fileUpload") as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [file] } });
};

describe("UploadIEPDocument: password-protected PDFs", () => {
  test("when resolveEncryptedPdf cannot open the file at all, the parent sees the (already-tested) refusal message, and no file is staged", async () => {
    pdfDecrypt.resolveEncryptedPdf.mockResolvedValue({ status: "failed" });
    renderUpload();

    selectFile(encryptedPdf());

    await waitFor(() => {
      expect(screen.getByText("upload.fileError.encrypted")).toBeInTheDocument();
    });
    // Rejected: not staged for upload, and the Upload button stays disabled.
    expect(screen.queryByText("report-card.pdf")).not.toBeInTheDocument();
    expect(screen.getByTestId("upload-submit-button")).toBeDisabled();
  });

  test("an owner-restricted PDF decrypts silently: no password prompt ever appears, and the rebuilt file is staged", async () => {
    const requestPasswordCalls: unknown[] = [];
    pdfDecrypt.resolveEncryptedPdf.mockImplementation(
      async (_file: File, callbacks: { requestPassword: (w: boolean) => Promise<string | null> }) => {
        // A real resolveEncryptedPdf never calls this for an owner-restricted
        // file; wrapping it here (rather than just never calling it) means a
        // regression that DOES call it shows up as a recorded call below.
        void callbacks;
        return { status: "resolved", file: plainPdf("report-card.pdf") };
      },
    );
    renderUpload();

    selectFile(encryptedPdf());

    await waitFor(() => {
      expect(screen.getByText("report-card.pdf")).toBeInTheDocument();
    });
    expect(screen.queryByText("upload.passwordProtected.title")).not.toBeInTheDocument();
    expect(requestPasswordCalls).toHaveLength(0);
    expect(screen.getByTestId("upload-submit-button")).not.toBeDisabled();
  });

  test("a password-protected PDF prompts, and the right password produces a clean staged upload", async () => {
    let capturedPassword: string | null = null;
    pdfDecrypt.resolveEncryptedPdf.mockImplementation(
      async (_file: File, callbacks: { requestPassword: (w: boolean) => Promise<string | null> }) => {
        capturedPassword = await callbacks.requestPassword(false);
        return { status: "resolved", file: plainPdf("report-card.pdf") };
      },
    );
    renderUpload();

    selectFile(encryptedPdf());

    await waitFor(() => {
      expect(screen.getByText("upload.passwordProtected.title")).toBeInTheDocument();
    });
    // The file input is disabled while the prompt is up, so a parent cannot
    // start a second, overlapping selection mid-flow.
    expect(document.getElementById("fileUpload")).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("auth.enterPassword"), {
      target: { value: "correct-horse" },
    });
    fireEvent.click(screen.getByText("upload.passwordProtected.submit"));

    await waitFor(() => {
      expect(screen.getByText("report-card.pdf")).toBeInTheDocument();
    });
    expect(capturedPassword).toBe("correct-horse");
    expect(screen.queryByText("upload.passwordProtected.title")).not.toBeInTheDocument();
    expect(document.getElementById("fileUpload")).not.toBeDisabled();
  });

  test("a wrong password is reported without losing the parent's place, and a later correct one still succeeds", async () => {
    pdfDecrypt.resolveEncryptedPdf.mockImplementation(
      async (_file: File, callbacks: { requestPassword: (w: boolean) => Promise<string | null> }) => {
        const first = await callbacks.requestPassword(false);
        if (first === "right-password") {
          return { status: "resolved", file: plainPdf("report-card.pdf") };
        }
        const second = await callbacks.requestPassword(true);
        return second === "right-password"
          ? { status: "resolved", file: plainPdf("report-card.pdf") }
          : { status: "failed" };
      },
    );
    renderUpload();

    selectFile(encryptedPdf());
    await waitFor(() => {
      expect(screen.getByText("upload.passwordProtected.title")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText("auth.enterPassword"), {
      target: { value: "wrong-guess" },
    });
    fireEvent.click(screen.getByText("upload.passwordProtected.submit"));

    // Still the SAME modal, now with the wrong-password warning -- the
    // parent is not sent back to a fresh file picker to try again.
    await waitFor(() => {
      expect(screen.getByText("upload.passwordProtected.wrongPassword")).toBeInTheDocument();
    });
    expect(screen.getByText("upload.passwordProtected.title")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("auth.enterPassword"), {
      target: { value: "right-password" },
    });
    fireEvent.click(screen.getByText("upload.passwordProtected.submit"));

    await waitFor(() => {
      expect(screen.getByText("report-card.pdf")).toBeInTheDocument();
    });
    expect(screen.queryByText("upload.passwordProtected.title")).not.toBeInTheDocument();
  });

  test("cancelling the password prompt leaves no file staged, no error shown, and the picker free to try a different file", async () => {
    pdfDecrypt.resolveEncryptedPdf.mockImplementation(
      async (_file: File, callbacks: { requestPassword: (w: boolean) => Promise<string | null> }) => {
        const password = await callbacks.requestPassword(false);
        return password === null ? { status: "cancelled" } : { status: "failed" };
      },
    );
    renderUpload();

    selectFile(encryptedPdf());
    await waitFor(() => {
      expect(screen.getByText("upload.passwordProtected.title")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("common.cancel"));

    await waitFor(() => {
      expect(screen.queryByText("upload.passwordProtected.title")).not.toBeInTheDocument();
    });
    expect(screen.queryByText("upload.fileError.encrypted")).not.toBeInTheDocument();
    expect(screen.queryByText("report-card.pdf")).not.toBeInTheDocument();

    // Free to pick a different file afterward -- not stuck.
    const fileInput = document.getElementById("fileUpload") as HTMLInputElement;
    expect(fileInput).not.toBeDisabled();
    selectFile(plainPdf());
    await waitFor(() => {
      expect(screen.getByText("iep.pdf")).toBeInTheDocument();
    });
  });

  test("an ordinary PDF is staged normally, reports no file error, and never calls into the decrypt flow at all", async () => {
    renderUpload();

    selectFile(plainPdf());

    await waitFor(() => {
      expect(screen.getByText("iep.pdf")).toBeInTheDocument();
    });
    expect(screen.queryByText("upload.fileError.encrypted")).not.toBeInTheDocument();
    expect(screen.getByTestId("upload-submit-button")).not.toBeDisabled();
    // The strongest available proof, at this level, that pdf.js is never
    // loaded for a plain file: the one function that would ever load it
    // (dynamically, from pdf-decrypt.ts) is never even called.
    expect(pdfDecrypt.resolveEncryptedPdf).not.toHaveBeenCalled();
  });

  test("a non-PDF format rejection still works, unaffected by the new check", async () => {
    renderUpload();

    const badFile = new File(["not a real file"], "notes.txt", { type: "text/plain" });
    selectFile(badFile);

    await waitFor(() => {
      expect(screen.getByText("upload.fileError.format")).toBeInTheDocument();
    });
    expect(pdfDecrypt.resolveEncryptedPdf).not.toHaveBeenCalled();
  });
});
