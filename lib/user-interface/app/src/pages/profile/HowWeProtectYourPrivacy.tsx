import React from 'react';
import { Button } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faLock, faTrashCan, faArrowDownLong } from '@fortawesome/free-solid-svg-icons';
import { useLanguage } from '../../common/language-context';
import MobileTopNavigation from '../../components/MobileTopNavigation';
import OnboardingTopBar from '../../components/OnboardingChrome';
import './HowWeProtectYourPrivacy.css';

/**
 * The last screen of onboarding: what happens to the document a parent
 * uploads, drawn as the two providers that see it and the five steps between
 * them.
 *
 * The documents are markup, not an exported illustration. Almost everything on
 * the screen is labelled text, it ships in five languages, it mirrors in
 * Arabic, and a parent using a screen reader has to be able to read it; a PNG
 * does none of that. So the stacks of paper are offset boxes, the highlight is
 * a background colour and the discarded original is a dashed border, all in
 * HowWeProtectYourPrivacy.css.
 *
 * Every one of those shapes is aria-hidden. The five step sentences and the
 * closing line carry the whole meaning of the screen, which is what a screen
 * reader should get instead of a dozen unlabelled rectangles.
 */

/**
 * The two values on the sample IEP.
 *
 * Both are deliberately not real, and deliberately not even shaped like real:
 * a US Social Security number is nine digits (123-45-6789) and this is seven,
 * and "12 Oak St." has no city, no state and no zip. Leave them wrong. A
 * screen whose whole subject is that we strip a child's personal data should
 * not be printing something a reader could mistake for somebody's.
 */
const SAMPLE_SSN = '123-4567';
const SAMPLE_ADDRESS = '12 Oak St.';

/**
 * What the copy of the document says where a value used to be. The pipeline
 * substitutes a bracketed entity name for every entity Comprehend finds
 * (`replacement = f"[{entity_type}]"` in redact_ocr/comprehend_redactor.py),
 * and it substitutes the same string whatever language the document is in, so
 * these are not dictionary entries: a translated "[dirección]" would show a
 * parent a copy of their document that does not exist.
 */
const REDACTED_SSN = '[SSN]';
const REDACTED_ADDRESS = '[address]';

/**
 * The providers, named so a parent can look them up. Product names, so they
 * are not translated and are not in the dictionaries -- a translator handed
 * "AWS COMPREHEND" as a string would reasonably try to localise it.
 */
const COMPREHEND = 'AWS COMPREHEND';
const OPEN_AI = 'OPEN AI';

/**
 * Stand-in glyphs for "the same summary, in two languages". Not copy: there is
 * nothing here to read, and a dictionary entry would set every translator to
 * work localising a picture of text. Latin letters beside CJK characters is
 * the contrast the design draws, so the pair is fixed whatever language the
 * screen is in. The panel is aria-hidden; step 5 is the sentence that says
 * this is a translation.
 */
const LATIN_GLYPHS = ['ABC', 'DEF', 'GHI'];
const CJK_GLYPHS = ['日月金', '木水火', '土竹'];

/**
 * The five tones the summary bars and the fanned document edges are drawn in,
 * front to back. Each is a palette token with a measured 3:1 pair in
 * common/color-contrast.test.tsx.
 */
const TONES = ['green', 'blue', 'violet', 'rose', 'orange'];

/**
 * Renders a sentence, emphasising the runs a dictionary wraps in asterisks.
 *
 * The alternative -- one key for the words before the bold and another for the
 * words after -- freezes English's word order into all five files, and step 2
 * emphasises two separate words, which that split cannot express at all. A
 * whole sentence with markers lets each language put the emphasis where that
 * language puts it. `*` is punctuation none of the five dictionaries otherwise
 * use.
 */
function emphasise(sentence: string): React.ReactNode[] {
  // split() with a capturing group interleaves the captures with the plain
  // text, so the odd indices are exactly the runs that sat between asterisks.
  return sentence
    .split(/\*([^*]+)\*/g)
    .map((run, index) => (index % 2 === 1 ? <strong key={index}>{run}</strong> : run));
}

