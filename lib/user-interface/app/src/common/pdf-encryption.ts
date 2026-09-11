/**
 * A best-effort, dependency-free check for whether a PDF requires a password
 * to open, run entirely client-side before the file is ever uploaded.
 *
 * Why this exists: a parent uploaded a password-protected PDF to staging.
 * Mistral OCR rejected it with a 400 every time (see mistral_ocr/handler.py's
 * OcrClientError), so the parent got a generic "Processing Failed" screen
 * with a re-upload button that could never succeed for that file. Catching
 * this before the upload even starts turns an unfixable pipeline failure
 * into an actionable message at the moment the parent picked the file.
 *
 * How PDF encryption is actually signalled (consulted before writing this):
 * an encrypted PDF's file trailer -- or, for PDF 1.5+ files that use a
 * cross-reference STREAM instead of a classic `trailer` keyword, the xref
 * stream's own dictionary, which carries the same keys a trailer does --
 * contains an /Encrypt entry pointing at the encryption dictionary. That is
 * exactly what every conforming PDF reader keys off: "A Conforming Reader
 * determines if a PDF file is encrypted by ... looking at [the] Encrypt
 * entry in [the] Trailer dictionary" (per the ISO 32000 encryption model,
 * as summarised in community/vendor documentation of it), and it is exactly
 * the entry pdf.js's own getDocument() checks before it will ever fire its
 * onPassword callback. So /Encrypt is the right thing to look for, not e.g.
 * a heuristic over the file's readable text.
 *
 * pdf.js (or pdf-lib) would parse this properly and give a fully correct
 * answer, but neither is a dependency of this app: the only PDF-adjacent
 * package here is html2pdf.js (checked package.json), and it only ever
 * GENERATES a PDF from HTML, it never reads one. Given CLAUDE.md's "simplest
 * thing that works" and "no abstraction until the repetition is real", and
 * that this app has never needed to parse PDF structure until now, adding a
 * multi-hundred-KB parser to answer one boolean is not justified. This reads
 * raw bytes instead.
 *
 * Design, and its false-positive/false-negative tradeoffs:
 *
 * - Only the last PDF_TAIL_SCAN_BYTES of the file are read, via Blob.slice
 *   (which does not load the rest of the file into memory or over the
 *   wire). The trailer, or the cross-reference stream's dictionary, is by
 *   construction always near the physical end of a PDF: a conforming writer
 *   appends "...trailer <<...>> startxref <n> %%EOF" (or the xref-stream
 *   equivalent) after every other object, and does so again, further along,
 *   on every incremental update. So this window comfortably covers it while
 *   bounding how much of a (up to 100MB) upload this reads.
 *   A useful side effect: a PDF that WAS encrypted and was later re-saved
 *   without encryption has its stale /Encrypt only in an earlier, superseded
 *   trailer, outside this window, so it is correctly read as NOT encrypted --
 *   which is what the file will actually do when uploaded.
 * - The pattern requires /Encrypt to be followed by an indirect reference
 *   ("12 0 R") or an inline dictionary ("<<"), not just the bare substring.
 *   That is the only way the key legitimately appears in a trailer, so this
 *   rejects the (already-small, given the tail restriction above) chance of
 *   matching unrelated bytes elsewhere in the file.
 * - Known false positive: a PDF whose actual page content visibly displays
 *   the literal text "/Encrypt 12 0 R" (a document about the PDF spec, say)
 *   and happens to have that content inside the tail window would be read
 *   as encrypted when it is not. Not a realistic shape for a parent's IEP.
 * - Known, accepted false positive: a PDF with an empty USER password (opens
 *   with no prompt in a normal viewer) but an owner password restricting
 *   printing/copying is still, per spec, encrypted -- it still carries
 *   /Encrypt -- so this flags it even though the parent never saw a
 *   password dialog. That matches what actually happens next: Mistral
 *   rejects any /Encrypt file the same way regardless of which password is
 *   set, so this is not a false alarm from the pipeline's point of view,
 *   even though it can surprise a parent who did not know their PDF was
 *   restricted at all.
 * - Known false negative: a malformed or adversarially-crafted file could
 *   evade this. That is an accepted gap: it just means the file reaches the
 *   pipeline as it does today, which already fails it closed. This check
 *   only exists to skip an upload and a pipeline run for a failure that was
 *   already knowable client-side, not to replace the pipeline's own handling.
 *
 * Failure mode of the check itself: ANY error reading or scanning the file
 * (an unreadable file, a runtime without Blob.slice) resolves `false` --
 * "not detected as encrypted" -- rather than rejecting the file. A false
 * positive here denies a parent their document with no recourse in the app;
 * a false negative just reaches the pipeline's own, already-handled failure.
 * This fails open, not closed, deliberately the opposite of PII redaction
 * elsewhere in this app, because the consequence of being wrong runs the
 * other way: there is no student data at risk in a file we decline to flag.
 *
 * What happens to a file this flags is no longer "always refused": see
 * pdf-decrypt.ts. That module is what turns the known, accepted false
 * positive above (an empty-user-password / owner-restricted file) into a
 * silent, automatic fix instead of a dead end, and offers a password prompt
 * for a real user password before falling back to refusing the file, which
 * is the only thing this module has ever been able to do on its own.
 */

