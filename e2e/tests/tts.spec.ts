/**
 * Text-to-speech on the summary page, including the regression fixed on
 * 2026-07-28: starting a second clip while one was playing used to leave BOTH
 * buttons rendering the "playing" (pause) state, because only the audio
 * element was paused and the first button never heard about it. The fix wires
 * TTSPlayButton's audio.onpause back into its own state; this spec pins it.
 *
 * NOT @pipeline-gated: it reads whatever processed document +15555550114
 * already has (documents.spec.ts leaves one behind every night) and skips
 * with a clear message when there is none. That keeps the double-play
 * regression covered on every staging deploy, not just nightly.
 *
 * It does cost real synthesis on the first run after each upload: the audio
 * cache key is iep-audio/<iepId>/... so a new document always misses the
 * cache, and a cold synthesis can take minutes (the client rides out API
 * Gateway 504s with its own retry loop). Two clips per run, cached
 * afterwards.
 */
import { test, expect } from '@playwright/test';
import {
  DOCUMENTS_USER,
  TESTID,
  TTS_READY_MS,
  gotoSummaryPage,
  loginAsDocumentsUser,
  openFirstSectionWithAudio,
  playingTtsButtons,
  ttsState,
} from '../helpers/documents';

// Chromium's default autoplay policy allows playback after a user gesture,
// which every click here is, but the play() call happens after an await and
// CI browsers have no media-engagement history. Making the policy explicit
// keeps a headless run from failing on a blocked play() (which the component
// would render as its error state).
test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });

/** Login + the summary page + two cold syntheses. */
const TEST_TIMEOUT_MS = 12 * 60_000;

/**
 * How long to tolerate a document that is mid-pipeline. On a nightly run
 * documents.spec.ts has already waited it out; this is only a cushion for a
 * run that starts while an upload is still processing.
 */
const PROCESSING_PATIENCE_MS = process.env.RUN_PIPELINE_E2E === '1' ? 10 * 60_000 : 60_000;

test('TTS plays, and starting a second clip stops the first', async ({ page }) => {
  test.setTimeout(TEST_TIMEOUT_MS);

  await loginAsDocumentsUser(page);
  await gotoSummaryPage(page);

  // Three possible states: processed (the subject of this spec), processing
  // (wait a bounded while), or nothing uploaded yet (skip; the first nightly
  // seeds it). With no document at all the page bounces to /iep-documents.
  const visiblePanel = page.locator('[data-testid^="summary-tab-panel-"]:visible').first();
  const processing = page.getByTestId(TESTID.processing);
  const deadline = Date.now() + PROCESSING_PATIENCE_MS;
  let bouncedOut = false;
  while (!bouncedOut && Date.now() < deadline) {
    if (await visiblePanel.isVisible()) break;
    await page.waitForTimeout(5_000);
    if (await visiblePanel.isVisible()) break;
    bouncedOut =
      !(await processing.isVisible()) &&
      new URL(page.url()).pathname !== '/summary-and-translations';
    if (!bouncedOut) await gotoSummaryPage(page);
  }

  test.skip(
    !(await visiblePanel.isVisible()),
    `no processed document for ${DOCUMENTS_USER} to read aloud ` +
    '(the @pipeline documents spec seeds one: run the nightly, or ' +
    'RUN_PIPELINE_E2E=1 npx playwright test documents.spec.ts)'
  );

  // The page shows the English pane for a frame and then switches to the
  // profile's language, so let it settle and then pin the pane that won:
  // a locator that follows "whichever pane is visible" could resolve to a
  // different element between two steps.
  await page.waitForTimeout(2_000);
  const panel = page.getByTestId((await visiblePanel.getAttribute('data-testid')) ?? '');

  // Two buttons that are on screen at the same time: the summary's (in the
  // page heading) and one section's. Section buttons live inside collapsed
  // accordion bodies, and opening a second section collapses the first, so
  // summary + one section is the only pairing that keeps both visible.
  const summaryAudio = panel.getByTestId(TESTID.ttsButton).first();
  await expect(summaryAudio).toBeVisible();
  const sectionAudio = await openFirstSectionWithAudio(panel);

  // Captured while both buttons are untouched: this is the "listen" label in
  // whatever language the profile put the UI in, and the interrupted button
  // must come back to exactly it.
  const listenLabel = (await summaryAudio.getAttribute('aria-label')) ?? '';
  expect(listenLabel.length).toBeGreaterThan(0);

  await test.step('a section clip plays, then pauses', async () => {
    // Deliberately first: this synthesizes and caches the section clip so the
    // interruption below is a local resume (instant) rather than a fetch that
    // can outlast the other clip. A cold second fetch would let the first clip
    // end on its own, which is a different (and untested) code path.
    await sectionAudio.click();
    await expect(sectionAudio).toHaveAttribute('data-tts-state', 'playing', {
      timeout: TTS_READY_MS,
    });
    await expect(playingTtsButtons(page)).toHaveCount(1);

    await sectionAudio.click();
    await expect(sectionAudio).toHaveAttribute('data-tts-state', 'paused', { timeout: 30_000 });
    await expect(playingTtsButtons(page)).toHaveCount(0);
  });

  await test.step('the summary clip plays', async () => {
    await summaryAudio.click();
    await expect(summaryAudio).toHaveAttribute('data-tts-state', 'playing', {
      timeout: TTS_READY_MS,
    });
    await expect(playingTtsButtons(page)).toHaveCount(1);
  });

  await test.step('starting the second clip flips the first one back', async () => {
    expect(
      await ttsState(summaryAudio),
      'the summary clip stopped on its own before the second clip could interrupt it, ' +
      'so this run proves nothing about the double-play fix'
    ).toBe('playing');

    await sectionAudio.click();
    await expect(sectionAudio).toHaveAttribute('data-tts-state', 'playing', { timeout: 60_000 });

    // The regression: both buttons used to sit on 'playing' here.
    await expect(
      playingTtsButtons(page),
      'two TTS buttons claim to be playing at once (the audio.onpause handler in ' +
      'TTSPlayButton that flips the interrupted button back has regressed)'
    ).toHaveCount(1);
    expect(
      await ttsState(summaryAudio),
      'the interrupted summary button did not return to a resumable state'
    ).toBe('paused');
    // What the parent sees on the interrupted button is the listen
    // affordance again, not a pause icon.
    await expect(summaryAudio).toHaveAttribute('aria-label', listenLabel);
  });

  await test.step('pausing the survivor leaves nothing playing', async () => {
    await sectionAudio.click();
    await expect(sectionAudio).toHaveAttribute('data-tts-state', 'paused', { timeout: 30_000 });
    await expect(playingTtsButtons(page)).toHaveCount(0);
    await expect(summaryAudio).toHaveAttribute('aria-label', listenLabel);
  });
});
