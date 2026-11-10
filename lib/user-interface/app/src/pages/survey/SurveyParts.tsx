import React from 'react';
import { Checkbox, Radios, TextArea, TextField } from '../../components/ui/fields';
import { useLanguage } from '../../common/language-context';
import { fillName } from './fill-name';
import type { SurveyAnswers } from '../../common/types';
import {
  BaselinePart, FOLLOW_UP_KEYS, HELP_KEYS, QUESTIONS, REFLECT_KEYS, SCALE, SPEAK_KEYS, UNDERSTAND_KEYS,
  anyDisagree, optionsFor,
} from './questions';

type Setter = (key: string, value: string | string[]) => void;

interface ResearchChoiceProps {
  /** Unanswered is undefined, and is saved as no answer: only "yes" is consent. */
  value: boolean | undefined;
  onChange: (value: boolean) => void;
  name: string;
}

/**
 * Research use of the answers, asked as its own question with two equal
 * answers and neither chosen. It was a pre-worded "You can also use my
 * answers..." checkbox in the same bordered box as the app's required
 * consent, which read as one more thing to tick to get to the button. Consent
 * has to be a choice the parent sees as one: what research means here, that
 * it is optional, and that not answering is a no.
 */
export const ResearchChoice: React.FC<ResearchChoiceProps> = ({ value, onChange, name }) => {
  const { t } = useLanguage();
  return (
    <section className="survey-research" data-testid="survey-research">
      <Radios
        name={name}
        legend={t('survey.research.legend')}
        hint={t('survey.research.explain')}
        options={[
          { value: 'yes', label: t('survey.research.yes') },
          { value: 'no', label: t('survey.research.no') },
        ]}
        value={value === undefined ? undefined : value ? 'yes' : 'no'}
        onChange={(choice) => onChange(choice === 'yes')}
      />
      <p className="survey-note">{t('survey.research.skip')}</p>
    </section>
  );
};

/** EMAIL_MAX_LENGTH in user-profile-handler's survey.py. */
const EMAIL_MAX_LENGTH = 254;

interface StatementsProps {
  keys: readonly string[];
  name: string;
  answers: SurveyAnswers;
  onAnswer: Setter;
  /** Keeps a follow-up's radio names apart from the baseline's. */
  prefix?: string;
}

/** Statements on the agreement scale, each its own question, "Not sure" apart. */
export const Statements: React.FC<StatementsProps> = ({ keys, name, answers, onAnswer, prefix = 'before' }) => {
  const { t } = useLanguage();
  const options = SCALE.map((value) => ({ value, label: t(`survey.scale.${value}`) }));
  return (
    <div className="survey-questions">
      {keys.map((key) => (
        <Radios
          key={key}
          name={`${prefix}-${key}`}
          legend={fillName(t(`survey.q.${key}`), name)}
          hint={HELP_KEYS.includes(key) ? t(`survey.q.${key}.help`) : undefined}
          options={options}
          setApart={['unsure']}
          value={answers[key] as string | undefined}
          onChange={(value) => onAnswer(key, value)}
          className="survey-question"
        />
      ))}
    </div>
  );
};

/** A short Yes / No (/ Not sure) question. */
const Short: React.FC<{ id: string; legend: string; options: readonly string[]; value?: string; onChange: (v: string) => void }> = ({
  id, legend, options, value, onChange,
}) => {
  const { t } = useLanguage();
  return (
    <Radios
      name={id}
      legend={legend}
      layout="inline"
      options={options.map((option) => ({ value: option, label: t(`survey.answer.${option}`) }))}
      value={value}
      onChange={onChange}
      className="survey-question"
    />
  );
};

interface PartProps {
  part: BaselinePart;
  name: string;
  answers: SurveyAnswers;
  onAnswer: Setter;
  household: SurveyAnswers;
  onHousehold: Setter;
  /** A field the parent has to fix before moving on, by answer key. */
  errors: Record<string, string>;
}

const toggle = (list: unknown, value: string): string[] => {
  const current = Array.isArray(list) ? list : [];
  return current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
};

