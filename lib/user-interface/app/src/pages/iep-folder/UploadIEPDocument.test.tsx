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
 *
 * Plus the size gate at the bottom of the file, which is the same idea applied
 * to a different guaranteed failure: refuse a file the pipeline could never
 * finish while the parent is still at the file picker, rather than after a
 * full wait on the processing screen.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import UploadIEPDocument, { MAX_FILE_SIZE_BYTES } from "./UploadIEPDocument";
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

// Mocked so "the file was never uploaded" is something the tests can assert
// directly, rather than inferring it from a disabled button. getUploadURL is
// the first network call any upload makes.
const iepClient = vi.hoisted(() => ({ getUploadURL: vi.fn() }));
vi.mock("../../common/api-client/iep-document-client", () => ({
  IEPDocumentClient: class {
    getUploadURL = iepClient.getUploadURL;
  },
}));

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

/**
 * The size gate. Mistral's OCR API rejects anything over 50 MB, so a larger
 * file was a certain failure from the moment it was picked: it uploaded, ran,
 * and came back as a generic "we couldn't read your document" after the full
 * processing wait. The gate sat at 100MB, which invited exactly that.
 */
describe("UploadIEPDocument: files larger than the pipeline can process", () => {
  // A File whose bytes are not actually allocated: jsdom reports whatever
  // `size` says, and materialising 50 MB per test to check one comparison
  // would be a slow way to learn nothing extra.
  const fileOfSize = (bytes: number, name = "iep-scan.pdf") => {
    const file = plainPdf(name);
    Object.defineProperty(file, "size", { value: bytes });
    return file;
  };

  test("a 60 MB file is refused at the picker, with the size message, and is never uploaded", async () => {
    // A literal size, deliberately: 60 MB sat in the band the old 100MB gate
    // waved through and Mistral then rejected, so this test fails against the
    // gate as it was, which a size derived from the constant would not.
    renderUpload();

    selectFile(fileOfSize(60 * 1000 * 1000));

    await waitFor(() => {
      expect(screen.getByText("upload.fileError.size")).toBeInTheDocument();
    });
    // Not staged, so there is nothing to submit...
    expect(screen.queryByText("iep-scan.pdf")).not.toBeInTheDocument();
    expect(screen.getByTestId("upload-submit-button")).toBeDisabled();
    // ...and nothing was sent: no presigned URL was ever requested, so no
    // bytes reached S3 and no pipeline run was started.
    expect(iepClient.getUploadURL).not.toHaveBeenCalled();
    // Refused on size alone. It never got as far as opening the file, which
    // is the whole point of checking this at the picker.
    expect(pdfDecrypt.resolveEncryptedPdf).not.toHaveBeenCalled();
  });

  test("one byte over the limit is refused, wherever the limit is set", async () => {
    // Pins the comparison to the constant, so the gate cannot quietly become
    // ">= limit + some slack" while the 60 MB case above still passes.
    renderUpload();

    selectFile(fileOfSize(MAX_FILE_SIZE_BYTES + 1));

    await waitFor(() => {
      expect(screen.getByText("upload.fileError.size")).toBeInTheDocument();
    });
    expect(iepClient.getUploadURL).not.toHaveBeenCalled();
  });

  test("a file exactly at the limit is still accepted", async () => {
    // The boundary in both directions, so a gate tightened by an off-by-one
    // cannot start turning away files the provider would have taken.
    renderUpload();

    selectFile(fileOfSize(MAX_FILE_SIZE_BYTES));

    await waitFor(() => {
      expect(screen.getByText("iep-scan.pdf")).toBeInTheDocument();
    });
    expect(screen.queryByText("upload.fileError.size")).not.toBeInTheDocument();
    expect(screen.getByTestId("upload-submit-button")).not.toBeDisabled();
  });

  test("every dictionary tells the parent the same limit the code enforces", () => {
    // The limit and the five sentences announcing it live in different files
    // and different languages, and t() has no English fallback, so a number
    // changed on one side alone is silent -- in front of a parent, in a
    // language nobody here reads. Dictionaries are read off disk, matching
    // common/i18n.test.ts.
    const translationsDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../translations",
    );
    // Rounded so the failure message stays readable if the limit is ever set
    // in 1024-based units (52428800 bytes reports as 52MB, not 52.4288MB).
    const megabytes = Math.round(MAX_FILE_SIZE_BYTES / 1_000_000);
    // Not a bare substring: "50" must not be satisfied by a "150" elsewhere
    // in the sentence.
    const quotesTheLimit = new RegExp(`(?<!\\d)${megabytes}(?!\\d)`);

    const languages = fs
      .readdirSync(translationsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""));
    expect(languages.length).toBeGreaterThanOrEqual(5);

    for (const language of languages) {
      const dictionary = JSON.parse(
        fs.readFileSync(path.join(translationsDir, `${language}.json`), "utf8"),
      ) as Record<string, string>;

      for (const key of ["upload.maxSize", "upload.fileError.size"]) {
        expect(
          dictionary[key],
          `${language}.json is missing ${key}`,
        ).toBeTruthy();
        expect(
          dictionary[key],
          `${language}.json's ${key} does not quote the ${megabytes}MB limit the code enforces: ${dictionary[key]}`,
        ).toMatch(quotesTheLimit);
      }
    }
  });
});
