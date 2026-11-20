/**
 * One queue of survey saves per child, so they reach the server in the order
 * they were made, and a read of the survey waits for the saves before it.
 *
 * The survey saves what a parent answered when they leave the page (the
 * bottom nav, the child switcher), and that save is still in flight when they
 * come back. A read that overtook it would show the answers from before, and
 * the next save would write those over the ones just kept. Likewise a save
 * made on a timer must not land after "Next" and move the parent back a part.
 */
const queues = new Map<string, Promise<unknown>>();

/**
 * The longest a read waits for saves ahead of it. A save that never answers
 * must not leave the survey on its loading screen for good; past this the
 * read goes ahead, and the worst case is the answers from before.
 */
export const SAVES_WAIT_MAX_MS = 5_000;

/** Runs `save` after every save already queued for this child. Rejects as `save` does. */
export const queueSurveySave = <T>(childId: string, save: () => Promise<T>): Promise<T> => {
  const previous = queues.get(childId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(save);
  queues.set(childId, next);
  return next;
};

/**
 * Resolves once every save queued so far for this child has finished, whether
 * or not it worked, or after SAVES_WAIT_MAX_MS, whichever is first.
 */
export const surveySavesSettled = (childId: string): Promise<void> => {
  const pending = queues.get(childId);
  if (!pending) return Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => { timer = setTimeout(resolve, SAVES_WAIT_MAX_MS); });
  const settled = pending.then(() => undefined, () => undefined);
  return Promise.race([settled, cap]).finally(() => clearTimeout(timer));
};
