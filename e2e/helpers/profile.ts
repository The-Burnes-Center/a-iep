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
 *    (#formParentName, #formChildName) plus the handful of
 *    data-testids added for this suite are the anchors.
 */
import { Locator, Page, expect } from '@playwright/test';
import { appUrl } from './config';

/** The screens this journey drives. */
export const PROFILE_PATHS = {
  accountCenter: '/account-center',
  /** parent-name form (UpdateProfileName) */
  parentName: '/account-center/profile',
  /** any signed-in screen: the language picker lives in the top bar */
  language: '/account-center',
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
/** The top bar's language picker (LanguagePreferenceDropdown via LanguageMenu). */
export const languageToggle = (page: Page): Locator => page.getByTestId('language-preference-toggle');
export const childNameInput = (page: Page): Locator => page.locator('#formChildName');
export const childSubmit = (page: Page): Locator => page.getByTestId('child-save-button');

export type AccountCenterRow =
  | 'update-profile'
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
}

export async function readChild(page: Page): Promise<{ name: string }> {
  return { name: await childNameInput(page).inputValue() };
}

/**
 * Save the first child from the loaded form. The page edits children[0] in
 * place when one exists and creates it otherwise, so this both renames and
 * (on a child-less profile) adds, and the profile keeps exactly one child.
 * Saving routes away from the form; the navigation is the success signal.
 */
export async function saveChild(page: Page, name: string): Promise<void> {
  await childNameInput(page).fill(name);
  await expect(childSubmit(page)).toBeEnabled();
  await childSubmit(page).click();
  await page.waitForURL((url) => url.pathname !== PROFILE_PATHS.child, { timeout: 45_000 });
}

// ── Language preference ─────────────────────────────────────────────────────

export async function openLanguageForm(page: Page): Promise<void> {
  await page.goto(appUrl(PROFILE_PATHS.language));
  await expect(languageToggle(page)).toBeVisible();
}

/**
 * The language the bar's picker shows as chosen. The toggle marks its
 * language name up in that language (lang="es"), which is the one value on it
 * that does not depend on the copy around it. Before the profile has loaded
 * the picker shows the screen's language as a stand-in (data-ready="false"),
 * so this waits for the profile and for any save in flight first.
 */
export async function readLanguagePreference(page: Page): Promise<string> {
  await expect(languageToggle(page)).toHaveAttribute('data-ready', 'true');
  await expect(languageToggle(page)).not.toHaveAttribute('aria-disabled', 'true');
  return (await languageToggle(page).locator('[lang]').getAttribute('lang')) ?? '';
}

/** Whether the bar's picker offers a language. The menu mounts only when
 * open, so this opens it, counts, and closes it again with Escape. */
export async function offeredLanguageCount(page: Page, code: string): Promise<number> {
  await languageToggle(page).click();
  await expect(page.getByTestId('language-preference-option-en')).toBeVisible();
  const count = await page.getByTestId(`language-preference-option-${code}`).count();
  await page.keyboard.press('Escape');
  return count;
}

export async function expectLanguagePreference(page: Page, code: string): Promise<void> {
  await expect(languageToggle(page).locator('[lang]')).toHaveAttribute('lang', code);
}

/**
 * Pick a language in the bar's picker. There is no save button: the choice
 * fires an optimistic UI switch plus PUT /profile, so we wait for that exact
 * response, and for the picker (unavailable while the save is in flight) to
 * come back, instead of guessing at a settle time.
 */
export async function setLanguagePreference(page: Page, code: string): Promise<void> {
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/profile') &&
      response.request().method() === 'PUT' &&
      response.ok(),
    { timeout: 45_000 }
  );
  await languageToggle(page).click();
  await page.getByTestId(`language-preference-option-${code}`).click();
  await saved;
  await expect(languageToggle(page)).not.toHaveAttribute('aria-disabled', 'true');
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
  await expectLanguagePreference(page, PROFILE_BASELINE.language);

  await openParentNameForm(page);
  if ((await readParentName(page)) !== PROFILE_BASELINE.parentName) {
    await saveParentName(page, PROFILE_BASELINE.parentName);
    await openParentNameForm(page);
  }
  await expect(parentNameInput(page)).toHaveValue(PROFILE_BASELINE.parentName);

  await openChildForm(page);
  const child = await readChild(page);
  if (child.name !== PROFILE_BASELINE.childName) {
    await saveChild(page, PROFILE_BASELINE.childName);
    await openChildForm(page);
  }
  await expect(childNameInput(page)).toHaveValue(PROFILE_BASELINE.childName);
}
