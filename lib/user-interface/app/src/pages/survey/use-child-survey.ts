import { useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import type { ChildSurvey } from '../../common/types';

export const surveyQueryKey = (childId: string | undefined) => ['survey', childId] as const;

/** This child's survey from the server. Off when the feature or the child is not there. */
export function useChildSurvey(childId: string | undefined, enabled: boolean) {
  const appContext = useContext(AppContext);
  return useQuery({
    queryKey: surveyQueryKey(childId),
    queryFn: () => new ApiClient(appContext).profile.getSurvey(childId as string) as Promise<ChildSurvey>,
    enabled: enabled && Boolean(childId),
    // Always from the server on arrival: another device may have answered.
    staleTime: 0,
    retry: false,
  });
}
