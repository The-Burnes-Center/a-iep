import React from 'react';
import { Outlet } from 'react-router-dom';
import AppShell from './AppShell';
import LandingTopNavigation from './LandingTopNavigation';
import MobileTopNavigation from './MobileTopNavigation';

/**
 * Which navigation bar a route gets, decided by the block it sits in rather
 * than by the screen itself.
 *
 * There are two bars and they do not overlap: LandingTopNavigation is the
 * public site's header (Home, Upload, FAQs, About, plus the language picker),
 * MobileTopNavigation is the in-app bar (Summary, Support, Rights, Account).
 * Every screen used to render one of them itself, and the screens that appear
 * on both sides of the line took the choice as a `NavigationComponent` prop.
 * Two things came out of that:
 *
 *  - A screen with a loading state returned the spinner *instead of* its whole
 *    tree, bar included. 15 of them did. The bar vanished while a parent
 *    waited and reappeared when the data arrived, which is what put the
 *    footer (already hoisted into AppShell) on screen with nothing above it.
 *  - Whether the bar was there at all was per-screen. The onboarding carousel,
 *    Revoke Consent, /rights-of-parents and the processing takeover rendered
 *    none, so a parent on any of them had no way out but the browser's Back
 *    button. They all carry it now.
 *
 * As a layout route the bar is mounted once for the whole block and survives
 * every route change and every loading state inside it, because none of them
 * unmount it. RouteChrome.test.tsx pins both halves: that the bar is on screen
 * while a real screen is still loading, and that no screen has gone back to
 * rendering a bar of its own.
 *
 * Deliberately not applied to `/login`, `/r/:code` or the catch-all: those
 * render a redirect, not a page, and chrome around a frame nobody sees is
 * chrome that flashes.
 */
export function PublicChrome() {
  return (
    <AppShell nav={<LandingTopNavigation />}>
      <Outlet />
    </AppShell>
  );
}

/**
 * The signed-in half. Rendered by ProtectedRoute rather than mounted as its
 * own layout route: the guard is the only thing that knows whether in-app
 * chrome is the right thing to show, and its own waiting state answers "not
 * yet". Exported so a test can put a screen under the real bar.
 */
export function InAppChrome() {
  return (
    <AppShell nav={<MobileTopNavigation />} footerVariant="compact">
      <Outlet />
    </AppShell>
  );
}
