import React, { useContext, useEffect, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { useLanguage } from '../../common/language-context';
import { useFeatures } from '../../common/hooks/use-features';
import { useActiveChild } from '../../common/hooks/use-active-child';
import { PROFILE_QUERY_KEY } from '../../common/hooks/use-language-preference';
import { ChildNameError, normalizeChildName, validateChildName } from '../../common/child-name';
import { CHILD_QUERY_PARAM, fillTemplate, pathForChild } from '../../common/active-child';
import { isPlaceholderChildName } from '../../common/features';
import { STEP } from '../../common/breadcrumb-steps';
import PageShell from '../../components/page/PageShell';
import Button from '../../components/ui/Button';
import { Notice } from '../../components/ui/feedback';
import PageLoading from '../../components/PageLoading';
import PageHero from '../../components/page/PageHero';
import ChildDetailsFields from './ChildDetailsFields';
import { schoolForField } from './child-school';
import './MyChildren.css';

interface ChildFormProps {
  mode: 'add' | 'edit';
}

/**
 * Add a child, or change one child's name or school.
 *
 * The name rule is the one onboarding uses (common/child-name.ts), which the
 * API enforces too. Adding goes straight to that child's upload; editing goes
 * back to My children. Editing writes through PUT /profile/children/{id},
 * which touches only that child: PUT /profile replaces the whole list.
 *
 * Edit only ever edits the child the URL names. A link naming a child who is
 * not on the profile goes back to the list rather than quietly opening the
 * first child, since saving would then rename the wrong one.
 */
const ChildForm: React.FC<ChildFormProps> = ({ mode }) => {
  const { t } = useLanguage();
  const { isFeatureEnabled } = useFeatures();
  const appContext = useContext(AppContext);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { child, isLoading, requestedMissing } = useActiveChild();

  const isEdit = mode === 'edit';
  const [name, setName] = useState('');
  const [school, setSchool] = useState('');
  const [prefilled, setPrefilled] = useState(false);
  const [nameError, setNameError] = useState<ChildNameError | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  // Prefill once, when the child arrives, so a later refetch never overwrites
  // what the parent has typed.
  useEffect(() => {
    if (!isEdit || prefilled || !child) return;
    setName(isPlaceholderChildName(child.name) ? '' : child.name);
    setSchool(schoolForField(child.schoolCity));
    setPrefilled(true);
  }, [isEdit, prefilled, child]);

  if (!isFeatureEnabled('multiChild')) return <Navigate to="/account-center" replace />;
  if (isEdit && isLoading) return <PageLoading message={t('common.loading')} />;
  if (isEdit && (!searchParams.get(CHILD_QUERY_PARAM) || requestedMissing || !child?.childId)) {
    return <Navigate to="/account-center/children" replace />;
  }

  const editingName = isEdit && child && !isPlaceholderChildName(child.name) ? child.name : '';
  const title = isEdit
    ? (editingName ? fillTemplate(t('editChild.title'), { name: editingName }) : t('editChild.titleUnnamed'))
    : t('addChild.title');

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const error = validateChildName(name);
    setNameError(error);
    if (error) return;

    setSaving(true);
    setSaveFailed(false);
    const profileApi = new ApiClient(appContext).profile;
    try {
      if (isEdit && child?.childId) {
        await profileApi.updateChild(child.childId, { name: normalizeChildName(name), schoolCity: school.trim() });
        await queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
        navigate('/account-center/children');
      } else {
        const added = await profileApi.addChild(normalizeChildName(name), school.trim());
        await queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
        // Adding a child always makes a family of two or more, so the upload
        // screen gets the child in its URL.
        navigate(pathForChild('/iep-documents', added.childId, true));
      }
    } catch {
      // The cause is in the API's log; the parent gets what to do next.
      setSaveFailed(true);
      setSaving(false);
    }
  };

  return (
    <>
      <PageShell trail={[STEP.account, STEP.myChildren, isEdit ? STEP.editChild : STEP.addChild]} className="my-children-page">
        <PageHero titleId="child-form-title" title={title} showFaces={false} />

        <div className="my-children-form-card">
          {saveFailed && (
            <Notice tone="error" title={t(isEdit ? 'editChild.error.saveFailed' : 'addChild.error.saveFailed')} />
          )}

          <form className="my-children-form" onSubmit={handleSubmit} noValidate>
            <ChildDetailsFields
              name={name}
              onNameChange={(value) => { setName(value); if (nameError) setNameError(null); }}
              nameError={nameError}
              school={school}
              onSchoolChange={setSchool}
              nameId="childFormName"
              schoolId="childFormSchool"
              nameTestId="add-child-name"
              schoolTestId="add-child-school"
            />
            <Button
              type="submit"
              fullWidth
              busy={saving}
              busyLabel={t('addChild.saving')}
              data-testid="add-child-save"
            >
              {t(isEdit ? 'editChild.button' : 'addChild.button')}
            </Button>
          </form>
        </div>
      </PageShell>
    </>
  );
};

export default ChildForm;
