import { useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import type { ChildSurvey } from '../../common/types';
import { surveySavesSettled } from './survey-saves';

export const surveyQueryKey = (childId: string | undefined) => ['survey', childId] as const;

/** This child's survey from the server. Off when the feature or the child is not there. */
export function useChildSurvey(childId: string | undefined, enabled: boolean) {
  const appContext = useContext(AppContext);
  return useQuery({
    queryKey: surveyQueryKey(childId),
    // After any save still on its way (survey-saves.ts), or this read could
    // show the answers from before it.
    queryFn: async () => {
      await surveySavesSettled(childId as string);
      return new ApiClient(appContext).profile.getSurvey(childId as string) as Promise<ChildSurvey>;
    },
    enabled: enabled && Boolean(childId),
    // Always from the server on arrival: another device may have answered.
    staleTime: 0,
    retry: false,
  });
}
