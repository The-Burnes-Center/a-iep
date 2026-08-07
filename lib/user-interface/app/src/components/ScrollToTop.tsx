import { useEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

/**
 * Puts every in-app page change back at the top of the window.
 *
 * React Router does not touch the scroll offset on a client-side navigation,
 * so following a link from the bottom of a long page (the footer, which every
 * page renders) left the next page already scrolled past its heading. Parents
 * reported landing partway down, or at the bottom of, the page they had just
 * opened.
 *
 * Mounted once next to the routes rather than repeated per page: a page that
 * forgets to call it is exactly how this comes back.
 *
 * Three things deliberately do NOT reset:
 *
 * - Back/forward (`POP`). The browser restores the offset of the history entry
 *   being returned to; forcing the top would throw that away and is not what
 *   "go back" means.
 * - `#anchor` targets. A hash is a request for a specific position on the
 *   page, so honouring it beats overriding it.
 * - Query-string-only changes. Tab, filter and modal state and the `?ref=`
 *   referral capture all write `location.search` without changing the page,
 *   so only `pathname` (and `hash`) are dependencies here.
 *
 * `window` is the scroll container to reset: `styles/app.scss` sets
 * `overflow-y: scroll` on `body` while `html` stays `visible`, which the CSS
 * overflow-propagation rule hands to the viewport. No layout in this app
 * scrolls a box of its own.
 */
export default function ScrollToTop() {
  const { pathname, hash } = useLocation();
  const navigationType = useNavigationType();

  useEffect(() => {
    if (navigationType === 'POP') return;
    if (hash) return;
    window.scrollTo(0, 0);
    // `navigationType` is read for the navigation this effect is already
    // running for, and is deliberately NOT a dependency: it flips from POP to
    // PUSH on the first navigation of a visit, which would re-run the effect
    // for a query-string-only change on the page the parent is already on.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pathname + hash are the page identity; see above
  }, [pathname, hash]);

  return null;
}
