/**
 * The document lifecycle, driven from the browser: upload a synthetic IEP,
 * watch the pipeline run, read the summary in English and in Spanish, save it
 * as a PDF, replace the document and watch the pipeline run again, then ask
 * for a language the finished document does not have and watch that arrive.
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
 * so repeated runs never accumulate anything. Stage 9 deliberately waits for
 * the replacement to finish processing, which leaves +15555550114 holding a
 * healthy PROCESSED document for tts.spec.ts (and for the next night's first
 * assertions); stages 10 and 11 then add a third language to that same
 * document and hand the profile back on TRANSLATION_LANGUAGE, so what the
 * account is left holding is a superset of what stage 9 guarantees.
 *
 * WHICH third language rotates by date (ON_DEMAND_LANGUAGE in
 * helpers/documents.ts, proven by on-demand-language.spec.ts), so successive
 * nights exercise Chinese, Vietnamese and Arabic in turn instead of one of
 * them forever. Stage 10 logs the choice; E2E_ON_DEMAND_LANGUAGE forces it.
 * The restore in stage 11 is unconditional, so the account is handed back on
 * TRANSLATION_LANGUAGE whichever language a night picked.
 *
 * The on-demand translation costs money per attempt and is budgeted per
 * document (MAX_TRANSLATION_ATTEMPTS in translation-request-handler, counted on
 * the document row and never reset). Stage 10 spends exactly one, against the
 * replacement uploaded in stage 8: uploads mint a new iepId, so that row's
 * count starts at zero every night and nothing accumulates.
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
  ON_DEMAND_LANGUAGE,
  ON_DEMAND_LANGUAGE_REASON,
  ON_DEMAND_TRANSLATION_MS,
  PROCESSING_APPEARS_MS,
  SUMMARY_APPEARS_MS,
  TESTID,
  TRANSLATION_LANGUAGE,
  ensureTranslationLanguage,
  expectOnDemandTranslation,
  expectSpanishAndDifferent,
  gotoDocumentsPage,
  gotoSummaryPage,
  hasDocumentOnFile,
  loginAsDocumentsUser,
  summaryPanel,
  summaryTextFor,
  selectSummaryLanguage,
  tapAppNav,
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
  /** A profile switch, the translation request, and the nav round trip. */
  translationRequest: 6 * 60_000,
  /** A whole-document on-demand translation, then the profile restore. */
  onDemandTranslation: ON_DEMAND_TRANSLATION_MS + 4 * 60_000,
};

let context: BrowserContext;
let page: Page;

