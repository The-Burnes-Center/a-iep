// Pure decision logic for the document-failure screen, kept out of
// DocumentFailureState.tsx so it is testable without rendering anything.
//
// Today the backend never populates IEPDocument.failureReason (see the field's
// own comment in common/types.ts): a FAILED document's DynamoDB row carries a
// raw provider error_message ("OCR processing failed: 400 Client Error"),
// which is not safe or useful to show a parent and is not sent to the
// frontend at all. So the only thing actually knowable today is the status
// itself, and the honest default is to offer a retry — we have no evidence
// it would fail again.
//
// KNOWN_PERMANENT_FAILURE_REASONS is the seam for when that changes. Nothing
// populates failureReason yet, so this set is never consulted by real traffic;
// it exists so that the day the backend maps a cause the pipeline already
// knows (failed_step / error_message) to one of these strings, the retry
// button turns itself off with no other frontend change. 'password_protected'
// is listed as the first candidate because it is the concrete failure this
// redesign was written around, even though a separate client-side check now
// catches most of those before upload ever starts.
const KNOWN_PERMANENT_FAILURE_REASONS = new Set<string>([
  'password_protected',
]);

export interface FailedDocumentLike {
  status?: string;
  failureReason?: string;
}

/**
 * Whether the failure screen should invite the parent to try again.
 *
 * false whenever the reason is one we positively know will not change on a
 * second attempt. true otherwise — including every reason we do not yet
 * recognize — because refusing retry by default would turn "we don't know
 * the cause" into a second dead end, the exact defect this screen replaces.
 * Adding a new permanent cause here (and its own copy — see
 * DocumentFailureState) is what narrows that default as real causes are
 * learned.
 */
export const canRetryFailedDocument = (document: FailedDocumentLike): boolean => {
  if (!document.failureReason) return true;
  return !KNOWN_PERMANENT_FAILURE_REASONS.has(document.failureReason);
};
