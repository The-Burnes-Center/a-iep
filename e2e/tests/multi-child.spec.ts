/**
 * More than one child on one account (the multiChild feature, on in staging,
 * dark in production): a parent adds a second child, every screen about that
 * child says whose IEP it is, the upload says whose it will be before it is
 * sent, and My children lists both.
 *
 * The upload is staged but not sent: the documents journey already drives the
 * pipeline end to end, and what this one pins is WHICH child each screen is
 * about. Which child an upload goes to is covered at the request level by the
 * frontend's multi-child.test.tsx and the upload lambda's ownership tests.
 *
 * A brand-new parent every attempt (MULTI_CHILD_USER is healed at the top
 * and admin-deleted afterwards), so the account never accumulates children.
 */
import * as path from 'path';
import { test, expect } from '../helpers/fixtures';
import { EN, loginWithOtp } from '../helpers/app';
import { deleteTestUserIfExists, ensureTestUser } from '../helpers/aws';
import { MULTI_CHILD_USER } from '../helpers/phones';

const SECOND_CHILD = 'Sam Rivera';
const FIXTURE = path.join(__dirname, '../fixtures/synthetic-iep.pdf');

test.afterEach(async () => {
  await deleteTestUserIfExists(MULTI_CHILD_USER);
});

test('a parent adds a second child and every screen about them says whose IEP it is', async ({ page }) => {
  // One full login with onboarding, then a handful of screens.
  test.setTimeout(240_000);

  await deleteTestUserIfExists(MULTI_CHILD_USER);
  await ensureTestUser(MULTI_CHILD_USER);
  await loginWithOtp(page, MULTI_CHILD_USER);

  // One child: none of the multi-child chrome, so this family sees prod's screens.
  await expect(page.getByTestId('child-bar')).toHaveCount(0);

  // ---- Account -> My children -> Add a child ------------------------------
  await page.getByRole('button', { name: EN.navigateToAccount }).click();
  await page.waitForURL((url) => url.pathname === '/account-center');
  await page.getByTestId('account-center-my-children').click();
  await page.waitForURL((url) => url.pathname === '/account-center/children');
  await expect(page.getByTestId('my-children-card')).toHaveCount(1);

  await page.getByTestId('my-children-add').click();
  await page.waitForURL((url) => url.pathname === '/account-center/children/add');
  await page.getByTestId('add-child-name').fill(SECOND_CHILD);
  await page.getByTestId('add-child-save').click();

  // ---- Straight to uploading the NEW child's IEP --------------------------
  await page.waitForURL((url) => url.pathname === '/iep-documents' && url.searchParams.has('child'), { timeout: 30_000 });
  const secondChildId = new URL(page.url()).searchParams.get('child');
  expect(secondChildId).toBeTruthy();

  await expect(page.getByTestId('child-bar-name')).toContainText(SECOND_CHILD);
  await expect(page.getByTestId('child-bar-switch')).toHaveText('Switch');
  await expect(page.getByTestId('upload-child-badge')).toContainText(SECOND_CHILD);

  // The last thing read before sending: whose IEP this will be.
  await page.locator('#fileUpload').setInputFiles(FIXTURE);
  await expect(page.getByTestId('upload-belongs-to')).toContainText(SECOND_CHILD);
  await expect(page.getByTestId('upload-submit-button')).toContainText(`Upload for ${SECOND_CHILD}`);

  // ---- Switch child -> My children lists both, each with its own action ---
  await page.getByTestId('child-bar-switch').click();
  await page.waitForURL((url) => url.pathname === '/account-center/children');
  const cards = page.getByTestId('my-children-card');
  await expect(cards).toHaveCount(2);
  const second = cards.filter({ hasText: SECOND_CHILD });
  await expect(second).toContainText('No IEP yet');
  await expect(second.getByRole('link')).toHaveAttribute('href', `/iep-documents?child=${secondChildId}`);

  // The first child's card leads to the first child, not the second.
  const first = cards.filter({ hasNotText: SECOND_CHILD });
  await expect(first.getByRole('link')).not.toHaveAttribute('href', new RegExp(secondChildId as string));
});
