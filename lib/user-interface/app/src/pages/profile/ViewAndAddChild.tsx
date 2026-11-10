import React, { useState, useEffect, useContext } from 'react';
import PageLoading from '../../components/PageLoading';
import { useNavigate, useLocation } from 'react-router-dom';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { IEPDocumentClient } from '../../common/api-client/iep-document-client';
import { UserProfile } from '../../common/types';
import { useLanguage } from '../../common/language-context';
import { isPlaceholderChildName } from '../../common/features';
import { ChildNameError, normalizeChildName, validateChildName } from '../../common/child-name';
import { STEP } from '../../common/breadcrumb-steps';
import PageShell from '../../components/page/PageShell';
import PageHero from '../../components/page/PageHero';
import Button from '../../components/ui/Button';
import ChildDetailsFields from './ChildDetailsFields';
import { SCHOOL_PLACEHOLDER, schoolForField } from './child-school';
import { Notice } from '../../components/ui/feedback';

// The school district is optional, as on every later child (ChildDetailsFields):
// the research team uses it to see which districts A-IEP reaches. The backend
// still rejects a child without one, so a blank is stored as the same default
// the other addChild call sites send.
const SCHOOL_CITY_DEFAULT = SCHOOL_PLACEHOLDER;

// Named once: the e2e walker and the tests find the field by it, and focus
// goes back to it after a refused name (TextField does not forward a ref).
const CHILD_NAME_INPUT_ID = 'formChildName';

