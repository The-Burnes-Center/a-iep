/**
 * Types for ./translation-flow.mjs — see that file for why the implementation is
 * plain JavaScript and why both files use these extensions. Keep these
 * declarations in step with it.
 */

export type TranslationRequestPhase = 'idle' | 'requesting' | 'running' | 'failed';

export interface TranslationRequestState {
  phase: TranslationRequestPhase;
  /** The language the request targets; null while idle. */
  language: string | null;
  /** i18n key of the message to show; null when there is nothing to say. */
  messageKey: string | null;
}

/** What an HTTP answer means, before the caller attaches the language. */
export type TranslationRequestOutcome = Pick<
  TranslationRequestState,
  'phase' | 'messageKey'
>;

export declare const idleTranslationRequest: () => TranslationRequestState;

export declare const shouldPollForUpdates: (
  status: string | null | undefined,
  forcePolling?: boolean,
) => boolean;

export declare const buildLanguageMenuOptions: <T extends { value: string }>(
  enabledOptions: readonly T[] | null | undefined,
  translatedLanguages: readonly string[] | null | undefined,
) => Array<T & { isTranslated: boolean }>;

export declare const shouldOfferTranslation: (input: {
  documentStatus: string | null | undefined;
  preferredLanguage: string | null | undefined;
  translatedLanguages: readonly string[] | null | undefined;
}) => boolean;

export declare const mapTranslationResponse: (input: {
  httpStatus: number;
}) => TranslationRequestOutcome;

export declare const isTranslationInFlight: (
  phase: TranslationRequestPhase,
) => boolean;

/** Null when nothing is in flight for this parent. */
export declare const resumeTranslationRequest: (input: {
  documentStatus: string | null | undefined;
  preferredLanguage: string | null | undefined;
  translatedLanguages: readonly string[] | null | undefined;
}) => TranslationRequestState | null;

/**
 * No `phase`: this one is decided by the document alone, so that it survives an
 * unmount. Callers used to pass one and it was silently ignored.
 */
export declare const shouldSuppressProcessingTakeover: (input: {
  documentStatus: string | null | undefined;
  hasEnglishContent: boolean;
}) => boolean;

export declare const isRequestedTranslationReady: (input: {
  phase: TranslationRequestPhase;
  language: string | null | undefined;
  documentStatus: string | null | undefined;
  translatedLanguages: readonly string[] | null | undefined;
}) => boolean;

export declare const TRANSLATION_FAILED_STEP: string;

export declare const hasRequestedTranslationFailed: (input: {
  phase: TranslationRequestPhase;
  language: string | null | undefined;
  documentStatus: string | null | undefined;
  currentStep: string | null | undefined;
  translatedLanguages: readonly string[] | null | undefined;
}) => boolean;