test.describe('document lifecycle (upload -> summary -> translations -> replace -> translate on demand)', { tag: '@pipeline' }, () => {
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

  test('10. a missing translation can be asked for, and the request survives the app nav', async () => {
    test.setTimeout(STAGE_TIMEOUT_MS.translationRequest);

    // First thing, before anything can fail: which language this run asked for
    // and how it got there. The nightly rotates over the languages the upload
    // does NOT produce, so a report of "stage 10 failed" is only actionable
    // with this line next to it, and E2E_ON_DEMAND_LANGUAGE replays it.
    console.log(
      `[documents] on-demand translation language for this run: ${ON_DEMAND_LANGUAGE} ` +
      `(${ON_DEMAND_LANGUAGE_REASON})`
    );

    // Stage 9's replacement carries English + Spanish, so moving the profile to
    // a THIRD language is what puts this account in the state the banner is
    // for: readable content, none of it in the parent's language. Which third
    // language rotates by date, so that over successive nights every language
    // the app ships gets an on-demand run rather than Chinese forever.
    //
    // When the rotation lands on Arabic the profile switch also flips the whole
    // UI to RTL (common/direction.ts swaps in the RTL Bootstrap build and sets
    // document.dir). Nothing below depends on left-to-right layout: the banner,
    // its button and the tab panes are addressed by test id, and the nav bar by
    // the icon each button carries rather than by its position in the row,
    // which is the only thing dir="rtl" actually reorders.
    //
    // Running it here, against that replacement, is deliberate. Every accepted
    // request spends one of a document's MAX_TRANSLATION_ATTEMPTS (12, in
    // translation-request-handler), counted on the document row and never reset
    // for its lifetime. Each upload mints a fresh iepId, so the row this stage
    // charges is one night old and starts at zero: nightly runs spend 1 of 12
    // each and cannot accumulate towards the cap. Moving this stage earlier
    // would also mean restoring the profile before stage 8's upload, because
    // check_language_prefs reads it at that moment.
    await ensureTranslationLanguage(page, ON_DEMAND_LANGUAGE);
    await gotoSummaryPage(page);

    // The banner renders only for a document that HAS English content and has
    // none in the preferred language, so its presence is the precondition for
    // everything below.
    await expect(
      page.getByTestId(TESTID.translateBanner),
      `the summary page does not offer to translate into ${ON_DEMAND_LANGUAGE} ` +
      '(shouldOfferTranslation said no: is there English content on this document, ' +
      'and did the profile switch stick?)'
    ).toBeVisible({ timeout: 60_000 });

    const translateNow = page.getByTestId(TESTID.translateNow);
    const progress = page.getByTestId(TESTID.translationProgress);
    await expect(
      translateNow,
      'the banner is not offering the button, so this stage starts from the wrong ' +
      'state (something is already translating this document)'
    ).toBeVisible();
    await expect(progress).toHaveCount(0);

    // Wait for the endpoint's own answer rather than only for the button to
    // change: 200 (already translated) and 409 (already running) draw the very
    // same progress bar, so the status code is the only thing that separates
    // "this run started a translation" from "this run watched someone else's".
    const requested = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/translations') &&
        response.request().method() === 'POST',
      { timeout: 60_000 }
    );
    await translateNow.click();
    expect(
      (await requested).status(),
      'POST /translations did not start a new translation. 409 means one was already ' +
      'in flight for this document; 429 means its translation-attempt budget is spent, ' +
      'which is never reset, so it would mean this stage is charging an old document ' +
      "instead of stage 8's replacement"
    ).toBe(202);

    // The in-progress state has to be seen HERE, before the round trip, or the
    // assertions after it prove nothing.
    await expect(
      progress,
      'the accepted request did not put the banner into its in-progress state, so ' +
      'nothing below can be a statement about surviving an unmount'
    ).toBeVisible({ timeout: 30_000 });
    await expect(translateNow).toHaveCount(0);
    await expect(page.getByTestId(TESTID.translationError)).toHaveCount(0);

    // The regression this stage exists for. The app nav is a react-router route
    // change, so tapping Account really unmounts the summary page and resets the
    // request state it used to keep only in React. A parent who did this came
    // back to the "translate it now" button, as if they had never pressed it.
    await tapAppNav(page, '/account-center');
    await expect(
      page.getByTestId(TESTID.translateBanner),
      'the summary page is still mounted after tapping Account, so coming back ' +
      'would not exercise the unmount this stage is about'
    ).toHaveCount(0);

    await tapAppNav(page, '/summary-and-translations');
    await expect(
      page.getByTestId(TESTID.translateBanner),
      'the translation banner is gone after the trip through Account'
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      progress,
      'the translation in flight was forgotten when the parent stepped over to ' +
      'Account and back (resumeTranslationRequest no longer rebuilds it from the ' +
      "document's PROCESSING_TRANSLATIONS status)"
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      translateNow,
      'the "translate it now" button came back while a translation was running, so ' +
      'a parent would press it again and spend a second paid attempt'
    ).toHaveCount(0);
  });

  test('11. the requested translation lands and the parent ends up on it', async () => {
    test.setTimeout(STAGE_TIMEOUT_MS.onDemandTranslation);

    const panel = summaryPanel(page, ON_DEMAND_LANGUAGE);
    const failed = page.getByTestId(TESTID.translationError);

    // Either the pane arrives or the page tells the parent it failed. The two
    // are mutually exclusive (the banner that carries the error is gone the
    // moment the language it offers exists), and waiting on both is what turns
    // a failed run into a fast, legible failure instead of a ten-minute timeout.
    await expect(
      panel.or(failed),
      `no ${ON_DEMAND_LANGUAGE} content and no error within ` +
      `${ON_DEMAND_TRANSLATION_MS / 60_000} minutes (check this document's ` +
      'SingleLanguageTranslation execution)'
    ).toBeVisible({ timeout: ON_DEMAND_TRANSLATION_MS });
    await expect(
      failed,
      'the summary page reported the on-demand translation failed'
    ).toHaveCount(0);

    // Visible, not merely present: the arrival is supposed to move the parent
    // onto their own language, which is the last of the things the unmount used
    // to break.
    await expect(panel).toBeVisible();
    // Script check, chosen per language so it cannot pass on English content
    // the translation step left alone (see TRANSLATED_SCRIPTS in the helper).
    expectOnDemandTranslation(await summaryTextFor(page, ON_DEMAND_LANGUAGE), ON_DEMAND_LANGUAGE);

    // ...and the offer is gone, because nothing is missing any more.
    await expect(page.getByTestId(TESTID.translateBanner)).toHaveCount(0);

    // Put the profile back where stage 2 left it, last thing and on purpose:
    // +15555550114 is shared with tts.spec.ts and with the next night's run,
    // both of which expect the Spanish preference. It also puts the UI back to
    // LTR on the nights the rotation picked Arabic. A failure above skips this
    // and leaves the account on ON_DEMAND_LANGUAGE, which stage 2 of the next
    // run heals before it uploads; tts.spec.ts is unharmed either way, because
    // it reads whichever pane the summary page settles on, in whichever
    // direction the page renders it.
    await ensureTranslationLanguage(page, TRANSLATION_LANGUAGE);
    console.log(
      `[documents] left ${DOCUMENTS_USER} holding en + ${TRANSLATION_LANGUAGE} + ` +
      `${ON_DEMAND_LANGUAGE} content and a ${TRANSLATION_LANGUAGE} preference`
    );
  });
});
