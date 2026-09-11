/**
 * The lossless rebuild, exercised against a REAL encrypted PDF rather than a
 * stand-in, because the only thing worth proving here is a property of real
 * PDF bytes: that the text layer is still in the file afterwards.
 *
 * Split from pdf-decrypt.test.ts on purpose. That file mocks jspdf, which is
 * what builds the fixture here, and mocking a module is all-or-nothing
 * within a file. So this file mocks ONLY pdfjs-dist -- standing in for the
 * password negotiation, exactly as the sibling file does -- and runs jsPDF
 * and @cantoo/pdf-lib for real, end to end, through the public
 * resolveEncryptedPdf entry point.
 *
 * The fixture is built here, in the test, with jsPDF's own encryption
 * support. Nothing from docs/sample-ieps/ is used or may be: those are
 * partly-redacted real student records, and a failing test uploads its
 * artifacts to CI.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { jsPDF } from "jspdf";
import { resolveEncryptedPdf } from "./pdf-decrypt";
import { ENCRYPT_ENTRY_PATTERN, readBlobAsArrayBuffer } from "./pdf-encryption";

const pdfjsMock = vi.hoisted(() => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: vi.fn(),
}));
vi.mock("pdfjs-dist", () => pdfjsMock);

/**
 * Text drawn into the fixture. jsPDF writes an uncompressed content stream,
 * and a lossless rebuild copies that stream through untouched, so these
 * strings survive verbatim into the output bytes. That is the whole
 * assertion: a rasterized rebuild could not possibly contain them, because
 * it replaces the page with a photograph of itself.
 */
const SERVICE_MINUTES_LINE = "SPEECH 60 MINUTES WEEKLY";
const GOALS_TABLE_LINE = "GOAL 1 BASELINE 4 OF 10 TRIALS";

/** A real, genuinely encrypted PDF with a real text layer. */
function encryptedPdfFile(options: { userPassword?: string; ownerPassword?: string } = {}): File {
  const doc = new jsPDF({ unit: "pt", format: [612, 792], encryption: options });
  doc.setFontSize(11);
  doc.text(SERVICE_MINUTES_LINE, 40, 80);
  doc.text(GOALS_TABLE_LINE, 40, 110);
  doc.addPage([612, 792], "p");
  doc.text("PAGE TWO PRESENT", 40, 80);
  return new File([doc.output("arraybuffer")], "iep.pdf", { type: "application/pdf" });
}

/** The output File's bytes as a byte-for-byte string, so assertions can talk
 * about what is actually in the PDF rather than about a mock. */
async function readAsBinaryString(file: File): Promise<string> {
  const bytes = new Uint8Array(await readBlobAsArrayBuffer(file));
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

type UpdatePassword = (response: string | Error) => void;

/** Same shape as the sibling file's fake loading task: pdf.js asks for a
 * password, keeps asking after a wrong one, and settles once it is right. */
function createFakeLoadingTask(correctPassword: string) {
  let settle!: (doc: unknown) => void;
  let fail!: (err: unknown) => void;
  const promise = new Promise((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const task = {
    onPassword: undefined as ((update: UpdatePassword) => void) | undefined,
    promise,
    destroy: vi.fn(async () => undefined),
  };
  queueMicrotask(() => {
    const attempt: UpdatePassword = (response) => {
      if (response instanceof Error) return fail(response);
      if (response === correctPassword) {
        return settle({
          numPages: 2,
          getPage: vi.fn(async () => ({
            getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale })),
            render: vi.fn(() => ({ promise: Promise.resolve() })),
            cleanup: vi.fn(),
          })),
        });
      }
      task.onPassword?.(attempt);
    };
    task.onPassword?.(attempt);
  });
  return task;
}

let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  // Stubbed so the rasterize FALLBACK can run in jsdom when a test asks for
  // it. The lossless path never touches a canvas, so a test that hits this
  // stub is a test that fell back.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,ZmFrZQ==");
  consoleSpies = ["log", "info", "warn", "error", "debug"].map((level) =>
    vi.spyOn(console, level as "log").mockImplementation(() => undefined),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("@cantoo/pdf-lib");
  vi.resetModules();
});

const passwordWasLogged = (needle: string): boolean =>
  consoleSpies.some((spy) => spy.mock.calls.some((args) => args.some((arg) => JSON.stringify(arg).includes(needle))));

