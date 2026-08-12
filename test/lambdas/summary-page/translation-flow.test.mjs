/**
 * Unit tests for the summary page's on-demand translation decision logic
 * (lib/user-interface/app/src/pages/utils/translation-flow.mjs).
 *
 * Why this lives under test/lambdas: that is the only jest project in this repo
 * that can run it. `lambdas` is node-env and matches *.test.js / *.test.mjs with
 * no TypeScript transform, and the module under test is deliberately plain ESM
 * JavaScript for exactly that reason (see its header). A dedicated `frontend`
 * jest project would be the tidier home — jest.config.js is owned elsewhere.
 *
 * The behaviour this pins is what a parent sees when their IEP has no
 * translation in their language: whether we offer to make one, whether the
 * full-screen processing takeover is allowed to hide the English content they
 * can already read, and which message a 4xx turns into (never the server's own
 * string, which is generic by design).
 */
import {
  buildLanguageMenuOptions,
  hasRequestedTranslationFailed,
  idleTranslationRequest,
  isRequestedTranslationReady,
  isTranslationInFlight,
  mapTranslationResponse,
  resumeTranslationRequest,
  shouldOfferTranslation,
  shouldPollForUpdates,
  shouldSuppressProcessingTakeover,
} from '../../../lib/user-interface/app/src/pages/utils/translation-flow.mjs';

const ENABLED = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'zh', label: '中文' },
];

describe('idleTranslationRequest', () => {
  test('starts with no language, no message and nothing in flight', () => {
    const state = idleTranslationRequest();

    expect(state).toEqual({ phase: 'idle', language: null, messageKey: null });
    expect(isTranslationInFlight(state.phase)).toBe(false);
  });

  test('returns a fresh object each call so state is never shared', () => {
    expect(idleTranslationRequest()).not.toBe(idleTranslationRequest());
  });
});

describe('buildLanguageMenuOptions', () => {
  test('keeps untranslated languages in the menu and flags them', () => {
    const options = buildLanguageMenuOptions(ENABLED, ['en', 'es']);

    expect(options.map((o) => o.value)).toEqual(['en', 'es', 'zh']);
    expect(options.map((o) => o.isTranslated)).toEqual([true, true, false]);
  });

  test('carries the original option fields through untouched', () => {
    const [english] = buildLanguageMenuOptions(ENABLED, ['en']);

    expect(english.label).toBe('English');
  });

  test('does not mutate the options it was given', () => {
    buildLanguageMenuOptions(ENABLED, ['en']);

    expect(ENABLED[0]).toEqual({ value: 'en', label: 'English' });
  });

  test('a document with nothing translated still offers every language', () => {
    const options = buildLanguageMenuOptions(ENABLED, []);

    expect(options).toHaveLength(3);
    expect(options.every((o) => o.isTranslated === false)).toBe(true);
  });

  test('missing inputs degrade to an empty menu rather than throwing', () => {
    expect(buildLanguageMenuOptions(undefined, undefined)).toEqual([]);
    expect(buildLanguageMenuOptions(null, null)).toEqual([]);
  });
});

describe('shouldOfferTranslation', () => {
  test('offers when English is there and the preferred language is not', () => {
    expect(
      shouldOfferTranslation({
        documentStatus: 'PROCESSED',
        preferredLanguage: 'es',
        translatedLanguages: ['en'],
      }),
    ).toBe(true);
  });

  test('stays quiet once the preferred language has content', () => {
    expect(
      shouldOfferTranslation({
        documentStatus: 'PROCESSED',
        preferredLanguage: 'es',
        translatedLanguages: ['en', 'es'],
      }),
    ).toBe(false);
  });

  test('does not offer with no English content: there is nothing to translate', () => {
    expect(
      shouldOfferTranslation({
        documentStatus: 'PROCESSED',
        preferredLanguage: 'es',
        translatedLanguages: [],
      }),
    ).toBe(false);
  });

  test('does not offer to an English-preferring parent', () => {
    expect(
      shouldOfferTranslation({
        documentStatus: 'PROCESSED',
        preferredLanguage: 'en',
        translatedLanguages: ['en'],
      }),
    ).toBe(false);
  });

  test('does not offer on a failed document', () => {
    expect(
      shouldOfferTranslation({
        documentStatus: 'FAILED',
        preferredLanguage: 'es',
        translatedLanguages: ['en'],
      }),
    ).toBe(false);
  });

  test('missing preferred language is not an offer', () => {
    expect(
      shouldOfferTranslation({
        documentStatus: 'PROCESSED',
        preferredLanguage: undefined,
        translatedLanguages: ['en'],
      }),
    ).toBe(false);
  });
});

