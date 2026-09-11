/**
 * Client-side rejection of a password-protected PDF, before any upload is
 * attempted: see ../../common/pdf-encryption.ts for how detection works and
 * pdf-encryption.test.ts for its own unit coverage. This file pins the
 * WIRING into the upload form only -- that a detected file lands in the
 * same fileError state the existing format/size checks use, and that an
 * ordinary PDF is unaffected -- not the detection logic itself.
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

const encryptedPdf = () =>
  new File(
    ["%PDF-1.4\ntrailer\n<< /Size 2 /Root 1 0 R /Encrypt 3 0 R >>\nstartxref\n0\n%%EOF"],
    "report-card.pdf",
    { type: "application/pdf" },
  );

const plainPdf = () =>
  new File(
    ["%PDF-1.4\ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n0\n%%EOF"],
    "iep.pdf",
    { type: "application/pdf" },
  );

const selectFile = (file: File) => {
  // No <label> or data-testid on this input (pre-existing), so it is found
  // by id rather than through a testing-library query.
  const fileInput = document.getElementById("fileUpload") as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [file] } });
};

describe("UploadIEPDocument: password-protected PDFs", () => {
  test("a PDF carrying /Encrypt is refused with the encrypted-file message, and no file is staged", async () => {
    renderUpload();

    selectFile(encryptedPdf());

    await waitFor(() => {
      expect(screen.getByText("upload.fileError.encrypted")).toBeInTheDocument();
    });
    // Rejected: not staged for upload, and the Upload button stays disabled.
    expect(screen.queryByText("report-card.pdf")).not.toBeInTheDocument();
    expect(screen.getByTestId("upload-submit-button")).toBeDisabled();
  });

  test("an ordinary PDF is staged normally and reports no file error", async () => {
    renderUpload();

    selectFile(plainPdf());

    await waitFor(() => {
      expect(screen.getByText("iep.pdf")).toBeInTheDocument();
    });
    expect(screen.queryByText("upload.fileError.encrypted")).not.toBeInTheDocument();
    expect(screen.getByTestId("upload-submit-button")).not.toBeDisabled();
  });

  test("a non-PDF format rejection still works, unaffected by the new check", async () => {
    renderUpload();

    const badFile = new File(["not a real file"], "notes.txt", { type: "text/plain" });
    selectFile(badFile);

    await waitFor(() => {
      expect(screen.getByText("upload.fileError.format")).toBeInTheDocument();
    });
  });
});
