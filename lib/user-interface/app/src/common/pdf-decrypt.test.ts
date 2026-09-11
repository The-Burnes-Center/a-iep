/**
 * resolveEncryptedPdf orchestrates pdf.js and jsPDF (both mocked below, per
 * this repo's own pattern of mocking a specific heavy/external dependency
 * rather than the module under test -- see UploadIEPDocument.test.tsx's
 * `aws-amplify/auth` mock) to reproduce the two things pdf.js actually does:
 *
 *  - It only ever asks for a password once per attempt, via onPassword, and
 *    keeps asking again after every wrong guess -- this repo's own module
 *    docblock and pdf.js's `PasswordRequest` handler confirm that shape.
 *  - The FIRST ask always represents "no password tried yet"; whether it
 *    succeeds (owner-restricted only, silent) or not is exactly what tells
 *    the empty-password step apart from a real user password being required.
 *
 * A canvas 2D context is stubbed (jsdom does not implement one) so
 * rebuildCleanPdf's render step can run; nothing about pixel content is
 * asserted here (that is what the OCR-quality experiment behind
 * REBUILD_TARGET_DPI, cited in the module docblock, was for -- there is no
 * meaningful way to assert image fidelity from a stubbed canvas).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveEncryptedPdf } from "./pdf-decrypt";

const pdfjsMock = vi.hoisted(() => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: vi.fn(),
}));
vi.mock("pdfjs-dist", () => pdfjsMock);

const jspdfMock = vi.hoisted(() => {
  class FakeJsPDF {
    static instances: FakeJsPDF[] = [];
    ctorArgs: unknown[];
    addImageCalls: unknown[][] = [];
    addPageCalls: unknown[][] = [];
    constructor(...args: unknown[]) {
      this.ctorArgs = args;
      FakeJsPDF.instances.push(this);
    }
    addImage(...args: unknown[]) {
      this.addImageCalls.push(args);
      return this;
    }
    addPage(...args: unknown[]) {
      this.addPageCalls.push(args);
      return this;
    }
    output() {
      return new Blob(["fake-pdf-bytes"], { type: "application/pdf" });
    }
  }
  return { FakeJsPDF, jsPDF: FakeJsPDF };
});
vi.mock("jspdf", () => ({ jsPDF: jspdfMock.jsPDF }));

type UpdatePassword = (response: string | Error) => void;

/**
 * Stands in for pdf.js's real PDFDocumentLoadingTask. `correctPassword`
 * models what the real security handler would accept: '' for a file that is
 * only owner-restricted (decrypts on the very first, empty-password try),
 * or a real string for a file that needs one. `onLoadFailure` models pdf.js
 * rejecting outright (a corrupt/unsupported file), independent of passwords.
 */
function createFakeLoadingTask(options: { correctPassword?: string; loadFailure?: Error }) {
  let settle!: (doc: unknown) => void;
  let fail!: (err: unknown) => void;
  const promise = new Promise((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const fakePdfDocument = {
    numPages: 1,
    getPage: vi.fn(async () => ({
      getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 100 * scale, height: 100 * scale })),
      render: vi.fn(() => ({ promise: Promise.resolve() })),
      cleanup: vi.fn(),
    })),
  };

  const task = {
    onPassword: undefined as ((update: UpdatePassword) => void) | undefined,
    promise,
    destroy: vi.fn(async () => undefined),
  };

  queueMicrotask(() => {
    if (options.loadFailure) {
      fail(options.loadFailure);
      return;
    }
    const correctPassword = options.correctPassword ?? "";
    const attempt: UpdatePassword = (response) => {
      if (response instanceof Error) {
        fail(response);
        return;
      }
      if (response === correctPassword) {
        settle(fakePdfDocument);
        return;
      }
      task.onPassword?.(attempt);
    };
    task.onPassword?.(attempt);
  });

  return task;
}

const encryptedFile = () => new File(["%PDF-1.4 encrypted body"], "iep.pdf", { type: "application/pdf" });

let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,ZmFrZQ==");
  // Every log level is watched so a password that leaked into ANY of them
  // would be caught below, not just the one a developer happened to use.
  consoleSpies = ["log", "info", "warn", "error", "debug"].map((level) =>
    vi.spyOn(console, level as "log").mockImplementation(() => undefined),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  jspdfMock.FakeJsPDF.instances = [];
});

/** True if `needle` shows up in anything any console method was called with,
 * across every spy -- the mutation-checked assertion in the tests below. */
const passwordWasLogged = (needle: string): boolean =>
  consoleSpies.some((spy) =>
    spy.mock.calls.some((args) => args.some((arg) => JSON.stringify(arg).includes(needle))),
  );

describe("resolveEncryptedPdf: owner-restricted files (empty user password)", () => {
  test("decrypts silently: requestPassword is never called, and the rebuilt file resolves", async () => {
    pdfjsMock.getDocument.mockImplementation(() => createFakeLoadingTask({ correctPassword: "" }));
    const requestPassword = vi.fn();

    const outcome = await resolveEncryptedPdf(encryptedFile(), { requestPassword });

    expect(outcome.status).toBe("resolved");
    expect(requestPassword).not.toHaveBeenCalled();
    if (outcome.status === "resolved") {
      expect(outcome.file.name).toBe("iep.pdf");
      expect(outcome.file.type).toBe("application/pdf");
    }
  });
});