/** Two sheets of plain paper is enough to read as a stack. */
const PLAIN_SHEETS = ['plain', 'plain'];

/**
 * The sheets showing behind the top one, drawn back to front. `tones` fans
 * them out in the five colours instead, which is what step 3 draws.
 */
function BackSheets({ tones = false }: { tones?: boolean }) {
  return (
    <>
      {(tones ? TONES : PLAIN_SHEETS).map((tone, index) => (
        <span
          key={index}
          className={`privacy-sheet privacy-sheet--${index + 1} privacy-sheet--${tone}`}
        />
      ))}
    </>
  );
}

interface SampleDocumentProps {
  /** The redacted copy shows bracketed placeholders instead of values. */
  redacted?: boolean;
}

/** The front sheet: an IEP with two fields on it. */
function SampleDocument({ redacted = false }: SampleDocumentProps) {
  const { t } = useLanguage();

  // dir="ltr" on the values, not on the card: the labels are translated and
  // belong to the page's direction, but the values are fixed Latin text and
  // the document they stand for is in English. Left to the paragraph
  // direction, Arabic renders "12 Oak St." as ".Oak St 12" -- the trailing
  // full stop is a bidi neutral and lands at the wrong end.
  const value = (sample: string, placeholder: string) =>
    redacted ? (
      <span className="privacy-doc-value privacy-doc-value--redacted" dir="ltr">
        {placeholder}
      </span>
    ) : (
      <mark className="privacy-doc-value privacy-doc-value--highlight" dir="ltr">
        {sample}
      </mark>
    );

  return (
    <div className="privacy-doc">
      <p className="privacy-doc-title">IEP</p>
      <div className="privacy-doc-field">
        <span className="privacy-doc-label">{t('privacy.field.ssn')}</span>
        {value(SAMPLE_SSN, REDACTED_SSN)}
      </div>
      <div className="privacy-doc-field">
        <span className="privacy-doc-label">{t('privacy.field.address')}</span>
        {value(SAMPLE_ADDRESS, REDACTED_ADDRESS)}
      </div>
    </div>
  );
}

/** The coloured bars that stand for a summary. */
function SummaryBars({ className = '' }: { className?: string }) {
  return (
    <div className={`privacy-bars ${className}`.trim()}>
      {TONES.map((tone) => (
        <span key={tone} className={`privacy-bar privacy-bar--${tone}`} />
      ))}
    </div>
  );
}

interface StepProps {
  /** The digit in the circle. Decoration: the <ol> carries the real count. */
  number: number;
  figure: React.ReactNode;
  sentence: string;
}

/** One numbered step: the picture, then the circled number and the sentence. */
function Step({ number, figure, sentence }: StepProps) {
  return (
    <li className="privacy-step">
      <div className="privacy-figure" aria-hidden="true">
        {figure}
      </div>
      <div className="privacy-step-row">
        <span className="onboarding-step-number" aria-hidden="true">{number}</span>
        <span className="onboarding-step-label">{emphasise(sentence)}</span>
      </div>
    </li>
  );
}

