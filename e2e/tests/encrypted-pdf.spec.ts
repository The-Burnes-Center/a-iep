/**
 * A parent's own password-protected PDF, from the file picker to the bytes
 * that leave the browser.
 *
 * The app used to refuse an encrypted PDF outright ("save a copy without the
 * password and upload that instead"). It now detects the encryption before
 * the upload, opens the file in the browser, and uploads a decrypted rebuild:
 * silently when the file only carries owner restrictions, and behind a
 * password prompt when a real user password is required. Three things have to
 * hold, and each is a stage below:
 *
 *  1. An owner-restricted file (an encryption dictionary with an EMPTY user
 *     password, e.g. a district PDF that blocks printing) uploads with NO
 *     prompt. A parent who never set a password must never be asked for one.
 *  2. A file with a real user password prompts, says so when the password is
 *     wrong, and goes through when it is right.
 *  3. Cancelling the prompt stages nothing (stage 3) and says nothing
 *     (stage 4). The parent backed out; they did not fail at something.
 *
 * WHAT THIS STOPS SHORT OF, AND WHY. The journey asserts the client-side flow
 * and the bytes the browser hands to the upload URL. It does not run the
 * pipeline, and it deliberately does not let a document reach S3:
 *
 *  - Cost and time. A real upload costs OCR, LLM and translation calls and
 *    takes tens of minutes, which is why documents.spec.ts gates the pipeline
 *    journeys behind RUN_PIPELINE_E2E=1 and CI's default run skips them. This
 *    spec runs in the DEFAULT suite instead, on every deploy, because the
 *    thing it covers is client-side and cheap. That is only possible because
 *    it stops at the upload boundary.
 *  - State and noise. Asking the real backend for an upload URL is not a
 *    read: upload-s3/index.mjs DELETES the child's existing document and
 *    writes a PENDING_UPLOAD row before it answers. A row whose PUT never
 *    lands is failed closed 15 minutes later by the pending-upload sweep,
 *    which logs RECORD_FAILURE, and the DocumentFailures alarm fires on a
 *    count of ONE (DOCUMENT_FAILURE_ALARM_THRESHOLD in monitoring.ts). Left
 *    real, this spec would page staging twice per run and make a real alarm
 *    decorative.
 *
 * So POST /signed-url-knowledge is answered with a same-origin stub URL, and
 * the PUT to that URL is captured instead of sent. Everything before that
 * boundary is the real deployed app: the real login, the real upload page,
 * the real lazily-loaded pdf.js chunk, the real prompt, the real rebuild.
 *
 * The assertion that carries the weight is on the CAPTURED BYTES, not on "a
 * file came back": a rebuild that never happened would upload the encrypted
 * original, so every upload stage checks the bytes start with %PDF-, carry no
 * /Encrypt entry, and are not the fixture that went in.
 *
 * Which rebuild produced them is NOT asserted anywhere. The app tries a
 * lossless rebuild first and falls back to rasterizing the pages, neither is
 * observable from the browser, and which one runs changes with the deployed
 * build.
 *
 * Fixtures are generated in-process and never touch disk: see
 * helpers/encrypted-pdf.ts, including why nothing from docs/sample-ieps/ can
 * be used here.
 */
import { test, expect, BrowserContext, Locator, Page } from '@playwright/test';
import playwrightConfig from '../playwright.config';
import { loginWithOtp } from '../helpers/app';
import { ensureTestUser } from '../helpers/aws';
import { appUrl } from '../helpers/config';
import { gotoDocumentsPage, TESTID } from '../helpers/documents';
import {
  SyntheticPdfFile,
  hasEncryptEntry,
  ownerRestrictedPdf,
  passwordProtectedPdf,
  usesEmptyUserPassword,
} from '../helpers/encrypted-pdf';
import { ENCRYPTED_PDF_USER } from '../helpers/phones';

// Serial: every stage shares one signed-in page, so the suite pays for one
// OTP login instead of four. Each stage re-navigates to the upload page, so
// none of them depends on where the previous one finished.
test.describe.configure({ mode: 'serial' });

/** Obviously not a real password, and never reused anywhere. */
const FILE_PASSWORD = 'e2e-synthetic-file-password';
/** Wrong on purpose, and not a near-miss of the one above. */
const WRONG_PASSWORD = 'e2e-deliberately-wrong-guess';