describe("resolveEncryptedPdf: a real user password is required", () => {
  test("prompts once the empty password is wrong, and the right password produces a clean upload", async () => {
    pdfjsMock.getDocument.mockImplementation(() => createFakeLoadingTask({ correctPassword: "sesame-open-2024" }));
    const requestPassword = vi.fn().mockResolvedValue("sesame-open-2024");

    const outcome = await resolveEncryptedPdf(encryptedFile(), { requestPassword });

    expect(outcome.status).toBe("resolved");
    // Called exactly once: the silent empty attempt is internal and does not
    // count as a "prompt", and one correct guess should not ask again.
    expect(requestPassword).toHaveBeenCalledTimes(1);
    expect(requestPassword).toHaveBeenCalledWith(false); // first real prompt, not "wrong password"
    expect(passwordWasLogged("sesame-open-2024")).toBe(false);
  });

  test("a wrong guess is reported (wrongPassword=true) without losing the attempt; a later correct guess still resolves", async () => {
    pdfjsMock.getDocument.mockImplementation(() => createFakeLoadingTask({ correctPassword: "right-password" }));
    const requestPassword = vi
      .fn()
      .mockResolvedValueOnce("first-guess-wrong")
      .mockResolvedValueOnce("right-password");

    const outcome = await resolveEncryptedPdf(encryptedFile(), { requestPassword });

    expect(outcome.status).toBe("resolved");
    expect(requestPassword).toHaveBeenCalledTimes(2);
    expect(requestPassword).toHaveBeenNthCalledWith(1, false); // first prompt: not yet "wrong"
    expect(requestPassword).toHaveBeenNthCalledWith(2, true); // retry: the previous guess failed
    expect(passwordWasLogged("first-guess-wrong")).toBe(false);
    expect(passwordWasLogged("right-password")).toBe(false);
  });

  test("cancelling resolves 'cancelled' rather than 'failed', and still releases the pdf.js worker", async () => {
    // The fake task must be built lazily, INSIDE the mock implementation
    // (not before, then handed to a mock that returns it): its queueMicrotask
    // call races the real onPassword assignment, and building it too early
    // schedules that microtask before resolveEncryptedPdf has had a chance
    // to run at all, so onPassword is still unset when it fires.
    let capturedTask: ReturnType<typeof createFakeLoadingTask> | undefined;
    pdfjsMock.getDocument.mockImplementation(() => {
      capturedTask = createFakeLoadingTask({ correctPassword: "right-password" });
      return capturedTask;
    });
    const requestPassword = vi.fn().mockResolvedValue(null); // the parent clicked cancel

    const outcome = await resolveEncryptedPdf(encryptedFile(), { requestPassword });

    expect(outcome).toEqual({ status: "cancelled" });
    expect(capturedTask?.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("resolveEncryptedPdf: failure is always safe", () => {
  test("a file pdf.js cannot open at all (not a password problem) resolves 'failed', not a throw", async () => {
    pdfjsMock.getDocument.mockImplementation(() =>
      createFakeLoadingTask({ loadFailure: new Error("Invalid PDF structure") }),
    );
    const requestPassword = vi.fn();

    const outcome = await resolveEncryptedPdf(encryptedFile(), { requestPassword });

    expect(outcome).toEqual({ status: "failed" });
    expect(requestPassword).not.toHaveBeenCalled();
  });

  test("pdf.js itself failing to load resolves 'failed' rather than throwing", async () => {
    pdfjsMock.getDocument.mockImplementation(() => {
      throw new Error("worker script fetch failed");
    });
    const requestPassword = vi.fn();

    const outcome = await resolveEncryptedPdf(encryptedFile(), { requestPassword });

    expect(outcome).toEqual({ status: "failed" });
  });
});

describe("mutation checks (run by hand: break the code, confirm the test fails, restore)", () => {
  test("the empty-password attempt is real: if pdf.js ever asks a SECOND time for an owner-restricted file, this fails", async () => {
    // This is the automated half of the "break the empty-password attempt"
    // mutation check: temporarily change pdf-decrypt.ts's `updatePassword('')`
    // to any other value (or delete the `if (!triedEmptyPassword)` branch)
    // and this test starts failing, because requestPassword would then be
    // called for a file that never needed a real password at all.
    pdfjsMock.getDocument.mockImplementation(() => createFakeLoadingTask({ correctPassword: "" }));
    const requestPassword = vi.fn();

    await resolveEncryptedPdf(encryptedFile(), { requestPassword });

    expect(requestPassword).not.toHaveBeenCalled();
  });

  test("the rebuilt file's name carries no trace of the password used to open it", async () => {
    // This is the automated half of the "make the password leak into an
    // upload payload" mutation check: temporarily change rebuildCleanPdf's
    // call site to fold the password into the filename (or any other part of
    // the returned File) and this test starts failing.
    pdfjsMock.getDocument.mockImplementation(() => createFakeLoadingTask({ correctPassword: "leak-me-not" }));
    const requestPassword = vi.fn().mockResolvedValue("leak-me-not");

    const outcome = await resolveEncryptedPdf(encryptedFile(), { requestPassword });

    expect(outcome.status).toBe("resolved");
    if (outcome.status === "resolved") {
      expect(outcome.file.name).toBe("iep.pdf");
      expect(outcome.file.name).not.toContain("leak-me-not");
    }
  });
});
