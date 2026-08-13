/**
 * Helpers for the document-lifecycle journeys (documents.spec.ts and
 * tts.spec.ts): the upload page, the summary/translations page and the TTS
 * buttons on it.
 *
 * Everything here drives the deployed frontend the way a parent would. The
 * selectors are deliberately LANGUAGE-AGNOSTIC (test ids and stable ids
 * rather than visible copy) because these journeys switch the app into
 * Spanish on purpose: the pipeline only produces translations for the
 * profile's secondaryLanguage (steps/check_language_prefs/handler.py reads it
 * from the profile at processing time), and setting it also flips the whole
 * UI into that language for the rest of the browser context
 * (language-context.ts persists it to localStorage; the summary page also
 * re-syncs it from the profile on every load).
 */
import { Page, Locator, expect } from '@playwright/test';
import * as path from 'path';
import { appUrl } from './config';
import { ensureTestUser } from './aws';
import { loginWithOtp } from './app';
import { DOCUMENTS_USER } from './phones';
import {
  languageSelect,
  openLanguageForm,
  readLanguagePreference,
  setLanguagePreference,
} from './profile';

/**
 * The documents journey's dedicated user (+1 555 555 0114, NANP-fictional).
 * It owns the child whose document gets uploaded, replaced and read aloud, so
 * no other spec's state can be disturbed by a pipeline run. Re-exported so
 * the specs have one import.
 */
export { DOCUMENTS_USER };

/** The synthetic two-page IEP; see fixtures/make-synthetic-iep.py. */
export const FIXTURE_PDF = path.join(__dirname, '..', 'fixtures', 'synthetic-iep.pdf');

/**
 * The translation language the journey pins on the profile. Spanish is
 * enabled in every environment (Arabic is not, see common/languages.ts) and
 * its output is easy to tell apart from English without any NLP.
 */
export const TRANSLATION_LANGUAGE = 'es';

/** Function words that appear in essentially any Spanish paragraph. */
const SPANISH_MARKERS = [' de ', ' que ', ' la ', ' los ', ' para ', ' con ', ' en '];

/**
 * Every language the STAGING deployment offers, in the app's display order.
 *
 * Mirrors ALL_LANGUAGES in lib/user-interface/index.ts, which is what CDK
 * writes into aws-exports.json; production ships the same list minus Arabic
 * (PROD_LANGUAGES, pinned by test/infra/enabled-languages.test.ts). This suite
 * only ever runs against staging (the OTP backdoor and the stack lookup are
 * both staging-only), so the full list is the one it can rotate over.
 */
export const ENABLED_LANGUAGES = ['en', 'es', 'zh', 'vi', 'ar'] as const;

export type EnabledLanguage = typeof ENABLED_LANGUAGES[number];

/**
 * What the pipeline run itself already puts on the document: English (always)
 * plus whatever stage 2 pinned on the profile, which check_language_prefs
 * reads at upload time.
 */
const PIPELINE_LANGUAGES: readonly string[] = ['en', TRANSLATION_LANGUAGE];

/**
 * The languages the on-demand stage rotates through: every enabled language
 * the upload did NOT already produce.
 *
 * Derived rather than listed, because the derivation IS the requirement. The
 * summary page only offers to translate into a language the document is
 * missing (shouldOfferTranslation), and handleGenerateTranslation returns
 * early for English, so asking for 'en' or for TRANSLATION_LANGUAGE would
 * leave stages 10 and 11 with no banner to press and nothing to assert.
 * That leaves Chinese, Vietnamese and Arabic.
 */
export const ON_DEMAND_LANGUAGES: EnabledLanguage[] = ENABLED_LANGUAGES.filter(
  (language) => !PIPELINE_LANGUAGES.includes(language)
);

const isOnDemandLanguage = (value: string): value is EnabledLanguage =>
  (ON_DEMAND_LANGUAGES as readonly string[]).includes(value);

