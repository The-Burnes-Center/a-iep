/**
 * canRetryFailedDocument is the one decision behind "only offer re-upload
 * where retrying could actually work" (see DocumentFailureState). The
 * backend does not send a structured failure reason yet — every FAILED
 * document today reaches here with failureReason undefined — so these tests
 * pin both today's default (retry offered) and the seam for when a reason
 * does arrive.
 */
import { describe, expect, test } from "vitest";
import { canRetryFailedDocument } from "./document-failure";

describe("canRetryFailedDocument", () => {
  test("offers retry for a failed document with no known reason (today's only real case)", () => {
    expect(canRetryFailedDocument({ status: "FAILED" })).toBe(true);
  });

  test("offers retry when the reason is one it does not recognize", () => {
    // Fails open on purpose: refusing retry for every unrecognized reason
    // would turn "we don't know the cause" into a second dead end, which is
    // the defect this screen replaces.
    expect(
      canRetryFailedDocument({ status: "FAILED", failureReason: "some_future_reason" }),
    ).toBe(true);
  });

  test("refuses retry for a reason known to fail identically every time", () => {
    expect(
      canRetryFailedDocument({ status: "FAILED", failureReason: "password_protected" }),
    ).toBe(false);
  });
});
