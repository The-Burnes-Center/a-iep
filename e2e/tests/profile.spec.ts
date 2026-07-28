/**
 * The settings journey: everything a parent can change about themselves.
 *
 * What makes this worth a real browser (rather than an API test) is the
 * round trip. parentName is KMS-encrypted before it hits DynamoDB and
 * decrypted on the way back out, so "type a name, save, RELOAD, still there"
 * is the only cheap end-to-end proof that the encrypt/decrypt pair, the KMS
 * grant and the PUT/GET handlers all still agree. Same shape for the child
 * record and for the language preference, which additionally drives the
 * translations the pipeline produces and the language the OTP SMS is written
 * in.
 *
 * Every assertion is made after a FULL page load (helpers/profile.ts only
 * ever navigates with page.goto): the pages cache their profile in
 * react-query, so an in-app click-through would happily assert React state
 * back at us.
 *
 * END STATE (the next run depends on it, and so does the reset at the top of
 * this one). PROFILE_USER is left with:
 *     parentName        = 'E2E Profile Parent'
 *     children          = exactly one, 'E2E Profile Child' / 'E2E Test City'
 *     secondaryLanguage = 'en'
 * i.e. PROFILE_BASELINE. The spec resets to it at the START as well, so a
 * previous run that died mid-language-switch (leaving the account in
 * Spanish) cannot poison this one, and a Playwright retry starts clean.
 *
 * Fast by design (~1.5 min): no document pipeline, no account deletion, so
 * this runs on every staging deploy rather than nightly.
 */
import { test, expect } from '@playwright/test';
import { loginWithOtp } from '../helpers/app';
import { appUrl } from '../helpers/config';
import { PROFILE_USER } from '../helpers/phones';
import {
  PROFILE_BASELINE,
  PROFILE_PATHS,
  accountCenterRow,
  childNameInput,
  childSchoolCityInput,
  clearStoredUiLanguage,
  ensureProfileBaseline,
  languageSelect,
  markedValue,
  openChildForm,
  openLanguageForm,
  openParentNameForm,
  parentNameInput,
  parentNameSubmit,
  readLanguagePreference,
  saveChild,
  saveParentName,
  setLanguagePreference,
} from '../helpers/profile';

/** Copy the steps key on, mirroring src/translations/{en,es}.json. */
const COPY = {
  accountCenterTitle: 'Account Center',
  languageTitleEn: 'Your Language',
  languageTitleEs: 'Su Idioma',
  languageBreadcrumbEs: 'CUENTA',
} as const;

test('profile settings round-trip: parent name, child, language preference', async ({ page }) => {
  // A steady-state run is ~90s (sign-in, then a dozen page loads against a
  // real CDN + API). The headroom over the suite default is for the FIRST
  // ever run on this number, which additionally walks onboarding and has to
  // write every baseline field instead of just reading it.
  test.setTimeout(240_000);

  await test.step('log in as the profile user', async () => {
    // First ever run for this number also walks the real onboarding
    // (language pick -> consent -> name), which is what creates the profile
    // row and its default child; every later run just signs in.
    await loginWithOtp(page, PROFILE_USER);
  });

  await test.step('reset the account to the documented baseline', async () => {
    // At the START, not only at the end: a crashed previous attempt is the
    // normal reason for the account to be off-baseline, and the language
    // steps below assert on English copy.
    await ensureProfileBaseline(page);
  });

  await test.step('reach the profile form the way a parent does', async () => {
    await page.goto(appUrl(PROFILE_PATHS.accountCenter));
    await expect(page.getByRole('heading', { name: COPY.accountCenterTitle })).toBeVisible();

    await accountCenterRow(page, 'update-profile').click();
    await page.waitForURL((url) => url.pathname === PROFILE_PATHS.parentName);
    await expect(parentNameInput(page)).toHaveValue(PROFILE_BASELINE.parentName);
  });

  const markedName = markedValue('E2E Parent');
  await test.step('the parent name survives the encrypted round trip', async () => {
    await saveParentName(page, markedName);

    // Reload: the value can now only have come back out of DynamoDB through
    // KMS decryption, so matching the marker proves the whole path.
    await openParentNameForm(page);
    await expect(parentNameInput(page)).toHaveValue(markedName);
  });

  await test.step('an empty name cannot be saved', async () => {
    // The only client-side validation on this form: the submit button is
    // disabled while the (trimmed) name is empty.
    await parentNameInput(page).fill('   ');
    await expect(parentNameSubmit(page)).toBeDisabled();
    await parentNameInput(page).fill('');
    await expect(parentNameSubmit(page)).toBeDisabled();
    // Nothing was saved; the restore step at the end resets the field anyway.
  });

  await test.step("the child's name and school district persist", async () => {
    const markedChild = markedValue('E2E Child');
    const markedCity = markedValue('E2E City');

    await openChildForm(page);
    await saveChild(page, markedChild, markedCity);

    await openChildForm(page);
    await expect(childNameInput(page)).toHaveValue(markedChild);
    await expect(childSchoolCityInput(page)).toHaveValue(markedCity);
  });

  await test.step('the language preference persists server-side and localizes the UI', async () => {
    await openLanguageForm(page);
    expect(await readLanguagePreference(page)).toBe(PROFILE_BASELINE.language);
    await expect(page.getByRole('heading', { name: COPY.languageTitleEn })).toBeVisible();

    // The picker has no save button: choosing fires PUT /profile and an
    // optimistic UI switch, so the copy turns Spanish before any reload.
    await setLanguagePreference(page, 'es');
    await expect(page.getByRole('heading', { name: COPY.languageTitleEs })).toBeVisible();
    // exact (= case-sensitive) on purpose: the top navigation renders a
    // 'Cuenta' item that a loose match would also hit.
    await expect(page.getByText(COPY.languageBreadcrumbEs, { exact: true })).toBeVisible();

    // Drop the browser's copy of the UI language and reload. The picker's
    // value can then only come from GET /profile ('es' = the PUT stuck),
    // while the surrounding copy comes back in English (proving the previous
    // assertion was not just localStorage talking).
    await clearStoredUiLanguage(page);
    await openLanguageForm(page);
    await expect(languageSelect(page)).toHaveValue('es');
    await expect(page.getByRole('heading', { name: COPY.languageTitleEn })).toBeVisible();
  });

  await test.step('leave the account on the documented baseline', async () => {
    // Restores AND verifies: the same helper the spec opened with, so the
    // end state is asserted rather than assumed.
    await ensureProfileBaseline(page);
  });
});
