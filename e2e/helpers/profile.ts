/**
 * Profile / account-center helpers.
 *
 * Everything here drives the real deployed screens under /account-center
 * (plus the child form at /view-update-add-child). Two rules shape the API:
 *
 * 1. Every "open" helper does a FULL page load (page.goto), never an in-app
 *    click-through. The pages cache their profile in react-query for the
 *    lifetime of the document, so only a real reload re-issues GET /profile:
 *    that is what turns an assertion into a statement about the SERVER (and,
 *    for parentName, about the KMS encrypt/decrypt round trip) instead of
 *    about React state.
 * 2. Selectors are language-independent: a run can start with the account in
 *    any language (a previous run could have died mid-language-switch), so
 *    localized button labels are off limits. Ids that the app already sets
 *    (#formParentName, #formChildName, #formSchoolCity) plus the handful of
 *    data-testids added for this suite are the anchors.
 */
import { Locator, Page, expect } from '@playwright/test';
import { appUrl } from './config';

/** The screens this journey drives. */
export const PROFILE_PATHS = {
  accountCenter: '/account-center',
  /** parent-name form (UpdateProfileName) */
  parentName: '/account-center/profile',
  /** secondary-language picker (ChangeLanguage) */
  language: '/account-center/change-language',
  /** first child's name + school district (ViewAndAddChild) */
  child: '/view-update-add-child',
} as const;

/**
 * The state the profile user (helpers/phones.ts#PROFILE_USER, +15555550113)
 * is left in by every run. The spec resets to it at the START (healing
 * whatever a crashed run left behind) and restores it at the end, so the
 * next run can rely on it.
 */
export const PROFILE_BASELINE = {
  parentName: 'E2E Profile Parent',
  childName: 'E2E Profile Child',
  schoolCity: 'E2E Test City',
  language: 'en',
} as const;

/** Where the language context mirrors the UI language (see
 * src/common/language-context.ts). Removing it makes a reload boot in English
 * regardless of the profile, which is how the spec proves the SERVER, and not
 * localStorage, is holding the language preference. */
export const LANGUAGE_STORAGE_KEY = 'aiep-language-preference';

/** A value nothing else could have written: marker + wall clock. */
export function markedValue(prefix: string): string {
  return `${prefix} ${Date.now()}`;
}

// ── Locators ────────────────────────────────────────────────────────────────

export const parentNameInput = (page: Page): Locator => page.locator('#formParentName');
export const parentNameSubmit = (page: Page): Locator => page.getByTestId('update-profile-submit');
export const languageSelect = (page: Page): Locator => page.getByTestId('language-select');
export const childNameInput = (page: Page): Locator => page.locator('#formChildName');
export const childSchoolCityInput = (page: Page): Locator => page.locator('#formSchoolCity');
export const childSubmit = (page: Page): Locator => page.getByTestId('child-save-button');

export type AccountCenterRow =
  | 'update-profile'
  | 'change-language'
  | 'delete-account'
  | 'invite'
  | 'log-out';

/** An account-center accordion row. The testid sits on the <h2> header, so
 * this drills to the button inside it that actually carries the handler. */
export const accountCenterRow = (page: Page, row: AccountCenterRow): Locator =>
  page.getByTestId(`account-center-${row}`).getByRole('button');

// ── Parent name (KMS-encrypted at rest) ─────────────────────────────────────

export async function openParentNameForm(page: Page): Promise<void> {
  await page.goto(appUrl(PROFILE_PATHS.parentName));
  await expect(parentNameInput(page)).toBeVisible();
}

/**
 * The name currently stored for the account, as the reloaded form shows it.
 *
 * The input renders one frame before the fetched profile lands in it, so the
 * read waits for a non-empty value first. An onboarded account always has a
 * name (the flow refuses to leave the form without one), so an empty box here
 * means something is genuinely wrong and failing on the wait is correct.
 */
export async function readParentName(page: Page): Promise<string> {
  await expect(parentNameInput(page)).not.toHaveValue('');
  return parentNameInput(page).inputValue();
}

/**
 * Save a new parent name from the loaded form. On success the page chains
 * PUT /profile (+ a default child and showOnboarding=false when they are
 * missing) and then routes to the account center: that navigation is the
 * "the API resolved" signal, not merely elapsed time.
 */
export async function saveParentName(page: Page, name: string): Promise<void> {
  await parentNameInput(page).fill(name);
  await expect(parentNameSubmit(page)).toBeEnabled();
  await parentNameSubmit(page).click();
  await page.waitForURL((url) => url.pathname === PROFILE_PATHS.accountCenter, {
    timeout: 45_000,
  });
}