/**
 * English copy this spec keys on, mirroring src/translations/en.json. The
 * password prompt (components/PdfPasswordPromptModal.tsx) carries no test id,
 * so its parts are addressed by role -- the dialog, its one password field,
 * its submit button, the danger alert -- and only the two strings below are
 * matched as text. Every Playwright context here starts fresh, and the app
 * boots in English with no stored preference, the same assumption
 * helpers/app.ts's EN block already makes.
 */
const EN = {
  passwordPromptTitle: 'This file needs a password',
  wrongPassword: "That password didn't work. Try again.",
  cancel: 'Cancel',
  noFileSelected: 'No File Selected',
  encryptedRefusal: "This PDF is password-protected and can't be processed.",
} as const;

/**
 * Where the stubbed signed-URL response points the uploader. Same origin as
 * the app on purpose: a cross-origin PUT with a Content-Type header would
 * need a CORS preflight, and this way there is nothing to preflight and
 * nothing that can reach the network if the route ever fails to match.
 */
const UPLOAD_STUB_PATH = '/__e2e-encrypted-pdf-upload-stub__';

interface CapturedUpload {
  contentType: string | undefined;
  body: Buffer;
}

let context: BrowserContext;
let page: Page;
/** Everything the browser PUT to the stub URL, newest last. Cleared before
 * each stage; stage 3 asserts it stays empty. */
const uploads: CapturedUpload[] = [];

/**
 * Answer POST /signed-url-knowledge with a stub URL and capture the PUT that
 * follows, so no document row is created and nothing reaches S3 (see the
 * docblock).
 *
 * The OPTIONS branch is for the preflight the cross-origin POST triggers:
 * whether Playwright hands a preflight to a route handler depends on the
 * browser build, so this answers one if asked and lets the real API answer it
 * otherwise. Authorization is listed explicitly because a wildcard in
 * Access-Control-Allow-Headers does not cover it.
 */
async function stubTheUploadBoundary(target: Page): Promise<void> {
  const stubUrl = appUrl(UPLOAD_STUB_PATH);

  await target.route(
    (url) => url.pathname.endsWith('/signed-url-knowledge'),
    async (route) => {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({
          status: 204,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'POST, OPTIONS',
            'access-control-allow-headers': 'authorization, content-type',
          },
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ signedUrl: stubUrl, iepId: 'e2e-encrypted-pdf-stub' }),
      });
    }
  );

  await target.route(stubUrl, async (route) => {
    const request = route.request();
    uploads.push({
      contentType: request.headers()['content-type'],
      body: request.postDataBuffer() ?? Buffer.alloc(0),
    });
    await route.fulfill({ status: 200, body: '' });
  });
}

/** The password prompt, addressed as what it is to a screen reader. */
function passwordPrompt(target: Page): Locator {
  return target.getByRole('dialog').filter({ hasText: EN.passwordPromptTitle });
}

/** The prompt's "that password didn't work" alert. */
function wrongPasswordAlert(target: Page): Locator {
  return passwordPrompt(target).getByRole('alert').filter({ hasText: EN.wrongPassword });
}

/** The staged-file row the upload form renders once a file is accepted. It is
 * absent entirely while nothing is staged. */
function stagedFile(target: Page): Locator {
  return target.locator('.file-list');
}

async function submitPassword(target: Page, password: string): Promise<void> {
  const prompt = passwordPrompt(target);
  await prompt.locator('input[type="password"]').fill(password);
  await prompt.locator('button[type="submit"]').click();
}

/**
 * The whole point of the feature, stated over the bytes that left the
 * browser: a real PDF, no longer encrypted, and not the file that was picked.
 *
 * The last of those three is what makes the other two mean something. A build
 * where the rebuild silently did nothing would still upload a PDF, and that
 * PDF would still be the parent's encrypted original.
 */
