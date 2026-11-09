/**
 * What My children says about one child's IEP, from the documents API answer.
 *
 * Kept apart from the screen so every answer the API can give maps to exactly
 * one state, and each state is tested on its own.
 */

export type ChildDocumentState = 'ready' | 'reading' | 'failed' | 'none' | 'unknown';

/** Shown as "No IEP yet" with an upload button. */
const NO_DOCUMENT_MESSAGE = 'No document found for this child';

/** Statuses the pipeline is still working through. */
const IN_PROGRESS = new Set(['PROCESSING', 'PROCESSING_TRANSLATIONS', 'PENDING_UPLOAD']);

export const childDocumentState = (
  answer: { status?: string; message?: string } | null | undefined,
  failedToLoad: boolean,
): ChildDocumentState => {
  if (failedToLoad) return 'unknown';
  if (!answer || answer.message === NO_DOCUMENT_MESSAGE) return 'none';
  if (answer.status === 'PROCESSED') return 'ready';
  if (answer.status === 'FAILED') return 'failed';
  // A missing status is shown as processing everywhere else in the app
  // (_display_status in user-profile-handler), so it is here too.
  if (!answer.status || IN_PROGRESS.has(answer.status)) return 'reading';
  return 'unknown';
};

/** The most children one account holds (MAX_CHILDREN in user-profile-handler). */
export const MAX_CHILDREN = 10;
