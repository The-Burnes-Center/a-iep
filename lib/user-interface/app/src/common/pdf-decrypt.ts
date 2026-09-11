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
 *    ONLY as a function argument: through requestPassword's resolved value,
 *    into pdf.js's updatePassword(), and into rebuildLosslessPdf. It is never
 *    assigned to a module- or component-level variable, never placed in any
 *    object this app serializes (no upload payload, no localStorage, no
 *    analytics event), and this module never logs it or any error that could
 *    contain it (catch blocks below discard the error's contents entirely --
 *    see the module's own tests for a mutation check on this).
 *  - Reaches rebuildLosslessPdf because it has to: pdf.js decrypts inside its
 *    own worker and offers no way to get the decrypted bytes back out
 *    (getData() and saveDocument() both return the original, still-encrypted
 *    file, and extractPages() re-encrypts its output with the source's own
 *    encryption dictionary -- all three checked against pdfjs-dist 6.3.289
 *    directly, not assumed). So the lossless rebuild has to parse the file
 *    itself, which means holding the password for the length of one call.
 *    resolveEncryptedPdf keeps it in a single local binding and clears that
 *    binding in its `finally`, so it does not outlive the call even if the
 *    rebuild throws. The RASTERIZE fallback, by contrast, still takes no
 *    password at all: its signature makes the leak structurally impossible,
 *    and it stays that way.
 *  - Never leaves the browser: everything from parsing the encrypted bytes
 *    to re-encoding the cleaned pages happens in this tab (pdf.js runs its
 *    parsing in a Worker it spawns locally, not a network call). The ONLY
 *    thing that leaves the browser afterward is the rebuilt, already-decrypted
 *    File, via the same upload path every other document already uses.
 *
 * Rebuilding "clean", and which of the two rebuilds runs:
 *
 *  1. LOSSLESS (primary, rebuildLosslessPdf below). @cantoo/pdf-lib parses
 *     the encrypted document with the password, decrypts the object streams
 *     in place, and re-serialises the SAME objects with no encryption. Page
 *     content streams, fonts and the text layer come through byte-for-byte;
 *     nothing is re-rendered. This runs first for every file.
 *  2. RASTERIZE (fallback, rebuildCleanPdf below). pdf.js renders each page
 *     to a canvas and jsPDF wraps the JPEGs into a new PDF. This is what
 *     shipped first, and it stays, because it can rebuild documents the
 *     lossless path cannot parse at all. It is strictly worse -- it throws
 *     the text layer away -- so it only runs when the lossless path throws
 *     or fails its own postcondition (see below).
 *
 * Why lossless is primary, measured rather than assumed: of the 51 reference
 * IEPs in docs/sample-ieps/, 48 are digital-native with a real text layer and
 * only 3 are paper scans (counted directly, by extracting text from each and
 * classifying on characters-per-page). Rasterizing a digital-native IEP
 * discards exact, machine-readable text and forces the pipeline to OCR a
 * picture of it instead. The cost concentrates in service-minute grids and
 * goals tables -- small type, dense rules, numbers that must be exact -- which
 * is the content a parent most needs correct. For 48 of 51 files, the rebuild
 * that shipped first was destroying the best version of the document it had.
 *
 * The lossless path's postcondition, and why it exists: decrypting with
 * @cantoo/pdf-lib leaves the ORIGINAL encryption dictionary and the original
 * cross-reference stream behind as orphaned objects. Nothing in the live
 * trailer points at them, and every conforming reader opens the result with
 * no password, but the stale xref stream still carries a literal
 * "/Encrypt 21 0 R" in its dictionary. Two things follow, and both are
 * handled in stripEncryptionResidue below rather than tolerated:
 *  - pdf-encryption.ts's byte scan would match that orphan and flag the
 *    rebuilt file as encrypted all over again, putting the parent in a
 *    prompt loop over a file that is already decrypted.
 *  - The old encryption dictionary's /O, /U, /OE and /UE entries are derived
 *    from the parent's password. Leaving them in place would upload
 *    password-derived material to the server for a password that never
 *    otherwise leaves the browser. That is the one way this feature could
 *    have leaked a password, and it would have leaked it into durable
 *    storage. They are stripped, and the test asserts they are gone.
 * After stripping, the output is checked against pdf-encryption.ts's own
 * ENCRYPT_ENTRY_PATTERN before it is accepted. A rebuild that still matches
 * is discarded and the rasterize path runs instead.
 *
 * REBUILD_TARGET_DPI, below, still governs that fallback. It was chosen from
 * a real measurement, not a guess: a page
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
import { ENCRYPT_ENTRY_PATTERN, readBlobAsArrayBuffer } from './pdf-encryption';
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
 * How much of `bytes` to convert to a string at a time when scanning for an
 * /Encrypt entry. Bounds peak memory: a 100MB upload would otherwise become
 * a 100M-character string just to run one regex over it.
 */
const ENCRYPT_SCAN_CHUNK_BYTES = 64 * 1024;

/**
 * The longest an /Encrypt entry can be ("/Encrypt" + whitespace + two
 * numbers + "R"). Consecutive scan chunks overlap by this much so an entry
 * that straddles a chunk boundary is still matched.
 */
const ENCRYPT_ENTRY_MAX_BYTES = 64;

/**
 * True if anywhere in `bytes` there is an /Encrypt entry of the shape
 * pdf-encryption.ts looks for. Deliberately scans the WHOLE buffer, not just
 * the tail that isLikelyEncryptedPdf reads: this is the postcondition on a
 * file this module built itself, so it should be the strict version.
 */
function containsEncryptEntry(bytes: Uint8Array): boolean {
  for (let start = 0; start < bytes.length; start += ENCRYPT_SCAN_CHUNK_BYTES) {
    const end = Math.min(bytes.length, start + ENCRYPT_SCAN_CHUNK_BYTES + ENCRYPT_ENTRY_MAX_BYTES);
    let chunk = '';
    for (let i = start; i < end; i++) {
      chunk += String.fromCharCode(bytes[i]);
    }
    if (ENCRYPT_ENTRY_PATTERN.test(chunk)) {
      return true;
    }
  }
  return false;
}

/**
 * Deletes the objects a decrypted document carries over from its encrypted
 * original: the standard security handler dictionary (whose /O, /U, /OE and
 * /UE are derived from the parent's password) and the superseded
 * cross-reference stream that still names it in an /Encrypt entry. See the
 * module docblock for why both have to go rather than being harmless.
 *
 * Nothing live points at either one -- the rewritten trailer references
 * neither -- so removing them cannot detach a page, a font or a content
 * stream.
 */
function stripEncryptionResidue(context: PdfLibContext, pdfLib: PdfLibModule): void {
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (isEncryptionResidue(object as PdfLibObject, pdfLib)) {
      context.delete(ref);
    }
  }
}