function expectDecryptedUpload(sent: CapturedUpload, fixture: SyntheticPdfFile): void {
  expect(sent.contentType, 'the upload did not go up as a PDF').toBe('application/pdf');
  expect(
    sent.body.length,
    'nothing was captured in the body of the upload request'
  ).toBeGreaterThan(0);
  expect(
    sent.body.subarray(0, 5).toString('latin1'),
    'what the browser uploaded is not a PDF at all'
  ).toBe('%PDF-');
  expect(
    hasEncryptEntry(sent.body),
    'the browser uploaded a file that STILL carries an /Encrypt entry: the pipeline ' +
    'rejects those, which is the failure this whole flow exists to prevent'
  ).toBe(false);
  expect(
    sent.body.equals(fixture.buffer),
    'the browser uploaded the encrypted original byte for byte, so no rebuild happened ' +
    '(the prompt and the staged file can both look right while this is true)'
  ).toBe(false);
}

test.describe('password-protected PDF upload (detect, prompt, decrypt in the browser)', () => {
  test.beforeAll(async ({ browser }) => {
    // Budget for an OTP login plus first-run onboarding on this number.
    test.setTimeout(4 * 60_000);

    // browser.newPage() does not pick up the config's `use` block, so restate
    // the mobile viewport this app is built for.
    context = await browser.newContext({ viewport: playwrightConfig.use?.viewport ?? null });
    page = await context.newPage();
    await stubTheUploadBoundary(page);

    await ensureTestUser(ENCRYPTED_PDF_USER);
    await loginWithOtp(page, ENCRYPTED_PDF_USER);
  });

  test.beforeEach(() => {
    uploads.length = 0;
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('1. an owner-restricted PDF uploads silently, with no prompt', async () => {
    const fixture = ownerRestrictedPdf();
    // Without these two, "no prompt appeared" is also what an unencrypted
    // file, or a file this helper failed to encrypt, would produce.
    expect(
      hasEncryptEntry(fixture.buffer),
      'the generated fixture carries no /Encrypt entry, so the app would never run the ' +
      'encrypted-PDF path at all and this stage would pass vacuously'
    ).toBe(true);
    expect(
      usesEmptyUserPassword(fixture.buffer),
      'the generated fixture needs a real user password, so it is the WRONG fixture for ' +
      'this stage: an owner-restricted file is one whose user password is empty'
    ).toBe(true);

    await gotoDocumentsPage(page);
    await page.locator('#fileUpload').setInputFiles(fixture);

    // Race the two possible outcomes so a regression fails in seconds with
    // the right message, rather than timing out on the staged file.
    await expect(stagedFile(page).or(passwordPrompt(page))).toBeVisible({ timeout: 60_000 });
    await expect(
      passwordPrompt(page),
      'a parent whose file has an EMPTY user password was asked to type one: the silent ' +
      'empty-password attempt in pdf-decrypt.ts is not happening, or is not happening first'
    ).toBeHidden();
    await expect(stagedFile(page)).toContainText(fixture.name);

    const routed = page.waitForURL((url) => url.pathname === '/summary-and-translations', {
      timeout: 60_000,
    });
    await page.getByTestId(TESTID.uploadSubmit).click();

    await expect
      .poll(() => uploads.length, {
        message: 'the browser never PUT anything to the upload URL it was handed',
        timeout: 60_000,
      })
      .toBe(1);
    expectDecryptedUpload(uploads[0], fixture);
    await routed;
  });

  test('2. a real password is asked for, a wrong one is refused, the right one goes through', async () => {
    const fixture = passwordProtectedPdf(FILE_PASSWORD);
    expect(
      hasEncryptEntry(fixture.buffer),
      'the generated fixture carries no /Encrypt entry, so no prompt could ever appear'
    ).toBe(true);
    expect(
      usesEmptyUserPassword(fixture.buffer),
      'the generated fixture opens with an EMPTY user password, so it is the owner-restricted ' +
      'shape: it would upload silently and the prompt assertions below would be meaningless'
    ).toBe(false);

    await gotoDocumentsPage(page);
    await page.locator('#fileUpload').setInputFiles(fixture);

    const prompt = passwordPrompt(page);
    await expect(
      prompt,
      'the app never asked for a password for a file that genuinely needs one'
    ).toBeVisible({ timeout: 60_000 });
    // Nothing has been rejected yet. If the alert were on screen already, its
    // presence after the wrong password below would say nothing.
    await expect(
      wrongPasswordAlert(page),
      'the prompt opened already complaining about a wrong password, before one was typed'
    ).toHaveCount(0);

    await submitPassword(page, WRONG_PASSWORD);
    await expect(
      wrongPasswordAlert(page),
      'a wrong password was not reported as wrong, so a parent who mistyped is left ' +
      'looking at an unchanged prompt'
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      stagedFile(page),
      'a file was staged for upload on a password the file itself rejected'
    ).toHaveCount(0);
    expect(uploads, 'a rejected password still sent something to the upload URL').toHaveLength(0);

    await submitPassword(page, FILE_PASSWORD);
    await expect(
      prompt,
      'the prompt stayed open after the correct password (still checking, or the file ' +
      'could not be rebuilt: the app falls back to refusing it)'
    ).toBeHidden({ timeout: 90_000 });
    await expect(stagedFile(page)).toContainText(fixture.name);
    await expect(page.getByText(EN.encryptedRefusal)).toHaveCount(0);

    const routed = page.waitForURL((url) => url.pathname === '/summary-and-translations', {
      timeout: 60_000,
    });
    await page.getByTestId(TESTID.uploadSubmit).click();

    await expect
      .poll(() => uploads.length, {
        message: 'the unlocked file never reached the upload URL',
        timeout: 60_000,
      })
      .toBe(1);
    expectDecryptedUpload(uploads[0], fixture);
    await routed;
  });

  test('3. cancelling the prompt stages nothing and uploads nothing', async () => {
    await cancelThePasswordPrompt();

    // Exactly where a fresh file picker leaves them: nothing staged, nothing
    // to upload, and the picker usable again for another file.
    await expect(
      stagedFile(page),
      'cancelling the password prompt still staged the file'
    ).toHaveCount(0);
    await expect(page.locator('.seamless-file-text')).toHaveText(EN.noFileSelected);
    await expect(page.getByTestId(TESTID.uploadSubmit)).toBeDisabled();
    await expect(page.locator('#fileUpload')).toBeEnabled();
    expect(uploads, 'something was uploaded even though the parent cancelled').toHaveLength(0);
  });

  /**
   * Cancelling must say NOTHING. The parent backed out; they did not fail at
   * something, and UploadIEPDocument's 'cancelled' branch is written to be
   * silent.
   *
   * This stage caught a real defect on its first run, fixed in the same
   * change that added it. resolveEncryptedPdf separated a cancel from a real
   * error by handing pdf.js a PdfPasswordCancelledError through
   * updatePassword() and checking `err instanceof PdfPasswordCancelledError`.
   * Real pdf.js DISCARDS that object and rejects with its own
   * PasswordException('No password given'), so the check never matched, the
   * error was rethrown, and the outer catch turned it into
   * { status: 'failed' } -- showing a parent who simply backed out the same
   * refusal this whole feature exists to remove. A local wasCancelled flag
   * classifies it now, so nothing depends on the sentinel surviving pdf.js.
   *
   * The unit tests could not see it: the mock rejected with the very object
   * it was handed, so the identity check held there and only there. That
   * mock now rejects the way pdf.js really does. This stage is the browser-
   * level guard that the two cannot drift apart again.
   */
  test('4. cancelling does not tell the parent the file cannot be processed', async () => {
    await cancelThePasswordPrompt();

    await expect(
      page.getByText(EN.encryptedRefusal),
      'cancelling told the parent their file cannot be processed, which is not what ' +
      'happened: they chose not to type a password'
    ).toHaveCount(0);
    await expect(
      page.locator('.text-danger'),
      'cancelling the password prompt left an error on the upload form'
    ).toHaveCount(0);
  });

  /** Pick the password-protected fixture, wait for the prompt, cancel it.
   * Shared by the two stages above so each asserts from the same state. */
  async function cancelThePasswordPrompt(): Promise<void> {
    await gotoDocumentsPage(page);
    await page.locator('#fileUpload').setInputFiles(passwordProtectedPdf(FILE_PASSWORD));

    const prompt = passwordPrompt(page);
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    await prompt.getByRole('button', { name: EN.cancel, exact: true }).click();
    await expect(prompt, 'the prompt did not close when the parent cancelled it').toBeHidden();
  }
});
