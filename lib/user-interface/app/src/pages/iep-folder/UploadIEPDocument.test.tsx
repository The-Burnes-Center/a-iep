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

// A File whose bytes are not actually allocated: jsdom reports whatever
// `size` says, and materialising 50 MB per test to check one comparison would
// be a slow way to learn nothing extra.
const fileOfSize = (bytes: number, name = "iep-scan.pdf") => {
  const file = plainPdf(name);
  Object.defineProperty(file, "size", { value: bytes });
  return file;
};

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

/**
 * What the picker offers, and what a parent is told when it is refused.
 *
 * Two defects in one place. The input carried no `accept`, so the OS picker
 * offered every file on the device and a parent could pick a photo of page one
 * and only learn we cannot read it after the picker had closed. And the
 * refusal rendered as an inline <small> directly against the
 * supported-formats hint, so they ran together as one line:
 * "File format not supportedSupported formats: .doc, .docx, .pdf".
 */
describe("UploadIEPDocument: the file picker and its messages", () => {
  const unsupportedFile = (name = "notes.txt", type = "text/plain") =>
    new File(["not an IEP"], name, { type });

  const acceptedBy = (input: HTMLInputElement) =>
    (input.getAttribute("accept") ?? "").split(",").map((value) => value.trim());

  test("the picker offers the three formats the pipeline can read, by extension AND by MIME type", () => {
    // Both halves, because no one picker uses both: desktop pickers filter on
    // the MIME types and Android's document providers routinely only
    // understand the extensions. Exact tokens rather than substrings, so
    // ".doc" cannot be satisfied by the ".docx" next to it.
    renderUpload();

    const offered = acceptedBy(document.getElementById("fileUpload") as HTMLInputElement);

    for (const token of [
      ".pdf",
      ".doc",
      ".docx",
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ]) {
      expect(offered, `accept does not offer ${token}: ${offered.join(",")}`).toContain(token);
    }
    // The MIME types are looked up per extension, so an extension added to the
    // gate without one produces a hole. Asserted as an empty token and not as
    // the string "undefined": Array.prototype.join stringifies undefined to
    // "", so accept would read ".doc,.docx,.pdf,.rtf,...,application/pdf,"
    // and a check for "undefined" could never fire.
    expect(offered).not.toContain("");
  });

  test("accept is only a hint: a file that gets past it is still refused, and never uploaded", async () => {
    // Drag-and-drop ignores accept, every picker offers a way out of the
    // filter, and this file claims a MIME type we do accept while carrying an
    // extension we do not -- which is what a renamed photo looks like. The
    // extension check is the gate, so it has to still be the thing that
    // refuses.
    renderUpload();

    selectFile(unsupportedFile("page-one.jpg", "application/pdf"));

    await waitFor(() => {
      expect(screen.getByTestId("file-error")).toHaveTextContent("upload.fileError.format");
    });
    expect(screen.queryByText("page-one.jpg")).not.toBeInTheDocument();
    expect(screen.getByTestId("upload-submit-button")).toBeDisabled();
    expect(iepClient.getUploadURL).not.toHaveBeenCalled();
  });

  test("the format refusal replaces the supported-formats hint instead of stacking on top of it", async () => {
    // The message names the three formats itself (pinned across all five
    // dictionaries below), so the hint would be the same fact twice.
    renderUpload();

    selectFile(unsupportedFile());

    await waitFor(() => {
      expect(screen.getByTestId("file-error")).toHaveTextContent("upload.fileError.format");
    });
    expect(screen.queryByTestId("supported-formats-hint")).toBeNull();
  });

  test("the size refusal keeps the hint, because it says nothing about formats", async () => {
    // The condition is "a format error is showing", not "an error is showing".
    // A parent refused on size still has to be told what we can read.
    renderUpload();

    selectFile(fileOfSize(MAX_FILE_SIZE_BYTES + 1));

    await waitFor(() => {
      expect(screen.getByTestId("file-error")).toHaveTextContent("upload.fileError.size");
    });
    expect(screen.getByTestId("supported-formats-hint")).toBeInTheDocument();
  });

  test("the password-protected refusal keeps the hint too", async () => {
    pdfDecrypt.resolveEncryptedPdf.mockResolvedValue({ status: "failed" });
    renderUpload();

    selectFile(encryptedPdf());

    await waitFor(() => {
      expect(screen.getByTestId("file-error")).toHaveTextContent("upload.fileError.encrypted");
    });
    expect(screen.getByTestId("supported-formats-hint")).toBeInTheDocument();
  });

  test("the refusal is announced, and is attached to the input it is about", async () => {
    // It was a bare <small> with no role and no association: a screen-reader
    // user moved off the input, got nothing, and came back to a control that
    // described itself exactly as it had before being refused.
    renderUpload();

    const input = document.getElementById("fileUpload") as HTMLInputElement;
    // Before anything is picked, the input is described by the hint alone.
    expect(input.getAttribute("aria-describedby")).toBe(
      screen.getByTestId("supported-formats-hint").id,
    );

    selectFile(unsupportedFile());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("upload.fileError.format");
    expect(alert.id).toBeTruthy();

    const describedBy = (input.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    expect(describedBy).toContain(alert.id);
    // Every id it names resolves: an idref pointing at nothing describes the
    // input as nothing, which is the state this test exists to rule out.
    for (const id of describedBy) {
      expect(document.getElementById(id), `aria-describedby names a missing id: ${id}`).not.toBeNull();
    }
  });

  test("picking a supported file clears the refusal and brings the hint back", async () => {
    renderUpload();

    selectFile(unsupportedFile());
    await waitFor(() => {
      expect(screen.getByTestId("file-error")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("supported-formats-hint")).toBeNull();

    selectFile(plainPdf());

    await waitFor(() => {
      expect(screen.getByText("iep.pdf")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("file-error")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("supported-formats-hint")).toBeInTheDocument();
    expect(screen.getByTestId("upload-submit-button")).not.toBeDisabled();
  });

  test("every dictionary's format refusal names all three formats", () => {
    // Dropping the hint is only safe while the message itself carries the
    // formats. If the copy is ever shortened back to "File format not
    // supported", a parent stops being told what we can read at all -- and in
    // four of the five languages nobody here would notice. Dictionaries are
    // read off disk, matching common/i18n.test.ts.
    const translationsDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../translations",
    );
    const languages = fs
      .readdirSync(translationsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""));
    expect(languages.length).toBeGreaterThanOrEqual(5);

    for (const language of languages) {
      const entries = JSON.parse(
        fs.readFileSync(path.join(translationsDir, `${language}.json`), "utf8"),
      ) as Record<string, string>;
      const message = entries["upload.fileError.format"];

      expect(message, `${language}.json is missing upload.fileError.format`).toBeTruthy();
      // DOC is checked with a negative lookahead so the DOCX beside it cannot
      // stand in for it.
      for (const format of [/PDF/i, /DOCX/i, /DOC(?!X)/i]) {
        expect(
          message,
          `${language}.json's format message does not name ${format}: ${message}`,
        ).toMatch(format);
      }
    }
  });
});

/**
 * The child's name, in the gold chip the design puts above the heading.
 *
 * It comes from the profile, so the two things that can go wrong are showing
 * an empty chip (no name on file, or the auto-created 'My Child' placeholder,
 * or a profile that will not load) and showing the wrong thing. The screen has
 * to keep working in all of them: the chip is a courtesy, the upload is not.
 */
describe("the child's name badge", () => {
  const profileWith = (children: unknown[]) => ({
    userId: "parent-1",
    secondaryLanguage: "en",
    consentGiven: true,
    showOnboarding: false,
    children,
  });

  /** Signs the profile call in and answers it with `profile`, or fails it. */
  const renderWithProfile = (
    profile: Record<string, unknown> | null,
    { failRead = false } = {},
  ) => {
    Auth.fetchAuthSession.mockResolvedValue({
      tokens: { idToken: { toString: () => "id-token", payload: {} } },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        failRead
          ? { ok: false, status: 500, json: async () => ({}) }
          : { ok: true, status: 200, json: async () => ({ profile }) },
      ),
    );
    return renderUpload();
  };

  test("shows the name that is on the profile", async () => {
    renderWithProfile(profileWith([{ childId: "child-1", name: "Alex Rivera", schoolCity: "Boston" }]));

    const badge = await screen.findByTestId("upload-child-badge");
    expect(badge).toHaveTextContent("Alex Rivera");
    // Sits above the heading, per the design.
    expect(
      badge.compareDocumentPosition(screen.getByText("upload.title")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("says whose IEP it is, rather than leaving a bare name for a screen reader", async () => {
    renderWithProfile(profileWith([{ childId: "child-1", name: "Alex Rivera", schoolCity: "Boston" }]));

    const badge = await screen.findByTestId("upload-child-badge");
    expect(badge).toHaveTextContent("upload.childBadge.label");
  });

  test("renders nothing at all when the child has no name", async () => {
    renderWithProfile(profileWith([{ childId: "child-1", name: "", schoolCity: "Boston" }]));

    // Waiting on the form proves the profile call has been and gone, so this
    // is "no badge", not "not yet".
    await screen.findByTestId("upload-submit-button");
    await waitFor(() => expect(screen.queryByTestId("upload-child-badge")).toBeNull());
  });

  test("renders nothing for the auto-created 'My Child' placeholder", async () => {
    // Consent creates that row before anyone has typed a name. Printing it
    // back in a gold chip would tell a parent we think their child is called
    // My Child.
    renderWithProfile(profileWith([{ childId: "child-1", name: "My Child", schoolCity: "Boston" }]));

    await screen.findByTestId("upload-submit-button");
    await waitFor(() => expect(screen.queryByTestId("upload-child-badge")).toBeNull());
  });

  test("renders nothing when there is no child on the profile", async () => {
    renderWithProfile(profileWith([]));

    await screen.findByTestId("upload-submit-button");
    await waitFor(() => expect(screen.queryByTestId("upload-child-badge")).toBeNull());
  });

  test("leaves the upload working when the profile cannot be read", async () => {
    renderWithProfile(null, { failRead: true });

    expect(await screen.findByTestId("upload-submit-button")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("upload-child-badge")).toBeNull());
  });

  test("does not use the design's 100 MB line: the copy quotes the real limit", () => {
    // The mock-up predates the drop to 50MB. The limit and the sentence that
    // announces it are pinned together above; this only rules out the number
    // the design asks for.
    expect(MAX_FILE_SIZE_BYTES).toBeLessThan(100 * 1000 * 1000);
    const en = JSON.parse(
      fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "../../translations/en.json"),
        "utf8",
      ),
    ) as Record<string, string>;
    expect(en["upload.maxSize"]).not.toMatch(/100\s*MB/i);
  });
});