/** Force one language for a run, e.g. E2E_ON_DEMAND_LANGUAGE=ar. */
export const ON_DEMAND_LANGUAGE_ENV = 'E2E_ON_DEMAND_LANGUAGE';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface OnDemandLanguageChoice {
  language: EnabledLanguage;
  /** How it was arrived at, logged by stage 10 so a failed night is reproducible. */
  reason: string;
}

/**
 * Which language this run asks the finished document for.
 *
 * Date-derived, not random: a nightly you cannot reproduce is a nightly you
 * cannot debug. Whole UTC days since the epoch advance by exactly one per
 * nightly (it runs at 09:00 UTC), so consecutive nights walk the list and
 * every language is exercised within ON_DEMAND_LANGUAGES.length nights; two
 * runs on the same UTC day pick the SAME language, so re-running a failed
 * night by hand repeats it instead of testing something else.
 *
 * Pure and parameterised so on-demand-language.spec.ts can prove the cycle
 * without waiting three nights for it.
 */
export function pickOnDemandLanguage(
  when: Date = new Date(),
  override: string | undefined = process.env[ON_DEMAND_LANGUAGE_ENV]
): OnDemandLanguageChoice {
  const forced = override?.trim().toLowerCase();
  if (forced) {
    if (!isOnDemandLanguage(forced)) {
      throw new Error(
        `${ON_DEMAND_LANGUAGE_ENV}=${override} is not one of ${ON_DEMAND_LANGUAGES.join(', ')}. ` +
        `English and ${TRANSLATION_LANGUAGE} are excluded on purpose: the nightly upload ` +
        'already produces both, so the summary page would never offer to translate into ' +
        'them and the on-demand stages would have nothing to press.'
      );
    }
    return { language: forced, reason: `forced by ${ON_DEMAND_LANGUAGE_ENV}` };
  }

  const day = Math.floor(when.getTime() / MS_PER_DAY);
  // Both modulos so a date before 1970 cannot produce a negative index: JS's
  // % keeps the sign of the dividend.
  const size = ON_DEMAND_LANGUAGES.length;
  const index = ((day % size) + size) % size;
  return {
    language: ON_DEMAND_LANGUAGES[index],
    reason:
      `UTC day ${day} % ${size} = index ${index} of [${ON_DEMAND_LANGUAGES.join(', ')}]; ` +
      `force one with ${ON_DEMAND_LANGUAGE_ENV}=<code>`,
  };
}

// Resolved ONCE per worker process, on purpose: stages 10 and 11 must agree on
// the language, and a run that straddles UTC midnight would otherwise ask for
// one language and assert another.
const onDemandChoice = pickOnDemandLanguage();

/**
 * The language the on-demand translation journey asks for on THIS run, AFTER
 * the pipeline has already run. It is one the upload did not produce: the
 * document is uploaded with the profile on TRANSLATION_LANGUAGE, so it lands
 * holding English plus Spanish, and pinning the profile to a THIRD language is
 * exactly the "my language is missing" state the summary page's translate
 * banner exists for.
 */
export const ON_DEMAND_LANGUAGE: EnabledLanguage = onDemandChoice.language;

/** Why that one; stage 10 logs it so a failed nightly can be reproduced. */
export const ON_DEMAND_LANGUAGE_REASON = onDemandChoice.reason;

// --- Budgets (nightly, generous; the pipeline is OCR + LLM + translations) --
/** The S3 event -> metadata-handler hop, then the first PROCESSING status. */
export const PROCESSING_APPEARS_MS = 3 * 60_000;
/** OCR + analysis + translations, from PROCESSING to PROCESSED. */
export const SUMMARY_APPEARS_MS = 12 * 60_000;
/**
 * A cold TTS cache can take minutes: the audio lambda synthesizes through a
 * real provider and the client retries a 30s API Gateway timeout up to five
 * times (iep-document-client.ts#getDocumentAudio), leaving the button in its
 * 'loading' state throughout. Every nightly upload mints a new iepId, and the
 * S3 audio cache key contains it, so the first run after an upload always
 * pays for a real synthesis.
 */
