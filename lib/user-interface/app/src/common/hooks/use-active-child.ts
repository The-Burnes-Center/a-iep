import { useContext, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AppContext } from '../app-context';
import { ApiClient } from '../api-client/api-client';
import { Child, UserProfile } from '../types';
import { useFeatures } from './use-features';
import { PROFILE_QUERY_KEY } from './use-language-preference';
import {
  CHILD_QUERY_PARAM,
  isMultiChildFamily,
  pathForChild,
  readRememberedChild,
  rememberChild,
  resolveActiveChild,
} from '../active-child';

export interface ActiveChildState {
  /** The child this screen is about, or null while loading or with none. */
  child: Child | null;
  childId: string | undefined;
  children: Child[];
  /** Zero-based position, for "Child 2 of 3". */
  index: number;
  /** More than one child and the feature on: show the child bar and switcher. */
  isMultiChild: boolean;
  isLoading: boolean;
  /** The URL named a child that is not on this profile (and none was used). */
  requestedMissing: boolean;
  /** `path` for this child (the bare path for a single-child family). */
  pathFor: (path: string) => string;
}

/**
 * The child the current screen is about, from `?child=` and the shared
 * ['profile'] cache. See common/active-child.ts for why the URL owns this.
 */
export function useActiveChild(): ActiveChildState {
  const appContext = useContext(AppContext);
  const [searchParams] = useSearchParams();
  const { isFeatureEnabled } = useFeatures();
  const enabled = isFeatureEnabled('multiChild');

  const profileQuery = useQuery({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: () => new ApiClient(appContext).profile.getProfile() as Promise<UserProfile>,
  });

  const children = profileQuery.data?.children ?? [];
  const requested = searchParams.get(CHILD_QUERY_PARAM);
  const active = resolveActiveChild(children, requested, enabled, readRememberedChild());
  const isMultiChild = isMultiChildFamily(children, enabled);
  const childId = active?.child.childId;

  // A screen the URL points at a real child of theirs is the one to come back
  // to when a later link names nobody.
  const opened = requested && active && !active.requestedMissing ? active.child.childId : undefined;
  useEffect(() => {
    if (opened) rememberChild(opened);
  }, [opened]);

  return {
    child: active?.child ?? null,
    childId,
    children,
    index: active?.index ?? 0,
    isMultiChild,
    isLoading: profileQuery.isLoading,
    requestedMissing: active?.requestedMissing ?? false,
    pathFor: (path: string) => pathForChild(path, childId, isMultiChild),
  };
}