export default function HowWeProtectYourPrivacy() {
  const navigate = useNavigate();
  const { t } = useLanguage();

  return (
    <>
      <MobileTopNavigation />
      <div className="onboarding-page privacy-page">
        <OnboardingTopBar />

        <h1 className="onboarding-heading">{t('privacy.heading')}</h1>

        <section className="privacy-section" aria-labelledby="privacy-provider-comprehend">
          <h2 className="privacy-provider" id="privacy-provider-comprehend">
            <FontAwesomeIcon icon={faLock} className="privacy-provider-icon" aria-hidden="true" />
            {COMPREHEND}
          </h2>

          <div className="privacy-card">
            {/* role="list" because list-style: none strips list semantics in
                Safari, which is the browser most of these parents are on. The
                circled numbers are decoration; this is what makes a screen
                reader say how many steps there are. */}
            <ol className="privacy-steps" role="list">
              <Step
                number={1}
                sentence={t('privacy.step1')}
                figure={
                  <>
                    <p className="privacy-caption">{t('privacy.label.original')}</p>
                    <div className="privacy-stack">
                      <BackSheets />
                      <SampleDocument />
                    </div>
                  </>
                }
              />
              <Step
                number={2}
                sentence={t('privacy.step2')}
                figure={
                  <div className="privacy-groups">
                    <div className="privacy-group">
                      <p className="privacy-caption">{t('privacy.label.original')}</p>
                      <div className="privacy-stack privacy-stack--discarded">
                        <BackSheets />
                        <div className="privacy-doc privacy-doc--discarded">
                          <FontAwesomeIcon icon={faTrashCan} className="privacy-trash" />
                        </div>
                      </div>
                    </div>
                    <div className="privacy-group">
                      <p className="privacy-caption">{t('privacy.label.copy')}</p>
                      <div className="privacy-stack">
                        <BackSheets />
                        <SampleDocument redacted />
                      </div>
                    </div>
                  </div>
                }
              />
            </ol>
          </div>
        </section>

        <div className="privacy-arrow" aria-hidden="true">
          <span className="privacy-arrow-line" />
          <FontAwesomeIcon icon={faArrowDownLong} className="privacy-arrow-head" />
        </div>

        <section className="privacy-section" aria-labelledby="privacy-provider-openai">
          <h2 className="privacy-provider" id="privacy-provider-openai">
            <FontAwesomeIcon icon={faLock} className="privacy-provider-icon" aria-hidden="true" />
            {OPEN_AI}
          </h2>

          <div className="privacy-card">
            {/* start={3} so the numbering a sighted parent reads off the
                circles is the numbering the list carries. One <ol> across both
                providers is not possible: an <ol> may only contain <li>, so it
                cannot be split over two cards. */}
            <ol className="privacy-steps" role="list" start={3}>
              <Step
                number={3}
                sentence={t('privacy.step3')}
                figure={
                  <>
                    <p className="privacy-caption">{t('privacy.label.copy')}</p>
                    <div className="privacy-stack privacy-stack--fanned">
                      <BackSheets tones />
                      <SampleDocument redacted />
                    </div>
                  </>
                }
              />
              <Step
                number={4}
                sentence={t('privacy.step4')}
                figure={
                  <div className="privacy-doc privacy-doc--summary">
                    <SummaryBars />
                  </div>
                }
              />
              <Step
                number={5}
                sentence={t('privacy.step5')}
                figure={
                  <div className="privacy-panels">
                    <div className="privacy-doc privacy-panel">
                      {LATIN_GLYPHS.map((glyph) => (
                        <span key={glyph} className="privacy-glyph">{glyph}</span>
                      ))}
                    </div>
                    <SummaryBars className="privacy-bars--between" />
                    <div className="privacy-doc privacy-panel">
                      {CJK_GLYPHS.map((glyph) => (
                        <span key={glyph} className="privacy-glyph">{glyph}</span>
                      ))}
                    </div>
                  </div>
                }
              />
            </ol>
          </div>
        </section>

        <p className="privacy-closing">
          <FontAwesomeIcon icon={faLock} className="privacy-closing-icon" aria-hidden="true" />
          <span>{emphasise(t('privacy.closing'))}</span>
        </p>

        <div className="onboarding-actions">
          <Button
            variant="primary"
            className="aiep-button onboarding-action"
            onClick={() => navigate('/iep-documents')}
            // Stable E2E hook: the label is localized
            data-testid="privacy-upload"
          >
            {t('privacy.button.upload')}
          </Button>
          <Button
            variant="outline-secondary"
            className="aiep-button onboarding-action"
            onClick={() => navigate('/view-resources')}
            data-testid="privacy-resources"
          >
            {t('privacy.button.resources')}
          </Button>
        </div>
      </div>
    </>
  );
}