export const TTS_READY_MS = 4 * 60_000;
/**
 * One on-demand, whole-document translation: from the endpoint's 202 to the new
 * language's pane on screen.
 *
 * Deliberately the same 10 minutes as the summary page's own backstop
 * (TRANSLATION_TIMEOUT_MS in IEPSummarizationAndTranslation.tsx). Past that the
 * page stops believing the request and shows the parent a retryable error, so a
 * spec that waited longer would be asserting a state no parent is ever shown.
 */
export const ON_DEMAND_TRANSLATION_MS = 10 * 60_000;

// --- Test ids added to the frontend for these journeys ---------------------
export const TESTID = {
  /** Wrapper of ProcessingModal: the "still processing" milestone. */
  processing: 'processing-modal',
  /** The FAILED alert on the summary page. */
  failed: 'summary-failed',
  /** Per-language tab pane on the summary page (only one is ever visible). */
  tabPanel: (lang: string) => `summary-tab-panel-${lang}`,
  /** The summary prose inside a tab pane. */
  summaryText: (lang: string) => `summary-text-${lang}`,
  /** One Key Insights accordion item. */
  section: 'summary-section',
  /** Language items in the summary page's dropdown. */
  languageOption: (lang: string) => `summary-language-option-${lang}`,
  /** Heading of the "your language has no translation yet" banner. Present in
   * both of the banner's states, so it is what says the OFFER still stands. */
  translateBanner: 'translate-preferred-language',
  /** The banner's "translate it now" button; absent while one is running. */
  translateNow: 'translate-now-button',
  /** The inline progress that replaces that button while one is running. */
  translationProgress: 'translation-progress',
  /** The banner's inline error, shown when a request or a run failed. */
  translationError: 'translation-error',
  /** "UPDATE IEP DOCUMENT" card footer -> /iep-documents. */
  replaceDocument: 'replace-document-link',
  /** Save/download button (server-generated PDF). */
  downloadPdf: 'download-pdf-button',
  /** Submit button on the upload form. */
  uploadSubmit: 'upload-submit-button',
  /** The two states of the "current document" card on /iep-documents. */
  documentOnFile: 'current-document-present',
  noDocumentOnFile: 'current-document-absent',
  /** Every TTS button; its data-tts-state carries the playback state. */
  ttsButton: 'tts-play-button',
} as const;

const sleep = (page: Page, ms: number) => page.waitForTimeout(ms);

/**
 * Sign in as the documents user, healing the Cognito account first.
 *
 * global-setup.ts already ensures 0114 exists; repeating it here is
 * idempotent and sub-second, and it means a change to the shared setup can
 * never leave these journeys failing with the confusing symptom (the login
 * helper hitting the sign-up path because the account evaporated).
 */
export async function loginAsDocumentsUser(page: Page): Promise<void> {
  await ensureTestUser(DOCUMENTS_USER);
  await loginWithOtp(page, DOCUMENTS_USER);
}

export async function gotoDocumentsPage(page: Page): Promise<void> {
  await page.goto(appUrl('/iep-documents'));
  await expect(page.locator('#fileUpload')).toBeAttached();
}

export async function gotoSummaryPage(page: Page): Promise<void> {
  await page.goto(appUrl('/summary-and-translations'));
}

/**
 * The routes the app's nav bar links to, and the icon MobileTopNavigation
 * gives each one.
 *
 * Those buttons carry no test id, and their aria-label is built from the
 * TRANSLATED nav label, so with the UI in Spanish, Chinese or Arabic neither
 * the visible copy nor a role+name lookup can find them. They used to be
 * addressed POSITIONALLY, by their index in this array.
 *
 * That survives Arabic, because `dir="rtl"` reverses how a flex row is
 * PAINTED, not the order of the DOM, and Playwright's nth() is document order.
 * But it leans on two invisible facts at once: the component's array order,
 * and that the flip is only visual. The icon is a better handle, depending on
 * neither. @tabler/icons-react stamps `tabler-icon-<name>` onto every svg it
 * renders (createReactComponent.mjs), MobileTopNavigation gives each route its
 * own icon, and that class is the same in every language, in either writing
 * direction, at any position in the bar.
 *
 * on-demand-language.spec.ts pins both halves of that: it renders the nav's
 * markup with Arabic labels under dir="rtl" and asserts the visual order flips
 * while this lookup keeps landing on the right button. Every tap then asserts
 * the route it actually reached, so a rewired icon fails saying so instead of
 * quietly exercising the wrong button.
 */