export default function ViewAndAddChild() {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const iepDocumentClient = new IEPDocumentClient(appContext);
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useLanguage();

  const [loading, setLoading] = useState(true);
  // Two separate failures: a profile that will not load leaves nothing to
  // show, but a save that fails must leave the form (and what the parent
  // typed) on screen to retry, with the reason above it.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [childName, setChildName] = useState<string>('');
  // Which rule the typed name breaks, or null. Set on blur and on submit,
  // cleared the moment the parent starts changing the value it was about.
  const [nameError, setNameError] = useState<ChildNameError | null>(null);
  const [schoolCity, setSchoolCity] = useState<string>('');
  const [hasExistingChild, setHasExistingChild] = useState<boolean>(false);
  const [firstChildId, setFirstChildId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [hasExistingDocument, setHasExistingDocument] = useState<boolean>(false);

  // Set only by the onboarding entry points (ConsentForm, PreferredLanguage).
  // Its absence is what tells this screen it was opened to edit a name that
  // is already there.
  const isOnboarding = Boolean(
    (location.state as { onboardingContinue?: boolean } | null)?.onboardingContinue);

  useEffect(() => {
    loadProfileAndCheckDocument();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only load by design
  }, []);

  const loadProfileAndCheckDocument = async () => {
    try {
      setLoading(true);

      // Load user profile
      const data = await apiClient.profile.getProfile();
      setProfile(data);

      // Check if the user has any children
      if (data.children && data.children.length > 0) {
        const firstChild = data.children[0];
        // A stored '' or the auto-created 'My Child' placeholder must not
        // look like an answer: prefilling it would let a parent click Save
        // without ever typing a real name, which the gate would then send
        // them right back here to do.
        setChildName(isPlaceholderChildName(firstChild.name) ? '' : firstChild.name);
        setSchoolCity(schoolForField(firstChild.schoolCity));
        setFirstChildId(firstChild.childId || null);
        setHasExistingChild(true);
      } else {
        setHasExistingChild(false);
      }

      // Always check for existing documents regardless of children
      await checkForExistingDocument();

      setLoadError(null);
    } catch (err) {
      // console.error('Error loading profile or checking document:', err);
      setLoadError(t('profile.error.serviceUnavailable'));
    } finally {
      setLoading(false);
    }
  };

  const checkForExistingDocument = async () => {
    try {
      const document = await iepDocumentClient.getMostRecentDocumentWithSummary();

      // Check if document exists and has been processed or is processing
      if (document && (document.status === "PROCESSED" || document.status === "PROCESSING")) {
        setHasExistingDocument(true);
      } else {
        setHasExistingDocument(false);
      }
    } catch (err) {
      // console.error('Error checking for existing document:', err);
      // If there's an error checking for documents, assume no document exists
      setHasExistingDocument(false);
    }
  };

  const handleSaveAndContinue = async () => {
    // The button is no longer disabled on a name that will not do: a disabled
    // button with nothing next to it is a dead end, and the parent who hit one
    // had no way to find out what this screen wanted. Pressing it says what is
    // wrong and puts the cursor back in the field.
    const nameProblem = validateChildName(childName);
    if (nameProblem) {
      setNameError(nameProblem);
      document.getElementById(CHILD_NAME_INPUT_ID)?.focus();
      return;
    }
    // What gets saved is the tidied name, not the keystrokes: the API applies
    // the same rule, and a double space between two halves of a name would
    // otherwise reach the heading of every summary.
    const name = normalizeChildName(childName);

    try {
      setSaving(true);
      setSaveError(null);
      // Whatever the child already has on file, or the shared default: the
      // screen no longer asks, but the API still requires it.
      const childSchoolCity = schoolCity.trim() || profile?.city || SCHOOL_CITY_DEFAULT;

      if (hasExistingChild && firstChildId) {
        // Update the existing child, as a new object: the profile in state is
        // read again on the way out of this handler.
        const existingChild = profile?.children?.[0];
        if (existingChild) {
          // PUT /profile REPLACES the children list with what it is sent, so
          // every other child goes back unchanged. Sending the first alone
          // deleted the rest for a parent with more than one child.
          await apiClient.profile.updateProfile({
            children: [
              {
                ...existingChild,
                name,
                schoolCity: childSchoolCity,
                // Keep the existing childId
                childId: firstChildId
              },
              ...(profile?.children?.slice(1) ?? []),
            ]
          });
        }
      } else {
        // Add new child
        await apiClient.profile.addChild(name, childSchoolCity);

        // After adding a new child, check for documents again
        await checkForExistingDocument();
      }

      // Mark onboarding as completed since user has finished child setup
      try {
        await apiClient.profile.updateProfile({ showOnboarding: false });
        // console.log('Onboarding completed from ViewAndAddChild - showOnboarding set to false');
      } catch (onboardingError) {
        // console.error('Error updating onboarding status:', onboardingError);
        // Don't fail the flow if this update fails
      }


      // Onboarding arrives here with onboardingContinue set, and carries on
      // into the app. Account Center does not, and a parent who came to
      // correct a name belongs back where they started rather than being
      // pushed through the rest of a flow they finished long ago.
      if (!isOnboarding) {
        navigate('/account-center');
        return;
      }

      // Navigate based on whether user has existing documents
      if (hasExistingDocument) {
        // The legacy /welcome-page card hub is retired; Summary is the app home
        navigate('/summary-and-translations');
      } else {
        // Into the rest of onboarding: how the tool works, then the question
        // about whether they have the IEP as a PDF, then the upload.
        navigate('/how-to-use-the-tool');
      }
    } catch (err) {
      // Inline, above the form the parent just filled in: this failure used
      // to be reported only by a toast.
      setSaveError(hasExistingChild ? t('child.error.updateFailed') : t('child.error.addFailed'));
    } finally {
      setSaving(false);
    }
  };

  // The one field also submits on the keyboard's Go/Enter key.
  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void handleSaveAndContinue();
  };

  const handleNameChange = (value: string) => {
    setChildName(value);
    // Nagging somebody mid-word is worse than saying nothing: the message goes
    // as soon as they start fixing it, and comes back on blur or on submit if
    // the new value still breaks the rule.
    setNameError(null);
  };

  if (loading) {
    return (
      <PageLoading message={t('common.loading')} />
    );
  }

  if (loadError) {
    return (
      <PageShell>
        <PageHero titleId="child-title" title={t('child.heading')} />
        <section className="page-card">
          <Notice tone="error">{loadError}</Notice>
        </section>
      </PageShell>
    );
  }

  // The same fork Save takes below: onboarding arrived here from consent, and
  // a parent correcting a name that is already there arrived from the Account
  // Center. Read off `isOnboarding` rather than off the history stack, so the
  // trail says where the parent actually came from.
  return (
    <PageShell trail={[isOnboarding ? STEP.consent : STEP.account, STEP.child]}>
      <PageHero titleId="child-title" title={t('child.heading')} />

      {saveError && <Notice tone="error">{saveError}</Notice>}

      <form className="page-card" onSubmit={handleSubmit}>
        <ChildDetailsFields
          name={childName}
          onNameChange={handleNameChange}
          onNameBlur={() => setNameError(validateChildName(childName))}
          nameError={nameError}
          school={schoolCity}
          onSchoolChange={setSchoolCity}
          nameId={CHILD_NAME_INPUT_ID}
          schoolId="formChildSchool"
        />

        <Button
          type="submit"
          variant="primary"
          fullWidth
          // Only the in-flight save disables it. Whether the name is
          // acceptable is answered by pressing it, not by a button that will
          // not react.
          busy={saving}
          busyLabel={t('child.button.saving')}
          // Stable E2E hook: the label is localized
          data-testid="child-save-button"
        >
          {/* "Continue" between onboarding steps, "Save changes" for an
              edit (docs/UI_STANDARDS.md): from the Account Center this saves
              and goes back, it does not continue anywhere. */}
          {isOnboarding ? t('child.button.save') : t('common.saveChanges')}
        </Button>
      </form>
    </PageShell>
  );
}
