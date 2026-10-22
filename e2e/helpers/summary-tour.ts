/**
 * The summary page's guided tour (components/GuidedTour.tsx), from the
 * outside.
 *
 * A parent sees the tour the first time they land on a finished summary, and
 * it is a modal dialog: until it is dismissed it covers the page and takes
 * every click. So every journey that reaches the summary has to either be
 * about the tour (documents.spec.ts) or get it out of the way
 * (dismissSummaryTourWhenShown, installed for every default test by
 * fixtures.ts).
 *
 * Selectors are language-independent: the copy is localized, the test ids
 * are not.
 */
import { BrowserContext, Locator, Page, expect } from '@playwright/test';
import { appUrl } from './config';

export const SUMMARY_TOUR_TESTID = 'guided-tour';
export const SUMMARY_TOUR_SKIP_TESTID = 'guided-tour-skip';

/** The tour's card (the dialog). */
export const summaryTour = (page: Page): Locator => page.getByTestId(SUMMARY_TOUR_TESTID);

/** The tour's Skip button; absent on the last step, where Done replaces it. */
export const summaryTourSkip = (page: Page): Locator => page.getByTestId(SUMMARY_TOUR_SKIP_TESTID);

const isProfileRequest = (url: string): boolean => new URL(url).pathname.endsWith('/profile');

/** The save the tour makes when it is dismissed: PUT /profile { summaryTourSeen: true }. */
export function waitForTourSeenSaved(page: Page) {
  return page.waitForResponse(
    (response) =>
      isProfileRequest(response.url()) &&
      response.request().method() === 'PUT' &&
      response.ok() &&
      JSON.parse(response.request().postData() ?? '{}').summaryTourSeen === true,
    { timeout: 45_000 }
  );
}

/**
 * Set the profile's `summaryTourSeen` flag, the way the app itself would.
 *
 * Specs cannot call the API from outside: it needs the signed-in parent's
 * bearer token, which only the page holds. So this loads a screen that reads
 * the profile, lifts the Authorization header off the app's own request, and
 * replays a PUT with it (the app's own call, with `false` where it sends
 * `true`; the backend accepts any boolean). Needs a signed-in page.
 */
export async function setSummaryTourSeen(page: Page, seen: boolean): Promise<void> {
  const profileRead = page.waitForRequest(
    (request) => request.method() === 'GET' && isProfileRequest(request.url()),
    { timeout: 45_000 }
  );
  await page.goto(appUrl('/account-center'));
  const request = await profileRead;
  const authorization = (await request.allHeaders())['authorization'];
  expect(authorization, 'the app sent GET /profile without a bearer token').toBeTruthy();

  const response = await page.request.put(request.url(), {
    headers: { authorization, 'content-type': 'application/json' },
    data: { summaryTourSeen: seen },
  });
  expect(response.ok(), `PUT /profile { summaryTourSeen: ${seen} } failed with ${response.status()}`).toBe(true);
}

/**
 * Close the tour whenever it gets in the way of an action, on every page of
 * `context`, now and later. Escape is the tour's own way out, and counts as
 * seen, so it stays away for the rest of the run.
 *
 * Playwright runs the handler when an overlay would block an action, not on
 * assertions, so a test can still assert the tour is there. A spec that
 * drives the tour itself must not install this: the handler would race its
 * own clicks.
 */
export async function dismissSummaryTourWhenShown(context: BrowserContext): Promise<void> {
  const install = async (page: Page) => {
    await page.addLocatorHandler(summaryTour(page), async () => {
      await page.keyboard.press('Escape');
    });
  };
  await Promise.all(context.pages().map(install));
  context.on('page', (page) => {
    void install(page);
  });
}
