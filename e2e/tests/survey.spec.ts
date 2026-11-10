/**
 * The family survey (onboardingSurvey: on in staging, dark in production),
 * walked by a brand-new parent against the real API.
 *
 * What this pins that the frontend's survey.test.tsx cannot: every answer the
 * screens send is one the deployed user-profile-handler accepts. The two
 * share survey_schema.json, but only a real save proves the route, the
 * authorizer and the validation agree, and that the walk resumes from what
 * the SERVER kept rather than from the page.
 *
 * No IEP is uploaded, so no pipeline runs: the documents journey already
 * drives that, and the upload -> invite redirect is covered at the request
 * level by survey.test.tsx. The survey is reachable without a document (its
 * banner just says nothing about one).
 */
import { test, expect } from '../helpers/fixtures';
import { loginWithOtp } from '../helpers/app';
import { deleteTestUserIfExists, ensureTestUser } from '../helpers/aws';
import { appUrl } from '../helpers/config';
import { SURVEY_USER } from '../helpers/phones';

const PARTS = ['About', 'Understanding', 'Taking part in IEP meetings', 'IEP itself', 'About you'];

test.afterEach(async () => {
  await deleteTestUserIfExists(SURVEY_USER);
});

test('a new parent is asked how many children have an IEP, then answers the survey', async ({ page }) => {
  test.setTimeout(240_000);

  await deleteTestUserIfExists(SURVEY_USER);
  await ensureTestUser(SURVEY_USER);

  // Onboarding walks /your-children (the walker answers 1). Seeing the
  // screen at all is the check that consent routes there with the flag on.
  const askedHowMany = page.waitForURL((url) => url.pathname === '/your-children', { timeout: 120_000 });
  await loginWithOtp(page, SURVEY_USER);
  await askedHowMany;

  // ---- The invite ------------------------------------------------------------
  await page.goto(appUrl('/survey'));
  await expect(page.getByTestId('survey-title')).toHaveText('Can you help us improve A-IEP?', { timeout: 30_000 });
  await page.getByRole('checkbox').check(); // research consent, unticked by default
  await page.getByTestId('survey-start').click();

  // ---- Part 1, then leave and come back: the server kept the place ----------
  await expect(page.getByTestId('survey-title')).toContainText(PARTS[0]);
  await page.getByRole('radio', { name: 'Yes', exact: true }).first().check();
  await page.getByTestId('survey-next').click();
  await expect(page.getByTestId('survey-title')).toContainText(PARTS[1]);
  await page.getByRole('radio', { name: 'Agree', exact: true }).first().check();
  await page.getByTestId('survey-later').click();
  await page.waitForURL((url) => url.pathname !== '/survey', { timeout: 30_000 });

  await page.goto(appUrl('/survey'));
  await expect(page.getByTestId('survey-title')).toContainText(PARTS[1], { timeout: 30_000 });
  await expect(page.getByRole('radio', { name: 'Agree', exact: true }).first()).toBeChecked();

  // ---- The rest, including one disagreement and its follow-up box ----------
  await page.getByTestId('survey-next').click();
  await expect(page.getByTestId('survey-title')).toContainText(PARTS[2]);
  await page.getByRole('radio', { name: 'Disagree', exact: true }).first().check();
  await page.getByLabel(/tell us why/i).fill('Synthetic E2E answer');
  await page.getByTestId('survey-next').click();
  await expect(page.getByTestId('survey-title')).toContainText(PARTS[3]);
  await page.getByTestId('survey-next').click();
  await expect(page.getByTestId('survey-title')).toContainText(PARTS[4]);
  await page.getByRole('radio', { name: 'Never tried it', exact: true }).check();
  await page.getByTestId('survey-next').click();

  await expect(
    page.getByTestId('survey-title'),
    'the last part did not save: the server refused an answer the screen offered, or the walk lost its place',
  ).toHaveText('Thank you', { timeout: 30_000 });

  // Finished is finished: coming back opens on the thank-you, not part 1.
  await page.goto(appUrl('/survey'));
  await expect(page.getByTestId('survey-title')).toHaveText('Thank you', { timeout: 30_000 });
});
