import type { Crumb } from '../components/Breadcrumbs';

/**
 * Every place a breadcrumb trail can point at, named once.
 *
 * Onboarding is linear, so each screen's trail is the step before it and
 * itself — which means a neighbour's route and label are written twice if
 * each screen keeps its own copy. They are written here instead, so renaming
 * a step renames it on both sides of the arrow and the shape of the flow is
 * readable in one place:
 *
 *   language -> consent -> child -> howItWorks -> yourIep -> askForPdf -> upload
 *                                        \-> privacy
 *
 * `to` is carried on every step, including the ones used as the last crumb.
 * Breadcrumbs marks the final crumb as the current page and drops its link,
 * so a screen names its own step the same way it names its previous one and
 * there is no second spelling to get wrong.
 */
export const STEP = {
  // --- Onboarding, in flow order ---------------------------------------
  language: { labelKey: 'breadcrumb.language', to: '/preferred-language' },
  whatAiepDoes: { labelKey: 'breadcrumb.whatAiepDoes', to: '/onboarding-user' },
  consent: { labelKey: 'breadcrumb.consent', to: '/consent-form' },
  child: { labelKey: 'breadcrumb.child', to: '/view-update-add-child' },
  howItWorks: { labelKey: 'breadcrumb.howItWorks', to: '/how-to-use-the-tool' },
  privacy: { labelKey: 'breadcrumb.privacy', to: '/how-we-protect-your-privacy' },
  yourIep: { labelKey: 'breadcrumb.yourIep', to: '/do-you-have-pdf' },
  askForPdf: { labelKey: 'breadcrumb.askForPdf', to: '/how-to-ask-for-pdf' },

  // --- The rest of the app ---------------------------------------------
  account: { labelKey: 'breadcrumb.account', to: '/account-center' },
  summary: { labelKey: 'breadcrumb.summary', to: '/summary-and-translations' },
  uploadIep: { labelKey: 'breadcrumb.uploadIep', to: '/iep-documents' },
  profile: { labelKey: 'breadcrumb.profile', to: '/profile' },
  rights: { labelKey: 'breadcrumb.rights', to: '/rights-and-onboarding' },
} as const satisfies Record<string, Crumb>;
