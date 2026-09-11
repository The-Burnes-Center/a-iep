/**
 * Turns a PDF that pdf-encryption.ts flagged via /Encrypt into either a
 * silently-fixed upload or a password prompt, instead of the flat refusal
 * that shipped first (see that module's docblock for why /Encrypt alone
 * cannot tell those two cases apart). This module is what actually opens the
 * file, so it is the one place in the app that can.
 *
 * The two cases /Encrypt cannot distinguish on its own:
 *  - Owner-restricted only: the file has an encryption dictionary but an
 *    EMPTY user password, e.g. a district PDF that blocks printing/copying
 *    but never prompted the parent for anything. Per the PDF spec, this
 *    decrypts fully by trying the user password "" first. The parent never
 *    set a password and never saw a dialog, so nothing should be said to
 *    them; the file just needs to work.
 *  - Actually password-protected: a real, non-empty user password is
 *    required. There the honest thing is to say so and ask for it, making
 *    it explicit that the password is used and discarded in the browser.
 *
 * How the two are told apart: try the empty password first, silently, via
 * pdf.js's onPassword callback (see loadPdfJs/resolveEncryptedPdf below). If
 * that succeeds, the file was only owner-restricted. If pdf.js calls
 * onPassword a second time, the empty attempt was wrong, so a real password
 * is required and the caller's requestPassword callback takes over.
 *
 * The password:
 *  - Is read from a <input type="password"> by the caller (see
 *    PdfPasswordPromptModal) and handed to this module as a plain string
 *    ONLY as a function argument, through requestPassword's resolved value
 *    and into pdf.js's updatePassword(). It is never assigned to a module- or
 *    component-level variable that outlives that call, never placed in any
 *    object this app serializes (no upload payload, no localStorage, no
 *    analytics event), and this module never logs it or any error that could
 *    contain it (catch blocks below discard the error's contents entirely --
 *    see the module's own tests for a mutation check on this).
 *  - Never leaves the browser: everything from parsing the encrypted bytes
 *    to re-encoding the cleaned pages happens in this tab (pdf.js runs its
 *    parsing in a Worker it spawns locally, not a network call). The ONLY
 *    thing that leaves the browser afterward is the rebuilt, already-decrypted
 *    File, via the same upload path every other document already uses.
 *
 * Rebuilding "clean": pdf.js can read and render a decrypted page, but this
 * app has no PDF-writing library that understands PDF structure well enough
 * to just strip /Encrypt and re-save the original objects (pdf-lib, the
 * common choice, does not support parsing an encrypted document at all).
 * So the only available path is to rasterize each page with pdf.js and
 * re-encode it as a new page image, via jsPDF (already an indirect
 * dependency here through html2pdf.js, so this is not new supply-chain
 * surface). That is a real quality trade rather than a free rebuild, which
 * is why REBUILD_TARGET_DPI below is not an arbitrary "looks fine" number.
 *
 * REBUILD_TARGET_DPI was chosen from a real measurement, not a guess: a page
 * from a genuinely scanned IEP (WA OSPI sample E, a 150dpi paper scan per its
 * own embedded image metadata) was rasterized at several scales the way this
 * module does, and each rasterization was OCR'd (tesseract) alongside the
 * original embedded scan image, offline, no document content or text
 * reproduced here, only the aggregate result:
 *
 *   variant                          words   mean OCR confidence
 *   original embedded scan (144-150dpi)  605         92.1
 *   72dpi  (pdf.js scale=1, a "screen" default)  550   51.8  <- unusable
 *   96dpi  (scale=1.33)                  595         84.2   <- degraded
 *   150dpi (scale=2.08, matches native)  601         92.6   <- matches
 *   200dpi (scale=2.78)                  607         92.4   <- matches, margin
 *
 * The failure mode is real and large (a ~44-point confidence drop at a
 * "screen" resolution), but it is a resolution problem, not a proof that
 * rasterizing is unsafe: rendering at or above the source scan's own
 * resolution matches the original's OCR confidence and word count. 200dpi
 * (this module's target) sits above every common scan/photo resolution this
 * app is likely to see, at a JPEG quality (below) that keeps a 15-page
 * document a few MB, not tens of MB.
 */
import { readBlobAsArrayBuffer } from './pdf-encryption';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';