/** An object graph node as pdf-lib hands it back: either a dictionary, or a
 * stream wrapping one, or something pdf-lib could not parse (which is what a
 * cross-reference stream comes back as, and is exactly the case that matters
 * here). pdf-lib's own PDFObject type describes none of these members, since
 * which ones exist depends on which of those three a given object is, so the
 * shape is narrowed here to just what this module reads. */
interface PdfLibObject {
  dict?: { get?: (key: unknown) => unknown; has?: (key: unknown) => boolean };
  get?: (key: unknown) => unknown;
  has?: (key: unknown) => boolean;
  sizeInBytes?: () => number;
  copyBytesInto?: (target: Uint8Array, offset: number) => number;
}

type PdfLibModule = typeof import('@cantoo/pdf-lib');
type PdfLibContext = import('@cantoo/pdf-lib').PDFContext;

function isEncryptionResidue(object: PdfLibObject, { PDFName }: PdfLibModule): boolean {
  const dict = typeof object.get === 'function' ? object : object.dict;
  if (dict && typeof dict.get === 'function' && typeof dict.has === 'function') {
    // The standard security handler: /Filter /Standard plus the /V version
    // every revision of it carries. This is the dictionary holding the
    // password-derived hashes.
    if (String(dict.get(PDFName.of('Filter'))) === '/Standard' && dict.has(PDFName.of('V'))) {
      return true;
    }
    // A superseded cross-reference stream that pdf-lib DID parse.
    return String(dict.get(PDFName.of('Type'))) === '/XRef';
  }

  // No readable dictionary: an object pdf-lib kept verbatim because it could
  // not parse it, which is how a cross-reference stream normally arrives.
  // Only these get serialised, and only when small, so a multi-megabyte
  // image stream is never copied just to run a regex over it.
  if (typeof object.sizeInBytes !== 'function' || typeof object.copyBytesInto !== 'function') {
    return false;
  }
  const size = object.sizeInBytes();
  if (size > ENCRYPT_SCAN_CHUNK_BYTES) {
    return false;
  }
  const serialized = new Uint8Array(size);
  object.copyBytesInto(serialized, 0);
  return containsEncryptEntry(serialized);
}

/**
 * Strips encryption from a PDF while keeping its original page objects, so
 * the text layer survives: the primary rebuild path (see the module
 * docblock, including the 48-of-51 count behind that choice).
 *
 * Takes the raw bytes rather than pdf.js's already-open PDFDocumentProxy
 * because pdf.js cannot hand decrypted bytes back out, so this has to parse
 * the file a second time; and the password rather than a decrypted handle
 * for the same reason. Neither is retained: the password is used in the one
 * `load` call below and never stored, and nothing derived from it is written
 * into the returned File.
 *
 * Throws if the document cannot be parsed, reports no pages, or still looks
 * encrypted after the residue strip. Every one of those is a signal for the
 * caller to fall back to the rasterize path, not to give up on the file.
 */
