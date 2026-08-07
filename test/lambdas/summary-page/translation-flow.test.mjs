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
    expect(
      shouldSuppressProcessingTakeover({
        phase: 'idle',
        documentStatus: 'PROCESSING_TRANSLATIONS',
        hasEnglishContent: true,
      }),
    ).toBe(false);
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
