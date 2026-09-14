import React from 'react';
import { useLanguage } from '../common/language-context';
import AIEPFooter from './AIEPFooter';
import './AppShell.css';

/** The skip link's target, and the app's one `<main>` landmark. */
export const MAIN_CONTENT_ID = 'main-content';

/**
 * Move focus to the page's own content, past the site navigation.
 *
 * Every screen renders its own nav bar rather than the shell owning one (the
 * summary screen passes it `tutorialPhase` props, so it cannot be hoisted),
 * which puts the bar inside `<main>`. Focusing `<main>` itself would therefore
 * skip nothing: the very next Tab would land on the first nav button. The
 * first child of `<main>` that is not a `<nav>` is where the page's own
 * content starts, so that is what this focuses.
 *
 * Falling through without preventDefault leaves the plain `href="#main-content"`
 * in charge, which focuses `<main>`. Worse, but never nothing.
 */
function skipToContent(event: React.MouseEvent<HTMLAnchorElement>): void {
  const main = document.getElementById(MAIN_CONTENT_ID);
  const content = [...(main?.children ?? [])].find((el) => el.tagName !== 'NAV');
  if (!(content instanceof HTMLElement)) return;

  event.preventDefault();
  // A page's content container is not focusable on its own. -1 makes it a
  // focus target without adding a tab stop of its own.
  content.tabIndex = -1;
  content.focus();
}

/**
 * The frame every screen renders inside: skip link, the `<main>` landmark, and
 * the one footer.
 *
 * Two things live here rather than on each screen.
 *
 * The footer used to be pasted into 20 components and left off 8 others, with
 * four different calling conventions and the same four-link array copied
 * byte-identical into five files. Rendering it once is the only way the
 * question "what does the footer say here" has one answer.
 *
 * The layout is the standard sticky footer: a `100dvh` flex column whose
 * `<main>` takes the free space, so a short page rests its footer on the
 * bottom of the viewport instead of pushing a scrollbar onto a page with
 * nothing below the fold. `dvh` rather than `vh` because mobile browser chrome
 * makes `vh` taller than the visible viewport, which is a phantom scrollbar by
 * another route; AppShell.css keeps a `vh` line first as the fallback.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const { t } = useLanguage();

  return (
    <div className="app-shell">
      {/* First focusable thing in the document, off-screen until focused. */}
      <a className="skip-to-content" href={`#${MAIN_CONTENT_ID}`} onClick={skipToContent}>
        {t('a11y.skipToContent')}
      </a>
      <main id={MAIN_CONTENT_ID} className="app-shell__main" tabIndex={-1}>
        {children}
      </main>
      <AIEPFooter />
    </div>
  );
}