export const APP_NAV_ICONS = {
  '/summary-and-translations': 'file-description',
  '/support-center': 'heart-handshake',
  '/parent-rights': 'info-circle',
  '/account-center': 'user',
} as const;

export type AppNavRoute = keyof typeof APP_NAV_ICONS;

export const APP_NAV_ROUTES = Object.keys(APP_NAV_ICONS) as AppNavRoute[];

/**
 * The nav-bar button that owns `route`, whatever language the app is in and
 * whichever way round the bar is painted.
 *
 * Scoped to the component's own wrapper because the landing page's nav builds
 * its markup the same way, and react-bootstrap's tab nav (hidden by CSS on the
 * summary page, but in the DOM) also uses the class `nav-item`.
 */
export function appNavButton(page: Page, route: AppNavRoute): Locator {
  return page.locator(
    `.mobile-top-navigation button.nav-item:has(svg.tabler-icon-${APP_NAV_ICONS[route]})`
  );
}

/**
 * Tap a button in the app's nav bar and wait for the route it owns.
 *
 * This is a real react-router navigation, i.e. it UNMOUNTS the page you were
 * on. That is the point wherever this is used.
 */
export async function tapAppNav(page: Page, route: AppNavRoute): Promise<void> {
  // 'Navigate to ' is hardcoded English in MobileTopNavigation and only the
  // label after it is translated, so this prefix match holds in any language.
  // Kept as a separate, whole-bar check: it is what catches the nav rendering
  // none of its buttons (the tutorial-phase branch renders a bare line of
  // copy) or rendering twice.
  await expect(
    page.locator('.mobile-top-navigation button[aria-label^="Navigate to "]'),
    `the app nav did not render its ${APP_NAV_ROUTES.length} buttons ` +
    '(MobileTopNavigation changed, or this page does not render it)'
  ).toHaveCount(APP_NAV_ROUTES.length);

  const button = appNavButton(page, route);
  await expect(
    button,
    `no app-nav button carries the ${APP_NAV_ICONS[route]} icon that MobileTopNavigation ` +
    `gives ${route} (its navigationItems icons changed, or @tabler/icons-react stopped ` +
    'stamping tabler-icon-<name> onto its svg): update APP_NAV_ICONS to match'
  ).toHaveCount(1);

  await button.click();
  try {
    await page.waitForURL((url) => url.pathname === route, { timeout: 60_000 });
  } catch {
    throw new Error(
      `tapping the app-nav button with the ${APP_NAV_ICONS[route]} icon landed on ` +
      `${new URL(page.url()).pathname}, not ${route} (MobileTopNavigation wired that ` +
      'icon to a different route: update APP_NAV_ICONS to match)'
    );
  }
}

/** True when /iep-documents reports a document already on file. */
export async function hasDocumentOnFile(page: Page): Promise<boolean> {
  const present = page.getByTestId(TESTID.documentOnFile);
  const absent = page.getByTestId(TESTID.noDocumentOnFile);
  await expect(present.or(absent)).toBeVisible({ timeout: 60_000 });
  return present.isVisible();
}

/**
 * Pin the profile's translation language through the real settings screen.
 *
 * This has to happen BEFORE an upload: check_language_prefs reads
 * secondaryLanguage from the profile when the state machine runs, so a
 * document uploaded while the profile says English is never translated.
 *
 * It is also how the on-demand journey moves the profile onto a language the
 * finished document does NOT have (and back again afterwards), which is what
 * makes the summary page offer to generate one.
 *
 * Returns without touching anything when the language is already set. The
 * picker itself is helpers/profile.ts's territory, so its locators and its
 * "wait for the PUT" discipline are reused rather than re-implemented; only
 * the user and the reason differ.
 */
