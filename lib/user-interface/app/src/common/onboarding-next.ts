import { isStudentNameMissing } from './features';
import type { Feature } from './features';
import type { UserProfile } from './types';

export interface OnboardingStep {
  path: string;
  state?: Record<string, unknown>;
}

type IsOn = (feature: Feature) => boolean;

/**
 * After "how many of your children have an IEP": the child's name where that
 * gate is on and the name is still missing, otherwise how the tool works.
 * Neither ends onboarding: /how-to-use-the-tool leads on to the upload.
 */
export const afterChildCount = (profile: UserProfile | null | undefined, isOn: IsOn): OnboardingStep =>
  isOn('studentNameGate') && isStudentNameMissing(profile ?? null)
    ? { path: '/view-update-add-child', state: { onboardingContinue: true } }
    : { path: '/how-to-use-the-tool' };

/**
 * Where a child's first upload starts: the survey's invite first with
 * onboardingSurvey on (it is asked before the IEP, so the wait for the
 * summary has the rights carousel to itself), otherwise the upload. The
 * survey sends the parent on to the upload when it is done or declined.
 */
export const firstUploadStep = (isOn: IsOn): string =>
  isOn('onboardingSurvey') ? '/survey' : '/iep-documents';

/** After consent: the child count once (onboardingSurvey), then as above. */
export const afterConsent = (profile: UserProfile | null | undefined, isOn: IsOn): OnboardingStep =>
  isOn('onboardingSurvey') && !profile?.iepChildCount ? { path: '/your-children' } : afterChildCount(profile, isOn);
