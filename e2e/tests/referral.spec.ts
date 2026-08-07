/**
 * The referral journey, end to end: a parent shares their invite link, a new
 * parent joins through it, and the referrer's stats show it — without ever
 * showing who joined.
 *
 * This is the only journey coverage the referral system has (it shipped to
 * production 2026-08-04 with manual testing only), and it exercises the whole
 * chain: GET /referral/me mints the personal code, /r/<code> stores the
 * pending capture and fires the public click beacon, and after the new
 * account's first login ReferralTracker posts /referral/attribute, whose
 * server-side guards (active code, no self-referral, unattributed profile,
 * click-before-signup) all have to pass for the stats to move.
 *
 * Ordering that matters: the burner visits /r/<code> BEFORE its first login.
 * The attribute lambda rejects captures newer than the profile row
 * ('click_after_signup'), and the profile row is created during first login —
 * so capture first, then log in, exactly like a real invited parent.
 *
 * Two browser contexts on purpose: the referrer stays signed in on one while
 * the invited parent clicks, logs in and onboards on the other. The pending
 * code lives in the invited context's localStorage, so every burner step from
 * /r/<code> to attribution must happen in that same context.
 *
 * Retry-safety: the referrer persists across runs (stats are asserted as
 * deltas from a baseline read at the start), the burner is healed at the top
 * of the test body and admin-deleted in an afterEach.
 */
import { test, expect, Page, BrowserContext } from '@playwright/test';
import { EN, loginWithOtp } from '../helpers/app';
import { appUrl } from '../helpers/config';
import { deleteTestUserIfExists, ensureTestUser } from '../helpers/aws';
import { REFERRER_USER, REFERRAL_SIGNUP_USER } from '../helpers/phones';

/** English invite-page copy the flow keys on (mirrors src/translations/en.json). */
const EN_INVITE = {
  title: 'Invite Other Parents',
  joinedItem: 'A parent joined',
} as const;

/** Both counters on the invite page, in render order (see InvitePage.tsx). */
interface InviteStats {
  clicks: number;
  signups: number;
}

/**
 * Navigate app nav -> Account Center -> the invite row and wait for the
 * referral/me query to paint (the stats panel is the last thing to render).
 */
async function openInvitePage(page: Page): Promise<void> {
  await page.getByRole('button', { name: EN.navigateToAccount }).click();
  await page.waitForURL((url) => url.pathname === '/account-center');
  // The row exists at all only because staging enables the 'referrals'
  // feature; its absence here would mean the feature flag regressed.
  await page.getByTestId('account-center-invite').click();
  await page.waitForURL((url) => url.pathname === '/invite');
  await expect(page.locator('.invite-stat-value')).toHaveCount(2, { timeout: 30_000 });
}

async function readInviteStats(page: Page): Promise<InviteStats> {
  const values = await page.locator('.invite-stat-value').allInnerTexts();
  const [clicks, signups] = values.map((v) => Number.parseInt(v.trim(), 10));
  if (Number.isNaN(clicks) || Number.isNaN(signups)) {
    throw new Error(`The invite stats did not render as numbers (saw: ${JSON.stringify(values)})`);
  }
  return { clicks, signups };
}

/** The personal code, read from the share-link field the parent would copy. */
async function readInviteCode(page: Page): Promise<string> {
  const inviteUrl = await page.locator('.invite-link-group input').inputValue();
  const match = /\/r\/([A-Za-z0-9-]+)$/.exec(inviteUrl);
  if (!match) {
    throw new Error(`The invite link field does not hold a /r/<code> URL (saw: "${inviteUrl}")`);
  }
  return match[1];
}

/**
 * Reload /invite until both counters move past the baseline. The counters are
 * bumped server-side during the click/attribute calls the test already
 * awaited, so this only absorbs the invite page's own query latency; a
 * genuine failure to count still fails loudly at the deadline.
 */
const STATS_DEADLINE_MS = 60_000;

