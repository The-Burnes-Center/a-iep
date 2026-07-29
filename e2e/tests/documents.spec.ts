/**
 * The document lifecycle, driven from the browser: upload a synthetic IEP,
 * watch the pipeline run, read the summary in English and in Spanish, save it
 * as a PDF, then replace the document and watch the pipeline run again.
 *
 * Supersedes the old upload.spec.ts (same @pipeline gate, same fixture, same
 * "you must see PROCESSING before you may believe a summary" discipline),
 * widened to the whole journey. It only runs when RUN_PIPELINE_E2E=1 (the
 * nightly workflow sets it) because it costs real OCR, LLM and translation
 * calls and tens of minutes.
 *
 * One serial describe, one login, one child: the stages share a page so the
 * pipeline runs for a single upload (plus the deliberate replacement) per
 * night, and a failure names the stage it died in.
 *
 * Self-cleaning by design: an upload REPLACES the child's previous document,
 * so repeated runs never accumulate anything. The final stage deliberately
 * waits for the replacement to finish processing, which leaves +15555550114
 * holding a healthy PROCESSED document for tts.spec.ts (and for the next
 * night's first assertions).
 *
 * NOT covered, because the product has no such control: deleting a document.
 * The API and the client method exist (iep-document-client.ts#deleteFile ->
 * DELETE /profile/children/{childId}/documents/{iepId}) but nothing in the UI
 * calls it, and the only deletion affordance in the app deletes the whole
 * account. The empty state this journey CAN reach honestly is the one before
 * the first upload, asserted in stage 1.
 */
import { test, expect, BrowserContext, Page } from '@playwright/test';
import * as fs from 'fs';
import playwrightConfig from '../playwright.config';
import { appUrl } from '../helpers/config';
import {
  DOCUMENTS_USER,
  PROCESSING_APPEARS_MS,
  SUMMARY_APPEARS_MS,
  TESTID,
  TRANSLATION_LANGUAGE,
  ensureTranslationLanguage,
  expectSpanishAndDifferent,
  gotoDocumentsPage,
  gotoSummaryPage,
  hasDocumentOnFile,
  loginAsDocumentsUser,
  summaryPanel,
  summaryTextFor,
  selectSummaryLanguage,
  uploadFixture,
  waitForProcessedSummary,
  waitForProcessingMilestone,
} from '../helpers/documents';

// Serial: every stage depends on the one before it, and they share the signed
// in page. Retries are off on purpose: a retry restarts the whole group,
// which means another full pipeline run (another ~25 minutes and another set
// of LLM calls) for what is usually a nightly worth re-running by hand.
test.describe.configure({ mode: 'serial', retries: 0 });

const STAGE_TIMEOUT_MS = {
  /** OTP login + onboarding + a page load. */
  login: 4 * 60_000,
  /** A settings round trip. */
  quick: 3 * 60_000,
  /** Upload + the S3 event + PROCESSING on screen. */
  upload: 2 * 60_000 + PROCESSING_APPEARS_MS + 2 * 60_000,
  /** PROCESSING -> PROCESSED. */
  processing: SUMMARY_APPEARS_MS + 3 * 60_000,
  /** A server-side PDF render and its download. */
  pdf: 4 * 60_000,
};

let context: BrowserContext;
let page: Page;