/** The questions of one baseline screen. */
export const SurveyPart: React.FC<PartProps> = ({ part, name, answers, onAnswer, household, onHousehold, errors }) => {
  const { t, language } = useLanguage();
  const q = (key: string) => fillName(t(`survey.q.${key}`), name);
  const choice = QUESTIONS.before.choice;

  if (part === 'about') {
    return (
      <div className="survey-questions">
        <Short id="k12" legend={q('k12')} options={choice.k12} value={answers.k12 as string} onChange={(v) => onAnswer('k12', v)} />
        <Short id="englishLearner" legend={q('englishLearner')} options={choice.englishLearner}
          value={answers.englishLearner as string} onChange={(v) => onAnswer('englishLearner', v)} />
        {language !== 'en' && (
          <Short id="homeLanguageCopy" legend={q('homeLanguageCopy')} options={choice.homeLanguageCopy}
            value={answers.homeLanguageCopy as string} onChange={(v) => onAnswer('homeLanguageCopy', v)} />
        )}
      </div>
    );
  }

  if (part === 'understand') {
    return <Statements keys={UNDERSTAND_KEYS} name={name} answers={answers} onAnswer={onAnswer} />;
  }

  if (part === 'speak') {
    return (
      <>
        <Statements keys={SPEAK_KEYS} name={name} answers={answers} onAnswer={onAnswer} />
        {anyDisagree(answers, SPEAK_KEYS) && (
          <TextArea
            className="survey-reveal"
            label={t('survey.q.speakWhy')}
            optionalLabel={t('survey.optional')}
            maxLength={QUESTIONS.before.text.speakWhy}
            value={(answers.speakWhy as string) ?? ''}
            onChange={(e) => onAnswer('speakWhy', e.target.value)}
          />
        )}
      </>
    );
  }

  if (part === 'reflect') {
    const chosen = Array.isArray(answers.reflectParts) ? answers.reflectParts : [];
    return (
      <>
        <Statements keys={REFLECT_KEYS} name={name} answers={answers} onAnswer={onAnswer} />
        {anyDisagree(answers, REFLECT_KEYS) && (
          <fieldset className="survey-reveal survey-checklist">
            <legend className="ui-radios-legend">{t('survey.q.reflectParts')}</legend>
            {QUESTIONS.before.multi.reflectParts.map((option) => (
              <Checkbox
                key={option}
                label={t(`survey.reflectParts.${option}`)}
                checked={chosen.includes(option)}
                onChange={() => onAnswer('reflectParts', toggle(answers.reflectParts, option))}
              />
            ))}
            {chosen.includes('other') && (
              <TextArea
                label={t('survey.q.reflectOther')}
                maxLength={QUESTIONS.before.text.reflectOther}
                value={(answers.reflectOther as string) ?? ''}
                onChange={(e) => onAnswer('reflectOther', e.target.value)}
              />
            )}
          </fieldset>
        )}
      </>
    );
  }

  // 'you': the household's questions, once per parent.
  const hc = QUESTIONS.household.choice;
  return (
    <div className="survey-questions">
      <Radios
        name="aiUse"
        legend={t('survey.q.aiUse')}
        options={optionsFor(hc.aiUse).map((value) => ({ value, label: t(`survey.ai.${value}`) }))}
        value={household.aiUse as string}
        onChange={(v) => onHousehold('aiUse', v)}
        className="survey-question"
      />
      <TextField
        label={t('survey.q.aiTools')}
        hint={t('survey.q.aiTools.hint')}
        optionalLabel={t('survey.optional')}
        maxLength={QUESTIONS.household.text.aiTools}
        value={(household.aiTools as string) ?? ''}
        onChange={(e) => onHousehold('aiTools', e.target.value)}
      />
      <Short id="stayInTouch" legend={t('survey.q.stayInTouch')} options={hc.stayInTouch}
        value={household.stayInTouch as string} onChange={(v) => onHousehold('stayInTouch', v)} />
      {household.stayInTouch === 'yes' && (
        <TextField
          className="survey-reveal"
          type="email"
          maxLength={EMAIL_MAX_LENGTH}
          autoComplete="email"
          label={t('survey.q.email')}
          hint={t('survey.q.email.hint')}
          optionalLabel={t('survey.optional')}
          error={errors.email}
          value={(household.email as string) ?? ''}
          onChange={(e) => onHousehold('email', e.target.value)}
        />
      )}
    </div>
  );
};

/** The follow-up's statements: the baseline's, word for word. */
export const FollowUpStatements: React.FC<Omit<StatementsProps, 'keys' | 'prefix'>> = (props) => (
  <Statements keys={FOLLOW_UP_KEYS} prefix="after" {...props} />
);