async function waitForStatsAbove(page: Page, baseline: InviteStats): Promise<InviteStats> {
  const deadline = Date.now() + STATS_DEADLINE_MS;
  let last: InviteStats = baseline;

  for (;;) {
    await page.reload();
    await expect(page.locator('.invite-stat-value')).toHaveCount(2, { timeout: 30_000 });
    last = await readInviteStats(page);
    if (last.clicks > baseline.clicks && last.signups > baseline.signups) return last;

    if (Date.now() >= deadline) {
      throw new Error(
        `The invite stats never rose above the baseline within ${STATS_DEADLINE_MS / 1000}s ` +
        `(baseline clicks=${baseline.clicks} signups=${baseline.signups}, ` +
        `last seen clicks=${last.clicks} signups=${last.signups}). ` +
        'The click beacon and the attribution call both returned OK, so the ' +
        'counters themselves are not being persisted or read back.'
      );
    }
    await page.waitForTimeout(2_000);
  }
}

// Backstop only: the journey deletes the burner through the product when it
// completes. An afterEach still runs on timeout, which is when a half-made
// account would otherwise be left behind.
test.afterEach(async () => {
  await deleteTestUserIfExists(REFERRAL_SIGNUP_USER);
});

test('a new parent joining through an invite link is counted, anonymously', async ({ page, browser }) => {
  // Two full logins with onboarding plus a stats poll.
  test.setTimeout(300_000);

  // The referrer persists across runs; ensure it exists so the first ever run
  // does not fall into the sign-up path loginWithOtp refuses. The burner is
  // rebuilt from scratch: its profile row must be YOUNGER than the click
  // capture, and a leftover account from a dead run would break that.
  await ensureTestUser(REFERRER_USER);
  await deleteTestUserIfExists(REFERRAL_SIGNUP_USER);
  await ensureTestUser(REFERRAL_SIGNUP_USER);

  // ---- Act 1: the referrer reads their link and a stats baseline ---------

  await loginWithOtp(page, REFERRER_USER);
  await openInvitePage(page);
  await expect(page.getByRole('heading', { name: EN_INVITE.title })).toBeVisible();

  const code = await readInviteCode(page);
  const baseline = await readInviteStats(page);

  // ---- Act 2: a new parent arrives through the link ----------------------

  const invitedContext: BrowserContext = await browser.newContext();
  try {
    const invited = await invitedContext.newPage();

    // /r/<code> must count a click and land on the public home page. The
    // beacon is fired during an immediate client-side redirect, so arm the
    // response wait before navigating.
    const clickResponse = invited.waitForResponse(
      (r) => r.url().includes('/referral/click') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await invited.goto(appUrl(`/r/${code}`));
    await invited.waitForURL((url) => url.pathname === '/', { timeout: 30_000 });
    expect((await clickResponse).ok()).toBe(true);

    // First login of the invited account, in the SAME context that holds the
    // pending code. ReferralTracker posts the attribution once authenticated;
    // armed before login because it can fire while onboarding is still on
    // screen. Asserting attributed=true (not just 200) is the point: the
    // lambda answers 200 with a rejection reason when any guard fails.
    const attributeResponse = invited.waitForResponse(
      (r) => r.url().includes('/referral/attribute') && r.request().method() === 'POST',
      { timeout: 240_000 },
    );
    await loginWithOtp(invited, REFERRAL_SIGNUP_USER);

    const attribution = await (await attributeResponse).json() as
      { attributed: boolean; reason?: string };
    expect(
      attribution.attributed,
      `the attribute call was rejected server-side (reason: "${attribution.reason ?? 'none given'}")`
    ).toBe(true);

    // ---- Act 3: the referrer sees the join, but never the joiner ---------

    const after = await waitForStatsAbove(page, baseline);
    expect(after.clicks).toBeGreaterThan(baseline.clicks);
    expect(after.signups).toBeGreaterThan(baseline.signups);

    // The deliberate privacy stance: join dates only, never who joined.
    const joinsPanel = page.locator('.invite-joins-panel');
    await expect(joinsPanel.locator('.invite-join-row').first()).toContainText(EN_INVITE.joinedItem);
    const joinsText = await joinsPanel.innerText();
    expect(
      joinsText,
      'the joins list must never surface the invited parent\'s phone number'
    ).not.toContain(REFERRAL_SIGNUP_USER.slice(-7));
  } finally {
    await invitedContext.close();
  }

  // The attribution survives on the referrer's stats even though the invited
  // account is removed (the afterEach admin-deletes it): counters and events
  // outlive the referred account by design.
});