test.describe('document lifecycle (upload -> summary -> translations -> replace)', { tag: '@pipeline' }, () => {
  // Group-level modifier: evaluated per test, before the stages run, so an
  // ordinary deploy-gating run costs nothing here.
  test.skip(
    () => process.env.RUN_PIPELINE_E2E !== '1',
    'slow pipeline spec: set RUN_PIPELINE_E2E=1 to include it (the nightly workflow does)'
  );

  test.beforeAll(async ({ browser }) => {
    // browser.newPage() does NOT pick up the config's `use` block (that is
    // applied by the per-test `context` fixture), so restate the deliberate
    // mobile viewport: this is a mobile-first app and some controls are
    // CSS-hidden at desktop widths.
    context = await browser.newContext({ viewport: playwrightConfig.use?.viewport ?? null });
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('1. the documents user signs in and the documents page reflects its state', async () => {
    test.setTimeout(STAGE_TIMEOUT_MS.login);

    await loginAsDocumentsUser(page);
    await gotoDocumentsPage(page);

    // Exactly one of the two states must render. On the very first run for
    // this user that is the empty state ("no IEP document on file"); after
    // any previous night it is the replace warning. Both are asserted the
    // same way so the spec never depends on which night this is.
    const documentOnFile = await hasDocumentOnFile(page);
    console.log(
      `[documents] ${DOCUMENTS_USER} starts with ` +
      (documentOnFile ? 'a document on file (this upload replaces it)' : 'no document (empty state)')
    );
  });

  test('2. the profile is pinned to a non-English translation language', async () => {
    test.setTimeout(STAGE_TIMEOUT_MS.quick);

    // Must happen BEFORE the upload: the state machine reads
    // secondaryLanguage from the profile when it decides what to translate.
    await ensureTranslationLanguage(page, TRANSLATION_LANGUAGE);
  });

  test('3. uploading the synthetic IEP starts the pipeline', async () => {
    test.setTimeout(STAGE_TIMEOUT_MS.upload);

    await uploadFixture(page);
    await waitForProcessingMilestone(page);
  });

  test('4. the pipeline produces a summary in the preferred language', async () => {
    test.setTimeout(STAGE_TIMEOUT_MS.processing);

    console.log(`[documents] processed summary first rendered in: ${await waitForProcessedSummary(page)}`);

    // The page settles on the profile's language once a translation for it
    // exists (it renders the English pane for a frame first, hence the
    // timeout rather than an immediate assertion). Staying on English would
    // mean the translation step produced nothing.
    await expect(
      summaryPanel(page, TRANSLATION_LANGUAGE),
      `no ${TRANSLATION_LANGUAGE} translation was produced (check the translation step ` +
      "and the profile's secondaryLanguage at upload time)"
    ).toBeVisible({ timeout: 60_000 });
  });

  test('5. the English tab and the translated tab hold different content', async () => {
    test.setTimeout(STAGE_TIMEOUT_MS.quick);

    const translated = await summaryTextFor(page, TRANSLATION_LANGUAGE);

    // Switching to English is a real profile change (see the helper): the
    // translated tab is unmounted while English is preferred.
    await selectSummaryLanguage(page, 'en');
    await expect(summaryPanel(page, TRANSLATION_LANGUAGE)).toBeHidden();
    const englishSummary = await summaryTextFor(page, 'en');
    expect(englishSummary.length, 'the English summary is empty').toBeGreaterThan(120);

    // ...and back, which also restores the profile for the next stages and
    // the next nightly run.
    await selectSummaryLanguage(page, TRANSLATION_LANGUAGE);
    expectSpanishAndDifferent(translated, englishSummary);
  });

  test('6. the Key Insights sections render with content', async () => {
    test.setTimeout(STAGE_TIMEOUT_MS.quick);

    const panel = summaryPanel(page, TRANSLATION_LANGUAGE);
    const sections = panel.getByTestId(TESTID.section);
    // The fixture carries eligibility, strengths, present levels, goals,
    // services, accommodations, placement, key people and consent, so a
    // single section would mean the parsing agent fell over.
    expect(
      await sections.count(),
      'the processed document produced fewer than two Key Insights sections'
    ).toBeGreaterThanOrEqual(2);

    // Accordion bodies are collapsed until their header is clicked.
    const first = sections.first();
    await first.getByRole('button').first().click();
    await expect(first.locator('.markdown-content')).toBeVisible({ timeout: 15_000 });
    expect((await first.locator('.markdown-content').innerText()).trim().length).toBeGreaterThan(20);
  });

  test('7. the summary downloads as a PDF', async () => {
    test.setTimeout(STAGE_TIMEOUT_MS.pdf);

    const button = page.getByTestId(TESTID.downloadPdf);
    await expect(
      button,
      'the save-as-PDF button never rendered (canGeneratePDF said the document has no content)'
    ).toBeVisible();

    // The client POSTs /generate-pdf, turns the response into a blob and
    // clicks a synthetic <a download>. Playwright sees that as a download
    // event; the blob URL carries no useful content-type, so the file itself
    // is the thing worth asserting.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 3 * 60_000 }),
      button.click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
    const file = await download.path();
    expect(file, 'the browser reported a download with no file behind it').toBeTruthy();
    const head = fs.readFileSync(file as string).subarray(0, 5).toString('latin1');
    expect(head, 'the downloaded file is not a PDF').toBe('%PDF-');
    expect(fs.statSync(file as string).size).toBeGreaterThan(1_000);

    // A failed render surfaces as an inline alert instead of a download.
    await expect(page.getByText('PDF Generation Failed')).toHaveCount(0);
  });

  test('8. replacing the document restarts the pipeline', async () => {
    test.setTimeout(STAGE_TIMEOUT_MS.upload);

    // The processed summary offers its own way back to the upload form.
    await gotoSummaryPage(page);
    const replaceLink = page.getByTestId(TESTID.replaceDocument);
    await expect(replaceLink).toBeVisible({ timeout: 60_000 });
    await replaceLink.click();
    await page.waitForURL((url) => url.pathname === '/iep-documents', { timeout: 60_000 });

    // Coming from a processed document, the page must now say a document is
    // on file (uploading replaces it rather than adding a second one).
    expect(
      await hasDocumentOnFile(page),
      'the documents page does not show a document on file even though one was just processed'
    ).toBe(true);

    await uploadFixture(page);
    await waitForProcessingMilestone(page);
  });

  test('9. the replacement finishes processing', async () => {
    test.setTimeout(STAGE_TIMEOUT_MS.processing);

    // Waiting this out is what leaves the user in a state tts.spec.ts can
    // use, and it proves a replacement is processed exactly like a first
    // upload. Drop this stage if the nightly ever needs to be cheaper: the
    // milestone in stage 8 is what pins the replace behaviour.
    await waitForProcessedSummary(page);
    await expect(summaryPanel(page, TRANSLATION_LANGUAGE)).toBeVisible();
    await expect(page.getByTestId(TESTID.failed)).toHaveCount(0);
    console.log(`[documents] left ${DOCUMENTS_USER} with a freshly processed document at ${appUrl('/summary-and-translations')}`);
  });
});