describe('mapTranslationResponse', () => {
  test('202 starts the inline progress state', () => {
    expect(mapTranslationResponse({ httpStatus: 202 })).toEqual({
      phase: 'running',
      messageKey: 'summary.processing.almostThere',
    });
  });

  test('200 (already translated) is progress, not an error', () => {
    expect(mapTranslationResponse({ httpStatus: 200 })).toEqual({
      phase: 'running',
      messageKey: 'summary.translate.alreadyReady',
    });
  });

  test('409 (already in flight) is progress, not an error', () => {
    expect(mapTranslationResponse({ httpStatus: 409 })).toEqual({
      phase: 'running',
      messageKey: 'summary.translate.alreadyRunning',
    });
  });

  test.each([
    [400, 'summary.translate.error.language'],
    [403, 'summary.translate.error.notAllowed'],
    [404, 'summary.translate.error.notFound'],
    [500, 'summary.translate.error.generic'],
    [0, 'summary.translate.error.generic'],
  ])('%i fails with its own message key', (httpStatus, messageKey) => {
    expect(mapTranslationResponse({ httpStatus })).toEqual({
      phase: 'failed',
      messageKey,
    });
  });

  test('every outcome is an i18n key, never server prose', () => {
    for (const httpStatus of [200, 202, 400, 403, 404, 409, 500, 0]) {
      const { messageKey } = mapTranslationResponse({ httpStatus });
      expect(messageKey).toMatch(/^summary\.[a-zA-Z.]+$/);
    }
  });
});

describe('shouldSuppressProcessingTakeover', () => {
  test('keeps the English content visible while our request runs', () => {
    expect(
      shouldSuppressProcessingTakeover({
        phase: 'running',
        documentStatus: 'PROCESSING_TRANSLATIONS',
        hasEnglishContent: true,
      }),
    ).toBe(true);
  });

  test('also suppresses between the click and the answer', () => {
    expect(
      shouldSuppressProcessingTakeover({
        phase: 'requesting',
        documentStatus: 'PROCESSING_TRANSLATIONS',
        hasEnglishContent: true,
      }),
    ).toBe(true);
  });

  test('a first upload still gets the full-screen processing screen', () => {
    // This test previously used PROCESSING_TRANSLATIONS to stand in for a first
    // upload, which was never reachable: the pipeline writes PROCESSING then
    // PROCESSED, and PROCESSING_TRANSLATIONS is written only by the on-demand
    // endpoint, against a document that already has content. The invariant it
    // meant to protect is the real one below -- a document still being parsed
    // has nothing to show, so the takeover is correct.
    expect(
      shouldSuppressProcessingTakeover({
        documentStatus: 'PROCESSING',
        hasEnglishContent: false,
      }),
    ).toBe(false);
  });

  test('a reload mid-translation keeps the English content on screen', () => {
    // REGRESSION. Suppression used to require a request in flight in THIS tab,
    // so reloading (or leaving and returning) during a translation dropped the
    // parent back behind the full-screen spinner and hid the summary they were
    // reading, for the rest of a minutes-long job.
    expect(
      shouldSuppressProcessingTakeover({
        documentStatus: 'PROCESSING_TRANSLATIONS',
        hasEnglishContent: true,
      }),
    ).toBe(true);
  });

  test('never suppresses the OCR phase, where there is nothing to read yet', () => {
    expect(
      shouldSuppressProcessingTakeover({
        phase: 'running',
        documentStatus: 'PROCESSING',
        hasEnglishContent: false,
      }),
    ).toBe(false);
  });

  test('never suppresses when there is no English content to keep on screen', () => {
    expect(
      shouldSuppressProcessingTakeover({
        phase: 'running',
        documentStatus: 'PROCESSING_TRANSLATIONS',
        hasEnglishContent: false,
      }),
    ).toBe(false);
  });
});

