import React from 'react';
import { useLanguage } from '../common/language-context';
import AIEPFooter from './AIEPFooter';
import './AppShell.css';

/** The skip link's target, and the app's one `<main>` landmark. */
export const MAIN_CONTENT_ID = 'main-content';

/**
 * Move focus to the page's own content, past the site navigation.
 *
 * The nav bar is chrome and renders outside `<main>` (see `nav` below), so
 * `<main>` itself is the right target: the next Tab after this lands on the
 * first control the screen owns.
 *
 * It used to sit inside `<main>`, which meant focusing `<main>` skipped
 * nothing — the very next Tab landed on the first nav button — and this
 * walked `<main>`'s children for the first one that was not a `<nav>`. The
 * walk is gone with the reason for it.
 *
 * The handler stays, rather than leaving the plain `href="#main-content"` in
 * charge, because fragment navigation moves focus in some browsers and not
 * others.
 */
function skipToContent(event: React.MouseEvent<HTMLAnchorElement>): void {
  const main = document.getElementById(MAIN_CONTENT_ID);
  if (!main) return;

  event.preventDefault();
  // `<main>` carries tabIndex={-1} below: a focus target, not a tab stop.
  main.focus();
}

/**
 * The frame every screen renders inside: skip link, the nav bar, the `<main>`
 * landmark, and the one footer.
 *
 * Nothing here is per-screen, which is the point.
 *
 * The footer used to be pasted into 20 components and left off 8 others, with
 * four different calling conventions and the same four-link array copied
 * byte-identical into five files. Rendering it once is the only way the
 * question "what does the footer say here" has one answer.
 *
 * `nav` is the same argument one layer out. 23 screens rendered their own bar,
 * and 15 of them dropped it again the moment they had something to wait for:
 * a parent watching a spinner lost the navigation and got it back when the
 * screen finished. Which bar a route gets is now decided once, by the layout
 * route it sits under (components/RouteChrome.tsx), and the loading state is
 * just what `<main>` happens to contain. Routes that only redirect pass
 * nothing and get no bar.
 *
 * The layout is the standard sticky footer: a `100dvh` flex column whose
 * `<main>` takes the free space, so a short page rests its footer on the
 * bottom of the viewport instead of pushing a scrollbar onto a page with
 * nothing below the fold. `dvh` rather than `vh` because mobile browser chrome
 * makes `vh` taller than the visible viewport, which is a phantom scrollbar by
 * another route; AppShell.css keeps a `vh` line first as the fallback.
 */
export default function AppShell({
  children,
  nav,
}: {
  children: React.ReactNode;
  nav?: React.ReactNode;
}) {
  const { t } = useLanguage();

  return (
    <div className="app-shell">
      {/* First focusable thing in the document, off-screen until focused. */}
      <a className="skip-to-content" href={`#${MAIN_CONTENT_ID}`} onClick={skipToContent}>
        {t('a11y.skipToContent')}
      </a>
      {/* Before <main>, not inside it: that is what the skip link skips. */}
      {nav}
      <main id={MAIN_CONTENT_ID} className="app-shell__main" tabIndex={-1}>
        {children}
      </main>
      <AIEPFooter />
    </div>
  );
}
