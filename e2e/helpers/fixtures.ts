/**
 * The suite's `test`: Playwright's, plus a Content-Security-Policy watch.
 *
 * Staging sends Content-Security-Policy-Report-Only, so a request the policy
 * would block still succeeds and only a browser event says so. Every journey
 * here listens for that event and fails on it, which makes this suite the
 * thing that proves the policy is safe to enforce, and keeps it safe after:
 * a change that loads something from a new origin fails here, on staging,
 * instead of breaking sign-in for families once the policy is enforced.
 *
 * Specs import `test` and `expect` from here, never from '@playwright/test'.
 * A spec that builds its own BrowserContext (browser.newContext) is outside
 * the default fixture, so it calls watchCsp on that context itself.
 *
 * It also gets the summary page's guided tour out of the way: a first-time
 * parent is shown it as a modal over the page, which would swallow the clicks
 * of every journey that lands on the summary. See helpers/summary-tour.ts.
 */
import { test as base, expect, BrowserContext } from '@playwright/test';
import { dismissSummaryTourWhenShown } from './summary-tour';

const MARKER = '[csp-violation]';

// Runs in the page before any app code. Report-only violations fire the same
// event as enforced ones, with disposition "report".
const LISTENER = `document.addEventListener('securitypolicyviolation', (e) => {
  console.warn(${JSON.stringify(MARKER)} + ' ' + JSON.stringify({
    directive: e.effectiveDirective,
    blocked: e.blockedURI,
    source: e.sourceFile,
    line: e.lineNumber,
  }));
});`;

/** Start recording CSP violations in a context. Returns the live list. */
export async function watchCsp(context: BrowserContext): Promise<string[]> {
  const violations: string[] = [];
  await context.addInitScript(LISTENER);
  context.on('console', (message) => {
    const text = message.text();
    if (text.startsWith(MARKER)) violations.push(text.slice(MARKER.length + 1));
  });
  return violations;
}

/** Fail with every distinct violation listed, so one run shows them all. */
export function expectNoCspViolations(violations: readonly string[]): void {
  expect([...new Set(violations)], 'Content-Security-Policy violations').toEqual([]);
}

export const test = base.extend<{ cspWatch: void; tourDismissal: void }>({
  tourDismissal: [
    async ({ context }, use) => {
      await dismissSummaryTourWhenShown(context);
      await use();
    },
    { auto: true },
  ],
  cspWatch: [
    async ({ context }, use) => {
      const violations = await watchCsp(context);
      await use();
      expectNoCspViolations(violations);
    },
    { auto: true },
  ],
});

export { expect };