describe('resumeTranslationRequest', () => {
  // REGRESSION. The request state lived only in the summary page's useState,
  // and the bottom nav is a route change, so leaving for Account and coming
  // back unmounted the page and reset it to idle. The translation kept running
  // and the content did land, but the progress bar was gone for the rest of the
  // wait, the "Translate it now" button came back as though nothing had been
  // pressed, the arrival never switched the parent onto their language or said
  // anything, and a run that failed produced no message at all.

  const RESUMED = {
    phase: 'running',
    language: 'es',
    messageKey: 'summary.translate.alreadyRunning',
  };

  test('rebuilds a running request from the document alone', () => {
    expect(
      resumeTranslationRequest({
        documentStatus: 'PROCESSING_TRANSLATIONS',
        preferredLanguage: 'es',
        translatedLanguages: ['en'],
      }),
    ).toEqual(RESUMED);
  });

  test('what it rebuilds is in flight, so the whole wait comes back with it', () => {
    // The progress bar, forcePolling, the picker lock, the arrival switch, the
    // failure message and the timeout backstop all read the phase. Pinning it
    // here is what says the resumed state drives them and not just the bar.
    const resumed = resumeTranslationRequest({
      documentStatus: 'PROCESSING_TRANSLATIONS',
      preferredLanguage: 'es',
      translatedLanguages: ['en'],
    });

    expect(isTranslationInFlight(resumed.phase)).toBe(true);
    // forcePolling is exactly isTranslationInFlight(phase), so a resumed
    // request keeps the poller running even if the next read lags back to
    // PROCESSED — which is the one way the page could still strand a parent.
    expect(shouldPollForUpdates('PROCESSED', isTranslationInFlight(resumed.phase))).toBe(true);
    expect(
      isRequestedTranslationReady({
        ...resumed,
        documentStatus: 'PROCESSED',
        translatedLanguages: ['en', 'es'],
      }),
    ).toBe(true);
    expect(
      hasRequestedTranslationFailed({
        ...resumed,
        documentStatus: 'PROCESSED',
        currentStep: 'translation_failed',
        translatedLanguages: ['en'],
      }),
    ).toBe(true);
  });

  test('says the work is already under way, not that it is starting', () => {
    // A parent arriving back at this page did not just press anything, so the
    // 202's "Starting the translation..." would be a small lie about what
    // happened and about how much longer it will take.
    const resumed = resumeTranslationRequest({
      documentStatus: 'PROCESSING_TRANSLATIONS',
      preferredLanguage: 'es',
      translatedLanguages: ['en'],
    });

    expect(resumed.messageKey).toBe('summary.translate.alreadyRunning');
    expect(resumed.messageKey).not.toBe(
      mapTranslationResponse({ httpStatus: 202 }).messageKey,
    );
  });

  test('nothing to resume once the translation has landed', () => {
    // Otherwise the page would re-adopt a running phase immediately after the
    // arrival effect cleared it, and spin on a document that is finished.
    expect(
      resumeTranslationRequest({
        documentStatus: 'PROCESSING_TRANSLATIONS',
        preferredLanguage: 'es',
        translatedLanguages: ['en', 'es'],
      }),
    ).toBeNull();
  });

  test.each([
    ['PROCESSED', 'a finished document'],
    ['PROCESSING', 'a first upload still being parsed'],
    ['FAILED', 'a document that failed outright'],
    [undefined, 'a document with no status yet'],
  ])('%s is not a translation in flight (%s)', (documentStatus) => {
    expect(
      resumeTranslationRequest({
        documentStatus,
        preferredLanguage: 'es',
        translatedLanguages: ['en'],
      }),
    ).toBeNull();
  });

  test('PROCESSING_TRANSLATIONS can only be a request this parent made', () => {
    // Load-bearing assumption, written down so it is checked rather than
    // remembered: the upload pipeline (iep-processing.asl.json) writes
    // PROCESSING throughout and then PROCESSED, and _claim_translation_slot in
    // translation-request-handler is the only writer of this status anywhere.
    // That single writer is why the status alone is enough to resume, with no
    // need to also match current_step.
    expect(shouldPollForUpdates('PROCESSING_TRANSLATIONS')).toBe(true);
    expect(
      resumeTranslationRequest({
        documentStatus: 'PROCESSING_TRANSLATIONS',
        preferredLanguage: 'es',
        translatedLanguages: ['en'],
      }),
    ).not.toBeNull();
  });

  test.each([
    ['en', 'an English-preferring parent has nothing to translate'],
    [null, 'no preference loaded yet'],
    [undefined, 'no profile at all'],
    ['', 'an empty preference'],
  ])('%s resumes nothing (%s)', (preferredLanguage) => {
    expect(
      resumeTranslationRequest({
        documentStatus: 'PROCESSING_TRANSLATIONS',
        preferredLanguage,
        translatedLanguages: ['en'],
      }),
    ).toBeNull();
  });

  test('survives a document with no translated languages recorded', () => {
    expect(
      resumeTranslationRequest({
        documentStatus: 'PROCESSING_TRANSLATIONS',
        preferredLanguage: 'es',
        translatedLanguages: null,
      }),
    ).toEqual(RESUMED);
  });

  test('agrees with the takeover rule about the same document', () => {
    // Both answer "is a translation running for a document the parent can
    // already read", and disagreeing would put the progress bar behind the
    // full-screen spinner it is meant to replace.
    const document = { documentStatus: 'PROCESSING_TRANSLATIONS' };

    expect(
      shouldSuppressProcessingTakeover({ ...document, hasEnglishContent: true }),
    ).toBe(true);
    expect(
      resumeTranslationRequest({
        ...document,
        preferredLanguage: 'es',
        translatedLanguages: ['en'],
      }),
    ).not.toBeNull();
  });
});

