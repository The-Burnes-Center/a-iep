import React, { useContext, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Alert, Button, Form } from 'react-bootstrap';
import { useQueryClient } from '@tanstack/react-query';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { useLanguage } from '../../common/language-context';
import { useFeatures } from '../../common/hooks/use-features';
import { PROFILE_QUERY_KEY } from '../../common/hooks/use-language-preference';
import { CHILD_NAME_MAX_LENGTH, ChildNameError, normalizeChildName, validateChildName } from '../../common/child-name';
import { pathForChild } from '../../common/active-child';
import { STEP } from '../../common/breadcrumb-steps';
import Breadcrumbs from '../../components/Breadcrumbs';
import AIEPSpinner from '../../components/AIEPSpinner';
import './MyChildren.css';

const NAME_ERROR_ID = 'add-child-name-error';
/** The same limit the API enforces (MAX_SCHOOL_CITY_LENGTH). */
const SCHOOL_MAX_LENGTH = 100;

const NAME_ERROR_KEY: Record<ChildNameError, string> = {
  required: 'child.name.error.required',
  tooLong: 'child.name.error.tooLong',
  invalid: 'child.name.error.invalid',
};

/**
 * Add another child to the account, then go straight to uploading their IEP.
 *
 * The name rule is the one onboarding uses (common/child-name.ts), which the
 * API enforces too. The new child is added on the server first and the
 * profile cache refreshed before moving on, so the upload screen it lands on
 * already knows the child it is for.
 */
const AddChild: React.FC = () => {
  const { t } = useLanguage();
  const { isFeatureEnabled } = useFeatures();
  const appContext = useContext(AppContext);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [school, setSchool] = useState('');
  const [nameError, setNameError] = useState<ChildNameError | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  if (!isFeatureEnabled('multiChild')) return <Navigate to="/account-center" replace />;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const error = validateChildName(name);
    setNameError(error);
    if (error) return;

    setSaving(true);
    setSaveFailed(false);
    try {
      const added = await new ApiClient(appContext).profile.addChild(normalizeChildName(name), school.trim());
      await queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
      // Adding a child always makes a family of two or more, so the upload
      // screen gets the child in its URL.
      navigate(pathForChild('/iep-documents', added.childId, true));
    } catch {
      // The cause is in the API's log; the parent gets what to do next.
      setSaveFailed(true);
      setSaving(false);
    }
  };

  return (
    <>
      <Breadcrumbs trail={[STEP.account, STEP.myChildren, STEP.addChild]} />
      <div className="my-children-page">
        <h1 className="my-children-title">{t('addChild.title')}</h1>
        <p className="my-children-intro">{t('addChild.description')}</p>

        {saveFailed && <Alert variant="danger">{t('addChild.error.saveFailed')}</Alert>}

        <Form onSubmit={handleSubmit} noValidate>
          <Form.Group controlId="addChildName" className="mb-3">
            <Form.Label className="fw-bold">{t('addChild.name.label')}</Form.Label>
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

          <Form.Group controlId="addChildSchool" className="mb-4">
            <Form.Label className="fw-bold">{t('addChild.school.label')}</Form.Label>
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
            className="aiep-button my-children-action w-100"
            disabled={saving}
            data-testid="add-child-save"
          >
            {saving ? (<><AIEPSpinner size="sm" className="me-2" />{t('addChild.saving')}</>) : t('addChild.button')}
          </Button>
        </Form>
      </div>
    </>
  );
};

export default AddChild;
