/**
 * The document pipeline, driven from the browser: upload a synthetic
 * one-page IEP PDF and wait until the processed summary renders. This is
 * the only spec that exercises OCR + LLM analysis + translations end to
 * end, which costs real minutes and real LLM calls, so it only runs when
 * RUN_PIPELINE_E2E=1 (the nightly workflow sets it; deploy-gating runs
 * stay fast without it).
 *
 * Self-cleaning by design: an upload REPLACES the child's previous
 * document, so repeated runs never accumulate anything.
 *
 * The fixture (fixtures/synthetic-iep.pdf) is a hand-built, obviously
 * synthetic one-pager: plausible IEP-ish sentences for the parser to chew
 * on, zero real child data.
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { PIPELINE_TEST_TIMEOUT_MS } from '../playwright.config';
import { loginWithOtp, EN } from '../helpers/app';
import { appUrl } from '../helpers/config';
import { STABLE_USER } from '../helpers/phones';

const FIXTURE_PDF = path.join(__dirname, '..', 'fixtures', 'synthetic-iep.pdf');

// Document record creation is S3-event-driven, so the summary page's first
// fetch after upload can race it (and the page only starts self-polling
// once it has SEEN a PROCESSING status; on a miss it can even bounce back
// to /iep-documents). We re-navigate until the processing UI shows up.
const PROCESSING_APPEARS_MS = 3 * 60_000;
// OCR + analysis + translations; generous but bounded.
const SUMMARY_APPEARS_MS = 10 * 60_000;

test('uploaded IEP is processed into a visible summary', { tag: '@pipeline' }, async ({ page }) => {
  test.skip(
    process.env.RUN_PIPELINE_E2E !== '1',
    'slow pipeline spec: set RUN_PIPELINE_E2E=1 to include it (the nightly workflow does)'
  );
  test.setTimeout(PIPELINE_TEST_TIMEOUT_MS);

  await loginWithOtp(page, STABLE_USER);

  await page.goto(appUrl('/iep-documents'));
  // The visible chooser is a styled overlay; the real input keeps this id.
  await page.locator('#fileUpload').setInputFiles(FIXTURE_PDF);
  await page.getByRole('button', { name: EN.uploadDocument }).click();

  // A successful S3 upload routes to the summary page.
  await page.waitForURL((url) => url.pathname === '/summary-and-translations', {
    timeout: 120_000,
  });

  const processingText = page.getByText(/Hang tight!/);
  const summaryHeading = page.getByRole('heading', { name: /IEP Summary/ });
  const failedText = page.getByText('Processing Failed');

  // Milestone 1: the NEW upload registered and is processing. Requiring
  // this before accepting any summary is what stops the test from passing
  // vacuously on the PREVIOUS run's processed document.
  const m1Deadline = Date.now() + PROCESSING_APPEARS_MS;
  let sawProcessing = false;
  while (Date.now() < m1Deadline) {
    if (await processingText.isVisible()) {
      sawProcessing = true;
      break;
    }
    await page.waitForTimeout(10_000);
    await page.goto(appUrl('/summary-and-translations'));
  }
  expect(
    sawProcessing,
    `the processing screen never appeared within ${PROCESSING_APPEARS_MS / 60_000} minutes of the upload ` +
    '(did the S3 event -> metadata-handler hookup break?)'
  ).toBe(true);

  // Milestone 2: processed summary renders. The page polls its API every 5s
  // on its own; the occasional re-navigation below is a belt against any
  // client-side polling hiccup during such a long window.
  const m2Deadline = Date.now() + SUMMARY_APPEARS_MS;
  let lastNavigation = Date.now();
  while (Date.now() < m2Deadline) {
    if (await failedText.isVisible()) {
      throw new Error('the pipeline reported FAILED for the uploaded document');
    }
    if (await summaryHeading.isVisible()) {
      return; // processed summary on screen: the pipeline held end to end
    }
    if (Date.now() - lastNavigation > 60_000) {
      await page.goto(appUrl('/summary-and-translations'));
      lastNavigation = Date.now();
    }
    await page.waitForTimeout(5_000);
  }
  throw new Error(
    `the processed summary never appeared within ${SUMMARY_APPEARS_MS / 60_000} minutes ` +
    '(pipeline stuck or slower than the budget; check the Step Functions execution)'
  );
});
