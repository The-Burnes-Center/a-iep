/**
 * Pure decision logic for the summary page's on-demand translation flow: which
 * languages the picker offers, whether to offer generating a missing
 * translation, and what an HTTP answer from the translations endpoint means for
 * the UI.
 *
 * No React, no fetch, no i18n lookups. Every function maps plain inputs to a
 * phase plus an i18n KEY, so the whole state machine is unit-testable and the
 * server's own (deliberately generic) error strings never reach a parent.
 *
 * Written as plain ESM JavaScript with a hand-written `translation-flow.d.mts`
 * beside it, on purpose, and with these exact extensions:
 *
 *  - not .ts, because jest here has no frontend project — `lambdas` is node-env
 *    with no TypeScript transform and only matches *.test.js / *.test.mjs — so a
 *    .ts module could not be unit tested at all today.
 *  - .mjs and .d.mts rather than .js and .d.ts, because .gitignore blanket-
 *    ignores those two extensions as compiled TS twins. A .js module here would
 *    be silently untracked: the build would work locally and fail in CI.
 *
 * The two files are a pair: change one, change the other.
 *
 * Tested by test/lambdas/summary-page/translation-flow.test.mjs.
 */

/**
 * The status an add-on translation runs at. Written in exactly one place,
 * _claim_translation_slot in translation-request-handler: the upload pipeline
 * goes PROCESSING then PROCESSED and never uses this. That single writer is
 * what lets resumeTranslationRequest below trust the status on its own.
 */
const IN_FLIGHT_TRANSLATION_STATUS = 'PROCESSING_TRANSLATIONS';

/** Statuses that mean the pipeline still has work in flight for a document. */
const PROCESSING_STATUSES = ['PROCESSING', IN_FLIGHT_TRANSLATION_STATUS];

/** Nothing requested: the banner offers the button and shows no progress. */
export const idleTranslationRequest = () => ({
  phase: 'idle',
  language: null,
  messageKey: null,
});

/**
 * Whether the document poller should keep running.
 *
 * `forcePolling` exists for the on-demand path: requesting a translation flips
 * the document back to PROCESSING_TRANSLATIONS server-side, but the read that
 * immediately follows can still come back PROCESSED, and a poller that never
 * started would leave the parent watching a progress bar forever.
 */
export const shouldPollForUpdates = (status, forcePolling = false) =>
  Boolean(forcePolling) || PROCESSING_STATUSES.includes(status);

/**
 * Annotate every enabled language with whether this document already has it.
 *
 * Untranslated languages stay in the list instead of being hidden: a parent has
 * to be able to pick their language to be offered a translation of it.
 */
export const buildLanguageMenuOptions = (enabledOptions, translatedLanguages) => {
  const translated = new Set(translatedLanguages ?? []);
  return (enabledOptions ?? []).map((option) => ({
    ...option,
    isTranslated: translated.has(option.value),
  }));
};

/**
 * Whether to offer generating the translation the parent is missing.
 *
 * The pipeline translates FROM the English summary, so with no English content
 * there is nothing to translate and the offer would only fail (409).
 */
export const shouldOfferTranslation = ({
  documentStatus,
  preferredLanguage,
  translatedLanguages,
}) => {
  if (documentStatus === 'FAILED') return false;
  if (!preferredLanguage || preferredLanguage === 'en') return false;

  const translated = new Set(translatedLanguages ?? []);
  if (!translated.has('en')) return false;

  return !translated.has(preferredLanguage);
};

/**
 * Map the endpoint's HTTP status onto the UI state. `httpStatus` 0 stands for a
 * network failure or any other throw with no status attached.
 *
 * 200 (already translated) and 409 (already in flight) are progress, not
 * errors: in both cases the content is on its way and polling will land it.
 */
export const mapTranslationResponse = ({ httpStatus }) => {
  switch (httpStatus) {
    case 202:
      return { phase: 'running', messageKey: 'summary.processing.almostThere' };
    case 200:
      return { phase: 'running', messageKey: 'summary.translate.alreadyReady' };
    case 409:
      return { phase: 'running', messageKey: 'summary.translate.alreadyRunning' };
    case 400:
      return { phase: 'failed', messageKey: 'summary.translate.error.language' };
    case 403:
      return { phase: 'failed', messageKey: 'summary.translate.error.notAllowed' };
    case 404:
      return { phase: 'failed', messageKey: 'summary.translate.error.notFound' };
    case 429:
      // The per-document attempt budget in translation-request-handler. Its own
      // key, not the generic one: every paid retry for this document is spent,
      // so "try again" is the one thing that will not help.
      return { phase: 'failed', messageKey: 'summary.translate.error.budgetSpent' };
    default:
      return { phase: 'failed', messageKey: 'summary.translate.error.generic' };
  }
};

/** A request we started and are still waiting on. */
export const isTranslationInFlight = (phase) =>
  phase === 'requesting' || phase === 'running';