describe('shouldPollForUpdates', () => {
  test('polls through both pipeline statuses', () => {
    expect(shouldPollForUpdates('PROCESSING')).toBe(true);
    expect(shouldPollForUpdates('PROCESSING_TRANSLATIONS')).toBe(true);
  });

  test('stops on a terminal status', () => {
    expect(shouldPollForUpdates('PROCESSED')).toBe(false);
    expect(shouldPollForUpdates('FAILED')).toBe(false);
    expect(shouldPollForUpdates(undefined)).toBe(false);
  });

  test('keeps polling a PROCESSED read while a translation is in flight', () => {
    // The status write can lag the 202, and a poller that never started would
    // leave the parent on a progress bar that never finishes.
    expect(shouldPollForUpdates('PROCESSED', true)).toBe(true);
    expect(shouldPollForUpdates(undefined, true)).toBe(true);
  });
});

describe('isRequestedTranslationReady', () => {
  test('ready once the requested language has content on a processed document', () => {
    expect(
      isRequestedTranslationReady({
        phase: 'running',
        language: 'es',
        documentStatus: 'PROCESSED',
        translatedLanguages: ['en', 'es'],
      }),
    ).toBe(true);
  });

  test('not ready while the document is still translating', () => {
    // Switching here would end the request, drop the takeover suppression and
    // hide the translation we just switched to behind ProcessingModal — and the
    // translated sections are not normalized until PROCESSED either.
    expect(
      isRequestedTranslationReady({
        phase: 'running',
        language: 'es',
        documentStatus: 'PROCESSING_TRANSLATIONS',
        translatedLanguages: ['en', 'es'],
      }),
    ).toBe(false);
  });

  test('not ready while only other languages landed', () => {
    expect(
      isRequestedTranslationReady({
        phase: 'running',
        language: 'es',
        documentStatus: 'PROCESSED',
        translatedLanguages: ['en', 'zh'],
      }),
    ).toBe(false);
  });

  test('does not fire for a request we never started', () => {
    expect(
      isRequestedTranslationReady({
        phase: 'idle',
        language: 'es',
        documentStatus: 'PROCESSED',
        translatedLanguages: ['en', 'es'],
      }),
    ).toBe(false);
  });

  test('does not fire for a failed request', () => {
    expect(
      isRequestedTranslationReady({
        phase: 'failed',
        language: 'es',
        documentStatus: 'PROCESSED',
        translatedLanguages: ['en', 'es'],
      }),
    ).toBe(false);
  });

  test('no target language means nothing to switch to', () => {
    expect(
      isRequestedTranslationReady({
        phase: 'running',
        language: null,
        documentStatus: 'PROCESSED',
        translatedLanguages: ['en', 'es'],
      }),
    ).toBe(false);
  });
});

