import React, { useContext, useEffect, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Form } from 'react-bootstrap';
import { useQueryClient } from '@tanstack/react-query';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { useLanguage } from '../../common/language-context';
import { useFeatures } from '../../common/hooks/use-features';
import { useActiveChild } from '../../common/hooks/use-active-child';
import { PROFILE_QUERY_KEY } from '../../common/hooks/use-language-preference';
import { CHILD_NAME_MAX_LENGTH, ChildNameError, normalizeChildName, validateChildName } from '../../common/child-name';
import { CHILD_QUERY_PARAM, fillTemplate, pathForChild } from '../../common/active-child';
import { isPlaceholderChildName } from '../../common/features';
import { STEP } from '../../common/breadcrumb-steps';
import Breadcrumbs from '../../components/Breadcrumbs';
import AIEPSpinner from '../../components/AIEPSpinner';
import PageLoading from '../../components/PageLoading';
import ChildrenHero from './ChildrenHero';
import './MyChildren.css';

const NAME_ERROR_ID = 'child-form-name-error';
/** The same limit the API enforces (MAX_SCHOOL_CITY_LENGTH). */
const SCHOOL_MAX_LENGTH = 100;
/** What the API stores for a school nobody gave; shown as an empty field. */
const SCHOOL_PLACEHOLDER = 'Not specified';

const NAME_ERROR_KEY: Record<ChildNameError, string> = {
  required: 'child.name.error.required',
  tooLong: 'child.name.error.tooLong',
  invalid: 'child.name.error.invalid',
};

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
    setSchool(child.schoolCity === SCHOOL_PLACEHOLDER ? '' : child.schoolCity ?? '');
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
      <Breadcrumbs trail={[STEP.account, STEP.myChildren, isEdit ? STEP.editChild : STEP.addChild]} />
      <div className="my-children-page">
        <ChildrenHero titleId="child-form-title" title={title} description={t('addChild.description')} />

        <div className="my-children-form-card">
          {saveFailed && (
            <Alert variant="danger">{t(isEdit ? 'editChild.error.saveFailed' : 'addChild.error.saveFailed')}</Alert>
          )}

          <Form onSubmit={handleSubmit} noValidate>
            <Form.Group controlId="childFormName" className="mb-3">
              <Form.Label>{t('addChild.name.label')}</Form.Label>
              <Form.Control
                type="text"
                value={name}
                autoComplete="off"
                maxLength={CHILD_NAME_MAX_LENGTH + 10}
                aria-required="true"
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? NAME_ERROR_ID : undefined}
                onChange={(e) => { setName(e.target.value); if (nameError) setNameError(null); }}
                data-testid="add-child-name"
              />
              {nameError && (
                <div id={NAME_ERROR_ID} className="child-name-error" role="alert">{t(NAME_ERROR_KEY[nameError])}</div>
              )}
            </Form.Group>

            <Form.Group controlId="childFormSchool" className="mb-4">
              <Form.Label>{t('addChild.school.label')}</Form.Label>
              <Form.Control
                type="text"
                value={school}
                maxLength={SCHOOL_MAX_LENGTH}
                onChange={(e) => setSchool(e.target.value)}
                data-testid="add-child-school"
              />
            </Form.Group>

            <Button
              type="submit"
              variant="primary"
              className="aiep-button my-children-action"
              disabled={saving}
              data-testid="add-child-save"
            >
              {saving
                ? (<><AIEPSpinner size="sm" className="me-2" />{t('addChild.saving')}</>)
                : t(isEdit ? 'editChild.button' : 'addChild.button')}
            </Button>
          </Form>
        </div>
      </div>
    </>
  );
};

export default ChildForm;