/**
 * Reconstruct in-flight request state from the document, for a page that has
 * none of its own.
 *
 * The request state used to live ONLY in the summary page's useState, and the
 * bottom nav is a route change, so tapping Account and coming back unmounted
 * the page and reset it to idle. The backend kept working and the content did
 * eventually appear, but for the rest of the wait the parent got the "Translate
 * it now" button back as if they had never pressed it, the arrival neither
 * switched them onto their language nor announced itself, and a run that FAILED
 * showed nothing at all. Every one of those is gated on the phase, so every one
 * of them died with the unmount.
 *
 * The document already carries enough to rebuild it, so the server is the
 * source of truth here and the local phase is only the optimistic window before
 * the next read catches up. Same rule, and the same reason, as
 * shouldSuppressProcessingTakeover above.
 *
 * The status alone is the signal, and that is exact rather than lucky:
 * PROCESSING_TRANSLATIONS has exactly one writer, translation-request-handler's
 * _claim_translation_slot. The upload pipeline never uses it — iep-processing
 * writes PROCESSING throughout and then PROCESSED — so a document sitting at
 * this status can only be one a parent asked for. `current_step` is
 * deliberately NOT also required: the two are written by the same UpdateItem
 * today, so it would add nothing, and it would silently stop resuming (with no
 * failing test) the day the state machine records an intermediate step.
 *
 * The requested language is not stored server-side and does not need to be: the
 * handler only ever translates the parent's own preferred language.
 *
 * Returns null when nothing is in flight for this parent, which includes the
 * case where their language has already landed.
 */
export const resumeTranslationRequest = ({
  documentStatus,
  preferredLanguage,
  translatedLanguages,
}) => {
  if (documentStatus !== IN_FLIGHT_TRANSLATION_STATUS) return null;
  if (!preferredLanguage || preferredLanguage === 'en') return null;
  if ((translatedLanguages ?? []).includes(preferredLanguage)) return null;

  return {
    phase: 'running',
    language: preferredLanguage,
    // Not the 202's "starting" wording: a parent arriving back at this page did
    // not just press anything, and this message says the work is already under
    // way and roughly how long it takes.
    messageKey: 'summary.translate.alreadyRunning',
  };
};

/**
 * Whether to keep the full-screen processing takeover away.
 *
 * An on-demand translation puts the document back into
 * PROCESSING_TRANSLATIONS, which normally means "the upload pipeline is still
 * running" and hides the page behind ProcessingModal. Here the parent already
 * has readable English content in front of them, so the progress belongs inline
 * in the banner and the takeover would only take that content away.
 */
export const shouldSuppressProcessingTakeover = ({
  documentStatus,
  hasEnglishContent,
}) =>
  // Deliberately NOT conditioned on a request being in flight in this tab.
  // PROCESSING_TRANSLATIONS is only ever written for an already-processed
  // document, so English content exists and hiding it behind a full-screen
  // spinner is never the right answer. Requiring an in-flight phase meant a
  // parent who reloaded, or came back to the tab, lost the summary they were
  // reading for the rest of the translation.
  documentStatus === IN_FLIGHT_TRANSLATION_STATUS &&
  Boolean(hasEnglishContent);

/**
 * The translation the parent asked for has arrived: take them to it.
 *
 * Waits for a PROCESSED document, not merely for the first content in that
 * language to appear. Two reasons: the translated sections are only normalized
 * once the document is PROCESSED, so an earlier switch lands the parent on a
 * half-empty pane; and the caller ends the request here, which would drop the
 * takeover suppression above while the status still said
 * PROCESSING_TRANSLATIONS — hiding the very translation we just switched to.
 */
export const isRequestedTranslationReady = ({
  phase,
  language,
  documentStatus,
  translatedLanguages,
}) => {
  if (phase !== 'running' || !language) return false;
  if (documentStatus !== 'PROCESSED') return false;
  return (translatedLanguages ?? []).includes(language);
};

/**
 * The current_step the single-language translation state machine writes when it
 * finishes without producing the language (lib/chatbot-api/state-machines/
 * single-language-translation.asl.json, RecordTranslationFailure).
 */
export const TRANSLATION_FAILED_STEP = 'translation_failed';

/**
 * The translation the parent asked for finished and did NOT produce a language.
 *
 * The backend cannot signal this through `status`: a failed add-on translation
 * deliberately leaves the document PROCESSED, because the parent still has
 * perfectly good English content and marking it FAILED would hide that behind
 * an error screen. The state machine records the outcome in `current_step`
 * instead, so this is the only way the UI can tell "finished, failed" from
 * "still working". Without it the parent watches a progress bar until the
 * caller's timeout backstop fires many minutes later.
 *
 * Safe against a STALE marker from an earlier failed attempt: a fresh request
 * moves the document to PROCESSING_TRANSLATIONS before the machine starts, so
 * the PROCESSED check below cannot see the old step while a new run is in
 * flight, and a successful run overwrites it with 'completed'.
 */
export const hasRequestedTranslationFailed = ({
  phase,
  language,
  documentStatus,
  currentStep,
  translatedLanguages,
}) => {
  if (phase !== 'running' || !language) return false;
  if (documentStatus !== 'PROCESSED') return false;
  if (currentStep !== TRANSLATION_FAILED_STEP) return false;
  // If the language did arrive, believe the content over the marker.
  return !(translatedLanguages ?? []).includes(language);
};
