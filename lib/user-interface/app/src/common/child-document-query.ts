import type { AppConfig } from './types';
import { IEPDocumentClient } from './api-client/iep-document-client';
import { childDocumentState } from '../pages/profile/my-children-status';

type DocumentAnswer = Parameters<typeof childDocumentState>[0];

/** One cache entry per child, shared by every screen that asks "what is this child's IEP doing?". */
export const childDocumentQueryKey = (childId: string | undefined) => ['child-document', childId] as const;

/**
 * The query for that answer, defined once. It is always read from the server
 * on arrival (staleTime 0): the app-wide cache keeps data for five minutes,
 * and an upload changes the answer from another screen. A cached "no IEP yet"
 * once sent a parent who had just uploaded back to the upload form.
 */
export const childDocumentQuery = (appContext: AppConfig | null, childId: string | undefined, pollMs: number) => ({
  queryKey: childDocumentQueryKey(childId),
  queryFn: () => new IEPDocumentClient(appContext as AppConfig).getMostRecentDocumentWithSummary(childId as string),
  enabled: Boolean(childId),
  retry: false,
  staleTime: 0,
  refetchInterval: (query: { state: { data?: unknown } }) =>
    childDocumentState(query.state.data as DocumentAnswer, false) === 'reading' ? pollMs : false,
});