export async function ensureTranslationLanguage(
  page: Page,
  language: string = TRANSLATION_LANGUAGE
): Promise<void> {
  await openLanguageForm(page);

  // A language this deployment does not offer is a real possibility now that
  // the on-demand stage rotates onto Arabic, which ships on staging and is
  // dark on prod (ENABLED_LANGUAGES in lib/user-interface/index.ts, pinned by
  // test/infra/enabled-languages.test.ts). Without this the failure is
  // selectOption() timing out with no clue as to why.
  await expect(
    languageSelect(page).locator(`option[value="${language}"]`),
    `the deployed site does not offer ${language} in its language picker: ` +
    'enabledLanguages in its aws-exports.json (ENABLED_LANGUAGES at deploy time) ' +
    'no longer includes it'
  ).toHaveCount(1);

  if ((await readLanguagePreference(page)) !== language) {
    await setLanguagePreference(page, language);
    // Re-open the picker so the assertion below reads the SERVER's value: an
    // optimistic UI switch that failed to save would roll back here, and the
    // pipeline reads the profile, not the browser.
    await openLanguageForm(page);
  }

  expect(
    await readLanguagePreference(page),
    `the profile's translation language did not stick on ${language} ` +
    '(the update-profile call failed: an upload would then produce no translation, ' +
    'and the summary page would not offer to generate one)'
  ).toBe(language);
}

/** Upload the synthetic fixture from /iep-documents and follow the redirect. */
export async function uploadFixture(page: Page): Promise<void> {
  await gotoDocumentsPage(page);
  // The visible chooser is a styled overlay; the real input keeps this id.
  await page.locator('#fileUpload').setInputFiles(FIXTURE_PDF);
  await page.getByTestId(TESTID.uploadSubmit).click();
  // A successful S3 upload routes to the summary page.
  await page.waitForURL((url) => url.pathname === '/summary-and-translations', {
    timeout: 120_000,
  });
}

/**
 * Milestone 1: the NEW upload registered and the pipeline is running.
 *
 * Requiring this before accepting any summary is what stops a run from
 * passing vacuously on the PREVIOUS document (uploads replace, they do not
 * accumulate, so the summary page always has something to show).
 *
 * Document records are created by an S3 event, so the summary page's first
 * fetch after the upload can lose the race; on a miss the page even bounces
 * back to /iep-documents. Hence the re-navigation loop rather than a plain
 * expect().
 */
export async function waitForProcessingMilestone(
  page: Page,
  timeoutMs: number = PROCESSING_APPEARS_MS
): Promise<void> {
  const processing = page.getByTestId(TESTID.processing);
  const deadline = Date.now() + timeoutMs;
  let lastNavigation = Date.now();

  while (Date.now() < deadline) {
    if (await processing.isVisible()) return;
    if (Date.now() - lastNavigation > 15_000) {
      await gotoSummaryPage(page);
      lastNavigation = Date.now();
    }
    await sleep(page, 3_000);
  }

  throw new Error(
    `the processing screen never appeared within ${timeoutMs / 60_000} minutes of the upload ` +
    '(did the S3 event -> metadata-handler hookup break?)'
  );
}

/**
 * Milestone 2: the pipeline finished and the processed summary is on screen.
 *
 * The summary page polls its own API every few seconds; the occasional
 * re-navigation is a belt against a client-side polling hiccup over such a
 * long window. Returns the language code of the tab pane that came up.
 */
export async function waitForProcessedSummary(
  page: Page,
  timeoutMs: number = SUMMARY_APPEARS_MS
): Promise<string> {
  const anyPanel = page.locator('[data-testid^="summary-tab-panel-"]:visible').first();
  const failed = page.getByTestId(TESTID.failed);
  const deadline = Date.now() + timeoutMs;
  let lastNavigation = Date.now();

  while (Date.now() < deadline) {
    if (await failed.isVisible()) {
      throw new Error('the pipeline reported FAILED for the uploaded document');
    }
    if (await anyPanel.isVisible()) {
      const testId = await anyPanel.getAttribute('data-testid');
      return (testId ?? '').replace('summary-tab-panel-', '');
    }
    if (Date.now() - lastNavigation > 60_000) {
      await gotoSummaryPage(page);
      lastNavigation = Date.now();
    }
    await sleep(page, 5_000);
  }

  throw new Error(
    `the processed summary never appeared within ${timeoutMs / 60_000} minutes ` +
    '(pipeline stuck or slower than the budget; check the Step Functions execution)'
  );
}