/** See the module docblock: matches or exceeds a real scanned IEP's native
 * resolution, measured directly against OCR confidence and word count. */
export const REBUILD_TARGET_DPI = 200;

/** pdf.js's `scale` is relative to the PDF's own unit, which is fixed at
 * 1/72 inch by the PDF spec, so scale === DPI / 72. */
export const REBUILD_RENDER_SCALE = REBUILD_TARGET_DPI / 72;

/** Measured alongside REBUILD_TARGET_DPI above (the "200dpi" row). High
 * enough that JPEG artifacting was not the limiting factor in that result. */
export const REBUILD_JPEG_QUALITY = 0.92;

/**
 * Thrown into pdf.js's `updatePassword()` to make the loading task's promise
 * reject when the parent cancels the prompt, so `resolveEncryptedPdf` can
 * tell "the parent backed out" apart from "something actually went wrong".
 * Carries no data from the attempt -- not the password, not a page count,
 * nothing -- there is never anything to accidentally log here.
 */
class PdfPasswordCancelledError extends Error {
  constructor() {
    super('cancelled-by-parent');
    this.name = 'PdfPasswordCancelledError';
  }
}

export type EncryptedPdfOutcome =
  | { status: 'resolved'; file: File }
  | { status: 'cancelled' }
  | { status: 'failed' };

export interface ResolveEncryptedPdfCallbacks {
  /**
   * Called only when a real, non-empty password is required. `wrongPassword`
   * is false for the first time the parent sees a prompt for this file, true
   * on every call after a guess they typed was rejected. Resolve with the
   * password to try, or with `null` if the parent cancelled. Must not reject;
   * a rejection is treated the same as `null`.
   */
  requestPassword: (wrongPassword: boolean) => Promise<string | null>;
}

type PdfjsModule = typeof import('pdfjs-dist');

// Memoized so a parent who opens the password prompt more than once in a
// session (a second encrypted file, or a wrong-password retry) only ever
// pays for the pdfjs-dist/pdf.worker chunk fetch once.
let pdfjsModulePromise: Promise<PdfjsModule> | null = null;

function loadPdfJs(): Promise<PdfjsModule> {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = import('pdfjs-dist').then((pdfjs) => {
      // Must be the SAME package's worker build: pdf.js refuses to run when
      // the API and worker versions differ, so this file is synced from the
      // installed pdfjs-dist (scripts/sync-bootstrap.cjs) rather than pointed
      // at a CDN that could drift out of sync.
      //
      // This is a plain /vendor/ URL, not `new URL('pdfjs-dist/...', import.
      // meta.url)`: that is the more common pdf.js/Vite pattern, but building
      // this app with it left an UNRESOLVED __VITE_ASSET__... placeholder
      // string in the shipped chunk instead of a real path (confirmed by
      // inspecting dist/assets/ directly). index.html and sync-bootstrap.cjs
      // document the same root cause for Bootstrap's CSS/fonts: Vite 4's
      // production build does not reliably resolve this asset-URL pattern,
      // so, like those files, the worker is synced as a static public file
      // and referenced by a plain path instead.
      pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
      return pdfjs;
    });
  }
  return pdfjsModulePromise;
}

/**
 * Rasterizes every page of an already-opened, decrypted PDF and re-encodes
 * it as a new, unencrypted PDF (see the module docblock for why this is the
 * only rebuild path available, and how REBUILD_TARGET_DPI was chosen).
 *
 * Pages are re-added one at a time with each page's own size (`format`),
 * rather than assuming Letter/A4, so a document with a mixed page size or a
 * rotated page comes back the same shape it went in: `getViewport({scale:1})`
 * already reflects a page's `/Rotate` entry, and REBUILD_RENDER_SCALE is
 * applied on top of that same, already-correctly-oriented viewport.
 */
