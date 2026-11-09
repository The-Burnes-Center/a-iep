import React, { useState, useEffect, useContext } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import PageLoading from '../../components/PageLoading';
import PageShell from '../../components/page/PageShell';
import PageHero from '../../components/page/PageHero';
import Button from '../../components/ui/Button';
import { TextField } from '../../components/ui/fields';
import { Notice } from '../../components/ui/feedback';
import { DEFAULT_CHILD_NAME } from '../../common/features';
import { useQuery } from '@tanstack/react-query';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { useLanguage } from '../../common/language-context';

/** Ties the reason under the name field to the disabled Save button. */
const NAME_REASON_ID = 'update-profile-name-reason';

export default function UpdateProfileName() {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useLanguage();

  // Set when the sign-in flow routes here because the profile has no name
  // yet (consent form / login redirect); on save, continue into the app
  // instead of returning to the Account Center
  const onboardingContinue = (location.state as { onboardingContinue?: boolean } | null)?.onboardingContinue === true;

  const [parentName, setParentName] = useState<string>('');
  const [saving, setSaving] = useState(false);

  const { data: profile, isLoading, error } = useQuery({
    queryKey: ['profile'],
    queryFn: () => apiClient.profile.getProfile(),
  });

  useEffect(() => {
    if (profile?.parentName) {
      setParentName(profile.parentName);
    }
  }, [profile]);

  const handleSaveAndContinue = async () => {
    if (!parentName.trim()) {
      return; // Button should be disabled in this case
    }

    try {
      setSaving(true);

      // Prepare updated profile data
      const updatedProfileData = {
        parentName: parentName.trim()
      };

      // Update the profile with parent name
      await apiClient.profile.updateProfile(updatedProfileData);

      // Check if user has any children - if not, create a default child
      if (!profile?.children || profile.children.length === 0) {
        try {
          // Create a default child with generic information
          // The user can update this later if needed
          await apiClient.profile.addChild(DEFAULT_CHILD_NAME, profile?.city || 'Not specified');
          // console.log('Created default child for IEP document functionality');
        } catch (childError) {
          // console.error('Error creating default child:', childError);
          // Don't fail the flow if child creation fails - user can add manually later
        }
      }

      // Mark onboarding as completed since user has finished all required steps
      try {
        await apiClient.profile.updateProfile({ showOnboarding: false });
        // console.log('Onboarding completed - showOnboarding set to false');
      } catch (onboardingError) {
        // console.error('Error updating onboarding status:', onboardingError);
        // Don't fail the flow if this update fails
      }

      navigate(onboardingContinue ? '/iep-documents' : '/account-center');

    } catch (err) {
      console.error('Error saving parent name:', err);
    } finally {
      setSaving(false);
    }
  };

  const isFormValid = () => {
    return parentName.trim() !== '';
  };

  if (isLoading) {
    return (
      <PageLoading message={t('updateProfile.loading')} />
    );
  }

  if (error) {
    return (
      <PageShell>
        <Notice tone="error">{t('updateProfile.error.serviceUnavailable')}</Notice>
      </PageShell>
    );
  }

  const nameMissing = !isFormValid();

  return (
    <PageShell
      // Hidden mid-flow: the trail leads back to the Account Center, which
      // makes no sense while a parent is still finishing sign-in.
      trail={onboardingContinue ? undefined : [
        { labelKey: 'updateProfile.breadcrumb.account', to: '/account-center' },
        { labelKey: 'updateProfile.breadcrumb.updateProfile' },
      ]}
    >
      <PageHero
        titleId="update-profile-title"
        title={t('updateProfile.title')}
        description={t('updateProfile.description')}
        showFaces={false}
      />

      <form
        className="page-card"
        onSubmit={(e) => {
          e.preventDefault();
          handleSaveAndContinue();
        }}
      >
        <TextField
          id="formParentName"
          label={t('parent.name.label')}
          placeholder={t('parent.name.placeholder')}
          value={parentName}
          onChange={(e) => setParentName(e.target.value)}
        />

        {/* Saving stays disabled until there is a name, so the reason is on
            screen and the button points at it. */}
        {nameMissing && (
          <p id={NAME_REASON_ID} className="page-card-text">
            {t('updateProfile.reason.nameMissing')}
          </p>
        )}

        <Button
          type="submit"
          fullWidth
          disabled={nameMissing || saving}
          busy={saving}
          busyLabel={t('updateProfile.button.saving')}
          aria-describedby={nameMissing ? NAME_REASON_ID : undefined}
          // Stable E2E hook: the label is localized, the state
          // (disabled while the name is empty) is what is asserted
          data-testid="update-profile-submit"
        >
          {t('updateProfile.button.update')}
        </Button>
      </form>
    </PageShell>
  );
}