/** The visible tab pane for `lang` (inactive panes stay in the DOM, hidden). */
export function summaryPanel(page: Page, lang: string): Locator {
  return page.getByTestId(TESTID.tabPanel(lang));
}

/** The summary prose for `lang`, whitespace-collapsed. */
export async function summaryTextFor(page: Page, lang: string): Promise<string> {
  const text = await page.getByTestId(TESTID.summaryText(lang)).innerText();
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Switch the summary page to another language through its dropdown.
 *
 * Worth knowing while debugging: this control is NOT a tab switcher. The tab
 * nav is hidden by CSS (.hidden-tab-nav) and the dropdown writes
 * secondaryLanguage to the PROFILE; the active tab follows from that, and the
 * non-preferred translated tab is unmounted entirely while English is
 * selected. The dropdown itself only renders once the document carries
 * summaries in more than one language.
 */
export async function selectSummaryLanguage(page: Page, lang: string): Promise<void> {
  const toggle = page.locator('#language-dropdown');
  await expect(
    toggle,
    'the summary page language dropdown is missing: the document has content in only one ' +
    'language, so the translation step never produced anything'
  ).toBeVisible({ timeout: 30_000 });

  await toggle.click();
  await page.getByTestId(TESTID.languageOption(lang)).click();
  await expect(summaryPanel(page, lang)).toBeVisible({ timeout: 60_000 });
}

/** Every TTS button currently rendered (summary + expanded sections). */
export function ttsButtons(page: Page): Locator {
  return page.getByTestId(TESTID.ttsButton);
}

/** Buttons whose data-tts-state says they are playing right now. */
export function playingTtsButtons(page: Page): Locator {
  return page.locator(`[data-testid="${TESTID.ttsButton}"][data-tts-state="playing"]`);
}

export async function ttsState(button: Locator): Promise<string | null> {
  return button.getAttribute('data-tts-state');
}

/**
 * Open the first Key Insights section inside a tab pane and hand back its TTS
 * button. Section audio buttons live in the accordion body, which is
 * collapsed (and therefore not clickable) until the header is opened.
 */
export async function openFirstSectionWithAudio(panel: Locator): Promise<Locator> {
  const sections = panel.getByTestId(TESTID.section);

  // Section audio buttons only mount once the summary page has normalized its
  // sections (each section's canonical name arrives a render after the raw API
  // shape, and the page withholds the button until then, because a request
  // without it is rejected). Sampling the DOM once raced that, so wait for a
  // section that actually has a button before picking one.
  await expect(async () => {
    const total = await sections.count();
    for (let index = 0; index < total; index++) {
      if ((await sections.nth(index).getByTestId(TESTID.ttsButton).count()) > 0) return;
    }
    throw new Error('no section audio button has mounted yet');
  }).toPass({ timeout: 30_000 });

  const count = await sections.count();
  for (let index = 0; index < count; index++) {
    const section = sections.nth(index);
    const button = section.getByTestId(TESTID.ttsButton);
    // The client-built Abbreviations table deliberately has no audio button.
    if ((await button.count()) === 0) continue;
    await section.getByRole('button').first().click();
    await expect(button).toBeVisible({ timeout: 15_000 });
    return button;
  }
  throw new Error('no Key Insights section with an audio button was rendered');
}

/** Assert the text reads as Spanish and is not just the English text again. */
export function expectSpanishAndDifferent(spanish: string, english: string): void {
  expect(
    spanish.length,
    'the translated summary is suspiciously short to be a real translation'
  ).toBeGreaterThan(120);
  expect(
    spanish,
    'the translated tab shows the SAME text as the English tab (translation step no-op?)'
  ).not.toBe(english);

  const padded = ` ${spanish.toLowerCase()} `;
  const hits = SPANISH_MARKERS.filter((marker) => padded.includes(marker));
  expect(
    hits.length,
    `the translated summary does not read as Spanish (matched ${hits.length} of the ` +
    `common function words ${SPANISH_MARKERS.join(',')}): ${spanish.slice(0, 200)}`
  ).toBeGreaterThanOrEqual(3);
}

interface ScriptRule {
  /** Global on purpose: the matches are COUNTED, not merely found. */
  pattern: RegExp;
  /** How many of them a pane must hold before it counts as translated. */
  minimum: number;
  /** Named in the failure message. */
  what: string;
}

/**
 * What a real translation into each rotation language must contain.
 *
 * One rule per language, and each one is chosen so that content the
 * translation step left in ENGLISH cannot satisfy it. Counting rather than
 * testing for a single hit also rules out a stray proper noun or a quoted
 * phrase carrying the whole assertion.
 */
const TRANSLATED_SCRIPTS: Record<string, ScriptRule> = {
  // CJK Unified Ideographs. Neither English nor Spanish text contains one, and
  // a 120-character Chinese passage is almost entirely made of them.
  zh: { pattern: /[\u4e00-\u9fff]/g, minimum: 20, what: 'Chinese characters' },

  // The Arabic block (letters, Arabic-Indic digits and Arabic punctuation).
  // Same argument as Chinese: a different script altogether.
  ar: { pattern: /[\u0600-\u06ff]/g, minimum: 20, what: 'Arabic-script characters' },

  // Vietnamese is the awkward one: it is Latin script, so "has diacritics"
  // proves nothing. Spanish has acute-accented vowels plus u-diaeresis and
  // n-tilde, and every one of those lives in Latin-1 Supplement
  // (U+00C0-U+00FF), which this range deliberately excludes. What is left is
  // the set only Vietnamese uses: the breved, barred and horned letters
  // A-breve (U+0102/0103), D-bar (U+0110/0111), O-horn (U+01A0/01A1) and
  // U-horn (U+01AF/01B0), plus the whole tone-marked block in Latin Extended
  // Additional (U+1EA0-U+1EF9). Vietnamese prose is dense with them (duoc,
  // cua, hoc, mot are all spelled with one), and English and Spanish hold
  // none at all.
  vi: {
    pattern: /[\u0102\u0103\u0110\u0111\u01a0\u01a1\u01af\u01b0\u1ea0-\u1ef9]/g,
    minimum: 5,
    what: 'Vietnamese-only letters (A-breve, D-bar, O-horn, U-horn and U+1EA0-U+1EF9)',
  },
};

/**
 * Assert an on-demand translation pane holds a real translation into
 * `language`.
 *
 * A missing rule THROWS rather than passing: a sixth language added to the app
 * would be picked up by the rotation automatically, and accepting its pane
 * without a script check would quietly green-stamp untranslated English.
 */
export function expectOnDemandTranslation(
  text: string,
  language: string = ON_DEMAND_LANGUAGE
): void {
  const rule = TRANSLATED_SCRIPTS[language];
  if (!rule) {
    throw new Error(
      `no content assertion is defined for ${language}: add one to TRANSLATED_SCRIPTS in ` +
      'e2e/helpers/documents.ts. Accepting the pane without one would let untranslated ' +
      'English through.'
    );
  }

  expect(
    text.length,
    `the requested ${language} translation is suspiciously short to be a real one`
  ).toBeGreaterThan(120);

  // NFC first: the same Vietnamese letter can arrive precomposed (one code
  // point, U+1EC7) or decomposed (a base letter plus combining marks), and
  // only the precomposed form is in the range above.
  const hits = text.normalize('NFC').match(rule.pattern)?.length ?? 0;
  expect(
    hits,
    `the ${language} pane holds ${hits} ${rule.what}, fewer than the ${rule.minimum} a real ` +
    `translation carries, so the on-demand translation produced untranslated content: ` +
    text.slice(0, 200)
  ).toBeGreaterThanOrEqual(rule.minimum);
}