async function rebuildLosslessPdf(bytes: Uint8Array, password: string, fileName: string): Promise<File> {
  const pdfLib = await import('@cantoo/pdf-lib');
  const pdfDocument = await pdfLib.PDFDocument.load(bytes, {
    password,
    // The file is a parent's real IEP, not something this app produced, so
    // it is likely to have at least one quirk pdf-lib would otherwise refuse
    // outright. Tolerate them: a document that renders in a viewer should
    // rebuild here, and anything genuinely unparseable still throws.
    throwOnInvalidObject: false,
    updateMetadata: false,
  });

  if (pdfDocument.getPageCount() === 0) {
    throw new Error('Decrypted PDF reported zero pages');
  }

  stripEncryptionResidue(pdfDocument.context, pdfLib);

  // A classic cross-reference table rather than an xref stream, so the
  // rebuilt file's own trailer is plain bytes that pdf-encryption.ts can
  // read the same way it reads every other upload.
  const rebuilt = await pdfDocument.save({ useObjectStreams: false });

  if (containsEncryptEntry(rebuilt)) {
    throw new Error('Rebuilt PDF still carries an /Encrypt entry');
  }
  return new File([rebuilt as BlobPart], fileName, { type: 'application/pdf' });
}

/**
 * Rasterizes every page of an already-opened, decrypted PDF and re-encodes
 * it as a new, unencrypted PDF: the FALLBACK rebuild, used only when
 * rebuildLosslessPdf could not handle the file (see the module docblock for
 * what it costs, and how REBUILD_TARGET_DPI was chosen).
 *
 * Takes no password, and must keep taking none. It cannot leak one it was
 * never given.
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
 * Rebuild: whichever password opened the file is handed to
 * rebuildLosslessPdf, which keeps the text layer. Only if that throws does
 * the rasterize fallback run, and the fallback is never given the password.
 * A file that needs the fallback still uploads; it just arrives as page
 * images, which is what every file did before the lossless path existed.
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
  // The password that actually opened the file, needed because the lossless
  // rebuild has to parse the document itself (see the module docblock). This
  // is the only binding it is ever held in, and the `finally` below clears
  // it on every exit, including a throw.
  let openedWith: string | null = null;
  try {
    const pdfjs = await loadPdfJs();
    // pdf.js transfers this buffer to its worker, which detaches it here, so
    // the lossless rebuild re-reads the file rather than reusing it.
    const bytes = new Uint8Array(await readBlobAsArrayBuffer(file));
    loadingTask = pdfjs.getDocument({ data: bytes });

    let triedEmptyPassword = false;
    let hasPromptedParent = false;
    loadingTask.onPassword = (updatePassword: (response: string | Error) => void) => {
      if (!triedEmptyPassword) {
        triedEmptyPassword = true;
        openedWith = '';
        updatePassword(''); // Silent step 1: the owner-restricted case.
        return;
      }
      // A real password is required: either the silent empty attempt above
      // was wrong, or a password the parent typed was wrong.
      const wrongPassword = hasPromptedParent;
      hasPromptedParent = true;
      requestPassword(wrongPassword).then(
        (password) => {
          // Whatever is recorded last is what the loading task settled on,
          // so a wrong guess is overwritten by the next attempt.
          openedWith = password;
          updatePassword(password === null ? new PdfPasswordCancelledError() : password);
        },
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

    return { status: 'resolved', file: await rebuildPdf(file, openedWith, pdfDocument) };
  } catch {
    return { status: 'failed' };
  } finally {
    openedWith = null;
    await loadingTask?.destroy();
  }
}

/**
 * Lossless first, rasterize only if that could not produce a file.
 *
 * The fallback is deliberately reached by catching rather than by testing
 * the document up front: "can @cantoo/pdf-lib rebuild this particular file"
 * has no cheaper answer than trying it, and a parent whose file only the
 * rasterize path can handle should still get their document. The caught
 * error is discarded rather than inspected or logged, like every other catch
 * in this module.
 */
async function rebuildPdf(
  file: File,
  password: string | null,
  pdfDocument: PDFDocumentProxy,
): Promise<File> {
  if (password !== null) {
    try {
      const bytes = new Uint8Array(await readBlobAsArrayBuffer(file));
      return await rebuildLosslessPdf(bytes, password, file.name);
    } catch {
      // Falls through to the rasterize path below.
    }
  }
  return rebuildCleanPdf(pdfDocument, file.name);
}
