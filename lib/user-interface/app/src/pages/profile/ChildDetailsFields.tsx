import React from 'react';
import { TextField } from '../../components/ui/fields';
import { useLanguage } from '../../common/language-context';
import { CHILD_NAME_MAX_LENGTH, ChildNameError } from '../../common/child-name';

import { SCHOOL_MAX_LENGTH } from './child-school';

interface ChildDetailsFieldsProps {
  name: string;
  onNameChange: (value: string) => void;
  onNameBlur?: () => void;
  nameError: ChildNameError | null;
  school: string;
  onSchoolChange: (value: string) => void;
  /** Each screen keeps the ids its tests and the E2E walker already use. */
  nameId: string;
  schoolId: string;
  nameTestId?: string;
  schoolTestId?: string;
}

/**
 * The child's details, the same on every screen that asks for them: the
 * first child in onboarding (ViewAndAddChild) and every later one
 * (ChildForm). They were two copies that drifted: the first never asked for
 * the school district at all.
 *
 * The name is required and is the one the pipeline puts back into the
 * summary; the redaction step matches it against the IEP by first and last
 * name (redact_ocr/student_name.py), which is why the label asks for the full
 * name. The district is optional and says so.
 */
const ChildDetailsFields: React.FC<ChildDetailsFieldsProps> = ({
  name, onNameChange, onNameBlur, nameError, school, onSchoolChange, nameId, schoolId, nameTestId, schoolTestId,
}) => {
  const { t } = useLanguage();
  return (
    <>
      <TextField
        id={nameId}
        label={t('addChild.name.label')}
        error={nameError ? t(`child.name.error.${nameError}`) : null}
        value={name}
        autoComplete="off"
        maxLength={CHILD_NAME_MAX_LENGTH + 10}
        onChange={(e) => onNameChange(e.target.value)}
        onBlur={onNameBlur}
        data-testid={nameTestId}
      />
      <TextField
        id={schoolId}
        label={t('addChild.school.label')}
        hint={t('child.school.hint')}
        value={school}
        maxLength={SCHOOL_MAX_LENGTH}
        onChange={(e) => onSchoolChange(e.target.value)}
        data-testid={schoolTestId}
      />
    </>
  );
};

export default ChildDetailsFields;