// ── The child (name + school district) ──────────────────────────────────────

export async function openChildForm(page: Page): Promise<void> {
  await page.goto(appUrl(PROFILE_PATHS.child));
  // This page fills its state before it swaps the spinner for the form, so a
  // visible input already holds the server's value (no empty first frame).
  await expect(childNameInput(page)).toBeVisible();
  await expect(childSchoolCityInput(page)).toBeVisible();
}

export async function readChild(page: Page): Promise<{ name: string; schoolCity: string }> {
  return {
    name: await childNameInput(page).inputValue(),
    schoolCity: await childSchoolCityInput(page).inputValue(),
  };
}

/**
 * Save the first child from the loaded form. The page edits children[0] in
 * place when one exists and creates it otherwise, so this both renames and
 * (on a child-less profile) adds, and the profile keeps exactly one child.
 * Saving routes away from the form; the navigation is the success signal.
 */
export async function saveChild(page: Page, name: string, schoolCity: string): Promise<void> {
  await childNameInput(page).fill(name);
  await childSchoolCityInput(page).fill(schoolCity);
  await expect(childSubmit(page)).toBeEnabled();
  await childSubmit(page).click();
  await page.waitForURL((url) => url.pathname !== PROFILE_PATHS.child, { timeout: 45_000 });
}

// ── Language preference ─────────────────────────────────────────────────────

export async function openLanguageForm(page: Page): Promise<void> {
  await page.goto(appUrl(PROFILE_PATHS.language));
  await expect(languageSelect(page)).toBeVisible();
}

/** The stored secondary language, as the reloaded picker shows it (the select
 * renders straight from the fetched profile, no effect in between). */
export async function readLanguagePreference(page: Page): Promise<string> {
  await expect(languageSelect(page)).toBeEnabled();
  return languageSelect(page).inputValue();
}

/**
 * Pick a language on the loaded picker. There is no save button: the change
 * fires an optimistic UI switch plus PUT /profile, so we wait for that exact
 * response (and for the select, disabled while the mutation is in flight, to
 * come back) instead of guessing at a settle time.
 */
export async function setLanguagePreference(page: Page, code: string): Promise<void> {
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/profile') &&
      response.request().method() === 'PUT' &&
      response.ok(),
    { timeout: 45_000 }
  );
  await languageSelect(page).selectOption(code);
  await saved;
  await expect(languageSelect(page)).toBeEnabled();
}

/** Forget the browser's copy of the UI language. The next load then boots in
 * English no matter what the profile says, which isolates "the server kept
 * the preference" from "this tab remembered it". */
export async function clearStoredUiLanguage(page: Page): Promise<void> {
  await page.evaluate((key) => window.localStorage.removeItem(key), LANGUAGE_STORAGE_KEY);
}

// ── Baseline ────────────────────────────────────────────────────────────────

/**
 * Put PROFILE_USER back on PROFILE_BASELINE and assert it landed there.
 *
 * Called at the start of the spec (so a run that died halfway through, e.g.
 * leaving the account in Spanish, cannot poison this one) and again at the
 * end (so the next run starts from the documented state). Each field is read
 * first and only written when it differs, which makes the common end-to-end
 * cost three page loads and no API writes.
 *
 * Language goes first: it decides what copy every other screen renders.
 */
export async function ensureProfileBaseline(page: Page): Promise<void> {
  await openLanguageForm(page);
  if ((await readLanguagePreference(page)) !== PROFILE_BASELINE.language) {
    await setLanguagePreference(page, PROFILE_BASELINE.language);
    await openLanguageForm(page);
  }
  await expect(languageSelect(page)).toHaveValue(PROFILE_BASELINE.language);

  await openParentNameForm(page);
  if ((await readParentName(page)) !== PROFILE_BASELINE.parentName) {
    await saveParentName(page, PROFILE_BASELINE.parentName);
    await openParentNameForm(page);
  }
  await expect(parentNameInput(page)).toHaveValue(PROFILE_BASELINE.parentName);

  await openChildForm(page);
  const child = await readChild(page);
  if (child.name !== PROFILE_BASELINE.childName || child.schoolCity !== PROFILE_BASELINE.schoolCity) {
    await saveChild(page, PROFILE_BASELINE.childName, PROFILE_BASELINE.schoolCity);
    await openChildForm(page);
  }
  await expect(childNameInput(page)).toHaveValue(PROFILE_BASELINE.childName);
  await expect(childSchoolCityInput(page)).toHaveValue(PROFILE_BASELINE.schoolCity);
}
