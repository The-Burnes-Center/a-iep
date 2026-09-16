/**
 * isLikelyEncryptedPdf is the client-side gate that refuses a password-
 * protected PDF before it ever reaches the upload button: see the module
 * docblock in pdf-encryption.ts for how /Encrypt in the trailer signals
 * encryption and why a raw byte scan is used instead of a PDF-parsing
 * dependency.
 */
import { describe, expect, test } from "vitest";
import { isLikelyEncryptedPdf } from "./pdf-encryption";

const pdfFile = (content: string): File =>
  new File([content], "iep.pdf", { type: "application/pdf" });

describe("isLikelyEncryptedPdf", () => {
  test("detects the indirect-reference form of /Encrypt in the trailer", async () => {
    const file = pdfFile(
      "%PDF-1.4\n" +
        "1 0 obj << /Type /Catalog >> endobj\n" +
        "trailer\n" +
        "<< /Size 4 /Root 1 0 R /Encrypt 3 0 R /ID [<a><b>] >>\n" +
        "startxref\n0\n%%EOF",
    );
    await expect(isLikelyEncryptedPdf(file)).resolves.toBe(true);
  });

  test("detects the inline-dictionary form of /Encrypt", async () => {
    const file = pdfFile(
      "%PDF-1.4\ntrailer\n" +
        "<< /Size 2 /Root 1 0 R /Encrypt << /Filter /Standard /V 2 >> >>\n" +
        "startxref\n0\n%%EOF",
    );
    await expect(isLikelyEncryptedPdf(file)).resolves.toBe(true);
  });

  test("an ordinary, unencrypted trailer is not flagged", async () => {
    const file = pdfFile(
      "%PDF-1.4\n" +
        "1 0 obj << /Type /Catalog >> endobj\n" +
        "trailer\n" +
        "<< /Size 4 /Root 1 0 R /ID [<a><b>] >>\n" +
        "startxref\n0\n%%EOF",
    );
    await expect(isLikelyEncryptedPdf(file)).resolves.toBe(false);
  });

  // /EncryptMetadata is a real, common key inside an encryption dictionary
  // (whether to also encrypt document metadata). It must not be confused
  // with the /Encrypt trailer key itself: "Encrypt" is immediately followed
  // by "Metadata", not by whitespace, so the pattern's \s+ correctly refuses
  // to match here.
  test("does not confuse /EncryptMetadata with the /Encrypt trailer key", async () => {
    const file = pdfFile(
      "%PDF-1.4\ntrailer\n<< /Size 2 /Root 1 0 R /EncryptMetadata false >>\nstartxref\n0\n%%EOF",
    );
    await expect(isLikelyEncryptedPdf(file)).resolves.toBe(false);
  });

  // Documents the intentional scope of the tail-only scan (see the module
  // docblock): text that merely looks like a trailer's /Encrypt entry, but
  // sits far from the physical end of a large file, is out of scope. A real
  // trailer is never out there, so this is a deliberate boundary, not a gap.
  test("only scans the file's tail: matching text far from the end is out of scope by design", async () => {
    const encryptLookingButNotATrailer = "%PDF-1.4\n/Encrypt 3 0 R (just body text, not a trailer)\n";
    const padding = "x".repeat(200 * 1024);
    const cleanTrailer = "\ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n0\n%%EOF";
    const file = pdfFile(encryptLookingButNotATrailer + padding + cleanTrailer);
    await expect(isLikelyEncryptedPdf(file)).resolves.toBe(false);
  });

  // Fail-open is the whole point: a parent must never be blocked from
  // uploading because this check itself broke.
  test("fails open when slice() throws", async () => {
    const brokenFile = {
      size: 100,
      slice: () => {
        throw new Error("boom");
      },
    } as unknown as File;
    await expect(isLikelyEncryptedPdf(brokenFile)).resolves.toBe(false);
  });

  test("fails open when arrayBuffer() rejects", async () => {
    const brokenFile = {
      size: 100,
      slice: () => ({
        arrayBuffer: () => Promise.reject(new Error("boom")),
      }),
    } as unknown as File;
    await expect(isLikelyEncryptedPdf(brokenFile)).resolves.toBe(false);
  });
});