describe('hasRequestedTranslationFailed', () => {
  // A failed add-on translation deliberately leaves the document PROCESSED so
  // the parent keeps the English content they can already read; the outcome is
  // recorded in current_step instead. Reading it is the only thing that tells
  // "finished, failed" apart from "still working", so without this the parent
  // sits on a progress bar until the page's minutes-long timeout backstop.
  const failedRun = {
    phase: 'running',
    language: 'es',
    documentStatus: 'PROCESSED',
    currentStep: 'translation_failed',
    translatedLanguages: ['en'],
  };

  test('a finished run that produced no translation has failed', () => {
    expect(hasRequestedTranslationFailed(failedRun)).toBe(true);
  });

  test('a successful run has not failed', () => {
    expect(hasRequestedTranslationFailed({
      ...failedRun,
      currentStep: 'completed',
      translatedLanguages: ['en', 'es'],
    })).toBe(false);
  });

  test('content present beats a stale failure marker', () => {
    // If the language did arrive, believe the content: reporting a failure over
    // a translation the parent can actually read would be the worse error.
    expect(hasRequestedTranslationFailed({
      ...failedRun,
      translatedLanguages: ['en', 'es'],
    })).toBe(false);
  });

  test('a run still in progress has not failed', () => {
    // THE STALE-MARKER CASE. A retry after an earlier failure re-enters
    // PROCESSING_TRANSLATIONS while current_step still reads translation_failed
    // from the previous attempt; firing here would kill the new run's progress
    // UI the instant it started.
    expect(hasRequestedTranslationFailed({
      ...failedRun,
      documentStatus: 'PROCESSING_TRANSLATIONS',
    })).toBe(false);
  });

  test('a document still doing its first processing has not failed', () => {
    expect(hasRequestedTranslationFailed({
      ...failedRun,
      documentStatus: 'PROCESSING',
    })).toBe(false);
  });

  test.each([
    ['idle', 'idle'],
    ['requesting', 'requesting'],
    ['failed', 'failed'],
  ])('does not fire when we are not awaiting a run (%s)', (_label, phase) => {
    expect(hasRequestedTranslationFailed({ ...failedRun, phase })).toBe(false);
  });

  test('does not fire without a requested language', () => {
    expect(hasRequestedTranslationFailed({ ...failedRun, language: null })).toBe(false);
  });

  test('a missing translatedLanguages list is treated as no translations', () => {
    expect(hasRequestedTranslationFailed({
      ...failedRun,
      translatedLanguages: undefined,
    })).toBe(true);
  });

  test('an absent current_step is not a failure', () => {
    // Older documents predate this marker; absence must mean "no information",
    // never "failed", or every one of them would show a false error.
    expect(hasRequestedTranslationFailed({
      ...failedRun,
      currentStep: undefined,
    })).toBe(false);
  });
});

describe('mapTranslationResponse: the attempt budget', () => {
  test('429 gets its own message, not the retryable generic one', () => {
    // The generic copy says "try again in a few minutes", which is the one
    // thing that cannot help once every paid attempt for this document is spent.
    const budget = mapTranslationResponse({ httpStatus: 429 });
    expect(budget.phase).toBe('failed');
    expect(budget.messageKey).toBe('summary.translate.error.budgetSpent');
    expect(budget.messageKey).not.toBe(
      mapTranslationResponse({ httpStatus: 500 }).messageKey);
  });
});