describe("lossless rebuild: the text layer survives", () => {
  test("a password-protected PDF comes back decrypted with its text still in it, not as page images", async () => {
    const password = "district-2026";
    pdfjsMock.getDocument.mockImplementation(() => createFakeLoadingTask(password));

    const outcome = await resolveEncryptedPdf(encryptedPdfFile({ userPassword: password }), {
      requestPassword: vi.fn().mockResolvedValue(password),
    });

    expect(outcome.status).toBe("resolved");
    if (outcome.status !== "resolved") return;
    const rebuilt = await readAsBinaryString(outcome.file);

    // The text layer is still text: the exact strings drawn into the fixture
    // are present, alongside the text-showing operator that renders them.
    expect(rebuilt).toContain(SERVICE_MINUTES_LINE);
    expect(rebuilt).toContain(GOALS_TABLE_LINE);
    expect(rebuilt).toContain("PAGE TWO PRESENT");
    expect(rebuilt).toMatch(/\bT[jJ]\b/);
    expect(rebuilt).toContain("/Font");

    // ...and the document is NOT a stack of pictures. The rasterize fallback
    // always produces JPEG image XObjects; the lossless path never does.
    expect(rebuilt).not.toContain("DCTDecode");
    expect(rebuilt).not.toMatch(/\/Subtype\s*\/Image/);
  });

  test("the rebuilt file is no longer detected as encrypted, so it cannot re-prompt the parent", async () => {
    const password = "district-2026";
    pdfjsMock.getDocument.mockImplementation(() => createFakeLoadingTask(password));

    const outcome = await resolveEncryptedPdf(encryptedPdfFile({ userPassword: password }), {
      requestPassword: vi.fn().mockResolvedValue(password),
    });

    expect(outcome.status).toBe("resolved");
    if (outcome.status !== "resolved") return;
    const rebuilt = await readAsBinaryString(outcome.file);
    // The same check the upload flow runs, over the whole file rather than
    // just the tail it reads: no stale /Encrypt entry survives anywhere.
    expect(ENCRYPT_ENTRY_PATTERN.test(rebuilt)).toBe(false);
    // Pinned to the lossless path specifically. A rasterized rebuild also
    // has no /Encrypt, so without this the assertion above would still pass
    // if the lossless path silently stopped running.
    expect(rebuilt).not.toContain("DCTDecode");
  });

  test("the original encryption dictionary's password-derived hashes are not uploaded", async () => {
    const password = "district-2026";
    pdfjsMock.getDocument.mockImplementation(() => createFakeLoadingTask(password));

    const outcome = await resolveEncryptedPdf(encryptedPdfFile({ userPassword: password }), {
      requestPassword: vi.fn().mockResolvedValue(password),
    });

    expect(outcome.status).toBe("resolved");
    if (outcome.status !== "resolved") return;
    const rebuilt = await readAsBinaryString(outcome.file);
    // /O and /U (and the AES-256 /OE, /UE) are computed from the password.
    // Carrying them into the upload would put password-derived material in
    // durable storage for a password that never otherwise leaves the device.
    expect(rebuilt).not.toMatch(/\/[OU]E?\s*[(<]/);
    expect(rebuilt).not.toContain("/Standard");
    expect(passwordWasLogged(password)).toBe(false);
    expect(rebuilt).not.toContain(password);
    expect(outcome.file.name).toBe("iep.pdf");
    // As above: pinned to the lossless path, which is the only one that ever
    // has an encryption dictionary in hand to strip.
    expect(rebuilt).not.toContain("DCTDecode");
  });

  test("an owner-restricted file with an empty user password goes lossless too, with no prompt", async () => {
    pdfjsMock.getDocument.mockImplementation(() => createFakeLoadingTask(""));
    const requestPassword = vi.fn();

    const outcome = await resolveEncryptedPdf(encryptedPdfFile({ ownerPassword: "owner-only" }), {
      requestPassword,
    });

    expect(outcome.status).toBe("resolved");
    expect(requestPassword).not.toHaveBeenCalled();
    if (outcome.status !== "resolved") return;
    const rebuilt = await readAsBinaryString(outcome.file);
    expect(rebuilt).toContain(SERVICE_MINUTES_LINE);
    expect(rebuilt).not.toContain("DCTDecode");
  });
});

describe("lossless rebuild: falling back is still safe", () => {
  test("a file the lossless path cannot parse still resolves, via the rasterize fallback", async () => {
    const password = "district-2026";
    pdfjsMock.getDocument.mockImplementation(() => createFakeLoadingTask(password));
    // Not a PDF at all: pdf.js is mocked, so only @cantoo/pdf-lib ever looks
    // at these bytes, and it cannot parse them.
    const notAPdf = new File(["not a pdf at all"], "iep.pdf", { type: "application/pdf" });

    const outcome = await resolveEncryptedPdf(notAPdf, {
      requestPassword: vi.fn().mockResolvedValue(password),
    });

    expect(outcome.status).toBe("resolved");
    if (outcome.status !== "resolved") return;
    // The rasterize path ran: its output is the stubbed JPEG, and it is a
    // real jsPDF document rather than the original bytes.
    expect(outcome.file.name).toBe("iep.pdf");
    expect(outcome.file.type).toBe("application/pdf");
    const rebuilt = await readAsBinaryString(outcome.file);
    expect(rebuilt.startsWith("%PDF")).toBe(true);
    expect(rebuilt).not.toContain("not a pdf at all");
    expect(passwordWasLogged(password)).toBe(false);
  });

  test("the lossless path throwing is caught, not surfaced, and the password is still never logged", async () => {
    const password = "district-2026";
    vi.doMock("@cantoo/pdf-lib", () => ({
      PDFDocument: {
        load: vi.fn(() => {
          throw new Error(`boom while decrypting with ${password}`);
        }),
      },
      PDFName: { of: (n: string) => `/${n}` },
    }));
    vi.resetModules();
    const { resolveEncryptedPdf: freshResolve } = await import("./pdf-decrypt");
    pdfjsMock.getDocument.mockImplementation(() => createFakeLoadingTask(password));

    const outcome = await freshResolve(encryptedPdfFile({ userPassword: password }), {
      requestPassword: vi.fn().mockResolvedValue(password),
    });

    // It fell back rather than failing, and the thrown message -- which
    // deliberately contains the password -- reached no console method.
    expect(outcome.status).toBe("resolved");
    expect(passwordWasLogged(password)).toBe(false);
  });
});
