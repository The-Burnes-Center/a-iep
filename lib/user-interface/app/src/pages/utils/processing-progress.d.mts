/**
 * Types for ./processing-progress.mjs — see that file for why the
 * implementation is plain JavaScript and why both files use these extensions.
 * Keep these declarations in step with it.
 */

/** The fields of an IEP document payload that describe where a run is. */
export interface ProcessingProgressInput {
  status?: string | null;
  progress?: number | null;
  current_step?: string | null;
}

export declare const PIPELINE_MILESTONES: Readonly<Record<string, number>>;

export declare const FLOOR_PERCENT: number;

/** How full the bar is, clamped to FLOOR_PERCENT..100. */
export declare const progressPercent: (
  document: ProcessingProgressInput | null | undefined,
) => number;

/** i18n key naming the work now in flight; never a miss. */
export declare const processingStepKey: (
  document: ProcessingProgressInput | null | undefined,
) => string;

export declare const hasProgressChanged: (
  previous: ProcessingProgressInput | null | undefined,
  next: ProcessingProgressInput | null | undefined,
) => boolean;