/**
 * How much of the file's tail to read. Generous relative to a real trailer
 * or xref-stream dictionary (typically well under 10KB even for large,
 * heavily-updated documents), so the margin is for safety, not because
 * larger is expected.
 */
const PDF_TAIL_SCAN_BYTES = 128 * 1024;

/**
 * /Encrypt followed by an indirect reference ("12 0 R") or an inline
 * dictionary ("<<"). A bare "/Encrypt" substring is deliberately not enough
 * to match: those two shapes are the only way the key legitimately appears.
 */
const ENCRYPT_ENTRY_PATTERN = /\/Encrypt\s+(?:\d+\s+\d+\s+R\b|<<)/;

/**
 * Byte value N -> char code N, i.e. an 8-bit-clean "binary string".
 *
 * Deliberately not `new TextDecoder('iso-8859-1')`: that label's legacy
 * single-byte support depends on the JS engine's bundled encoding data,
 * which is not guaranteed present in every runtime this might execute under
 * (a minimal-ICU Node build, for one). Every byte this module's pattern
 * cares about matching -- the ASCII making up "/Encrypt", digits, "R",
 * whitespace, "<<" -- sits below 0x80, where every single-byte encoding
 * agrees with a plain identity mapping, so the identity mapping is exactly
 * as correct here and has no such dependency.
 */
function bytesToBinaryString(bytes: Uint8Array): string {
  const CHUNK_SIZE = 8192; // keeps each String.fromCharCode call's argument count small
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_SIZE));
  }
  return result;
}

/**
 * Reads a Blob (here, always a tail slice of the chosen file) as an
 * ArrayBuffer via FileReader rather than the newer, promise-based
 * `Blob.prototype.arrayBuffer()`. Every evergreen browser ships both, so
 * this is not a browser-compatibility concern; FileReader is used because
 * it is also what this project's jsdom-based test environment (vitest,
 * jsdom 24) implements -- jsdom does not implement `Blob.arrayBuffer()` at
 * all, checked directly against this repo's installed version -- so this
 * keeps the function testable without a jsdom-version-specific workaround.
 *
 * Exported because pdf-decrypt.ts (the password-entry/rebuild flow this
 * module's detection feeds into) needs the exact same jsdom-safe read of a
 * whole File's bytes, not just a tail slice. One implementation, one reason.
 */
export function readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed to read the file'));
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * Resolves true if `file` looks like a password-protected/encrypted PDF.
 *
 * See the module docblock for how and why. Never rejects: any failure while
 * reading or scanning the file resolves false so a parent is never blocked
 * from uploading over a check that could not run.
 */
export async function isLikelyEncryptedPdf(file: File): Promise<boolean> {
  try {
    const tailStart = Math.max(0, file.size - PDF_TAIL_SCAN_BYTES);
    const tailBuffer = await readBlobAsArrayBuffer(file.slice(tailStart));
    const tailText = bytesToBinaryString(new Uint8Array(tailBuffer));
    return ENCRYPT_ENTRY_PATTERN.test(tailText);
  } catch {
    return false;
  }
}