async function rebuildCleanPdf(pdfDocument: PDFDocumentProxy, fileName: string): Promise<File> {
  const { jsPDF } = await import('jspdf');
  let doc: InstanceType<typeof jsPDF> | null = null;

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
    const page = await pdfDocument.getPage(pageNumber);
    const renderViewport = page.getViewport({ scale: REBUILD_RENDER_SCALE });
    // The page's real size in PDF points (1/72in), independent of the render
    // scale above, so the rebuilt page is the same physical size as the
    // original rather than however many pixels REBUILD_RENDER_SCALE produced.
    const pointsViewport = page.getViewport({ scale: 1 });
    const widthPt = pointsViewport.width;
    const heightPt = pointsViewport.height;
    const orientation = widthPt > heightPt ? 'l' : 'p';

    const canvas = document.createElement('canvas');
    canvas.width = renderViewport.width;
    canvas.height = renderViewport.height;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('2D canvas context unavailable');
    }
    await page.render({ canvas, canvasContext: context, viewport: renderViewport }).promise;
    const pageImage = canvas.toDataURL('image/jpeg', REBUILD_JPEG_QUALITY);

    if (!doc) {
      doc = new jsPDF({ unit: 'pt', format: [widthPt, heightPt], orientation, compress: true });
    } else {
      doc.addPage([widthPt, heightPt], orientation);
    }
    doc.addImage(pageImage, 'JPEG', 0, 0, widthPt, heightPt);

    // Without this, a 20-page scan keeps every page's decoded image and
    // canvas alive at once for the whole loop.
    page.cleanup();
    canvas.width = 0;
    canvas.height = 0;
  }

  if (!doc) {
    // No conforming PDF has zero pages, but pdf.js's numPages is trusted
    // input from the file itself; fail loudly rather than return nothing.
    throw new Error('Encrypted PDF reported zero pages');
  }
  return new File([doc.output('blob')], fileName, { type: 'application/pdf' });
}

/**
 * Opens a PDF already known (by pdf-encryption.ts's isLikelyEncryptedPdf) to
 * carry /Encrypt, resolving it into a clean, uploadable File without ever
 * sending the file's password anywhere.
 *
 * Silent path: the empty user password is tried first, automatically, before
 * `requestPassword` is ever called. If that succeeds the file was only
 * owner-restricted (see the module docblock) and this returns 'resolved'
 * having never involved the caller at all -- the parent sees nothing.
 *
 * Prompted path: only if the empty password is rejected does this call
 * `requestPassword`, and only ever for a real, non-empty password.
 *
 * Every failure -- pdf.js failing to load, a corrupt or unsupported file, a
 * canvas or jsPDF error mid-rebuild -- resolves 'failed' rather than
 * throwing, so the caller's existing refusal message (the one that shipped
 * before this module existed) is always a safe fallback. Nothing here is
 * ever logged: a caught error's contents are discarded, not inspected, so a
 * message that happened to echo file bytes (or, in principle, a password)
 * can't reach the console.
 */
export async function resolveEncryptedPdf(
  file: File,
  { requestPassword }: ResolveEncryptedPdfCallbacks,
): Promise<EncryptedPdfOutcome> {
  let loadingTask: PDFDocumentLoadingTask | undefined;
  try {
    const pdfjs = await loadPdfJs();
    const bytes = new Uint8Array(await readBlobAsArrayBuffer(file));
    loadingTask = pdfjs.getDocument({ data: bytes });

    let triedEmptyPassword = false;
    let hasPromptedParent = false;
    loadingTask.onPassword = (updatePassword: (response: string | Error) => void) => {
      if (!triedEmptyPassword) {
        triedEmptyPassword = true;
        updatePassword(''); // Silent step 1: the owner-restricted case.
        return;
      }
      // A real password is required: either the silent empty attempt above
      // was wrong, or a password the parent typed was wrong.
      const wrongPassword = hasPromptedParent;
      hasPromptedParent = true;
      requestPassword(wrongPassword).then(
        (password) => updatePassword(password === null ? new PdfPasswordCancelledError() : password),
        () => updatePassword(new PdfPasswordCancelledError()),
      );
    };

    let pdfDocument: PDFDocumentProxy;
    try {
      pdfDocument = await loadingTask.promise;
    } catch (err) {
      if (err instanceof PdfPasswordCancelledError) {
        return { status: 'cancelled' };
      }
      throw err;
    }

    const rebuiltFile = await rebuildCleanPdf(pdfDocument, file.name);
    return { status: 'resolved', file: rebuiltFile };
  } catch {
    return { status: 'failed' };
  } finally {
    await loadingTask?.destroy();
  }
}
