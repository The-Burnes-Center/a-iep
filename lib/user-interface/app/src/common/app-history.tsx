import React, { createContext, useContext, useEffect, useState } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

/**
 * How many of our own screens are stacked behind the current one.
 *
 * This exists because "can Back go anywhere useful?" has no answer in the
 * router's location. The obvious readings are both wrong:
 *
 *  - `location.key !== 'default'` says "not the first location", which is a
 *    different question. Signing in lands a parent on their next step via
 *    `navigate(from, { replace: true })`, and a replace mints a fresh key
 *    while adding no entry. The key said yes, the stack was empty, and
 *    navigate(-1) stepped off the end and out of the app. That is the blank
 *    URL that was reported.
 *  - `window.history.state.idx` is right in the browser but invisible to
 *    MemoryRouter, so every test would see zero and no test could cover the
 *    case where Back DOES work.
 *  - `window.history.length` counts other sites and never goes down.
 *
 * Counting the navigations ourselves answers the actual question and behaves
 * the same under both routers, so the tests exercise what a parent gets.
 *
 * Depth starts at zero and only PUSH adds to it: REPLACE swaps the current
 * entry rather than stacking one, which is precisely the case that was broken.
 */
const AppHistoryDepthContext = createContext(0);

// eslint-disable-next-line react-refresh/only-export-components -- context/provider co-located by design
export const useAppHistoryDepth = (): number => useContext(AppHistoryDepthContext);

/**
 * The browser's own count of entries behind this one.
 *
 * React Router stamps an index into history state and starts it at zero, so
 * this is exact where it is available, and a replace cannot inflate it. It is
 * the half that survives a RELOAD: refreshing mid-onboarding remounts the app
 * and resets the counted depth to zero, while the entries a parent stacked up
 * are still genuinely there to go back to.
 *
 * Absent under MemoryRouter, which keeps its stack off window.history. That is
 * why it is one of two signals rather than the only one.
 */
const browserHistoryDepth = (): number => {
  const index = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof index === 'number' ? index : 0;
};

/** True when there is a screen of ours to go back to. */
// eslint-disable-next-line react-refresh/only-export-components -- context/provider co-located by design
export const useCanGoBack = (): boolean =>
  useAppHistoryDepth() > 0 || browserHistoryDepth() > 0;

export const AppHistoryDepthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const navigationType = useNavigationType();
  const location = useLocation();
  const [depth, setDepth] = useState(0);

  // Keyed on location.key rather than the pathname: a parent who pushes the
  // same screen twice has two entries to unwind, and the pathname would not
  // change to say so.
  useEffect(() => {
    if (navigationType === 'PUSH') {
      setDepth((current) => current + 1);
      return;
    }
    if (navigationType === 'POP') {
      // Also the type of the very first render, where the floor is what keeps
      // a fresh load at zero rather than at minus one.
      setDepth((current) => Math.max(0, current - 1));
    }
    // REPLACE: the entry count is unchanged, so the depth is too.
  }, [location.key, navigationType]);

  return (
    <AppHistoryDepthContext.Provider value={depth}>
      {children}
    </AppHistoryDepthContext.Provider>
  );
};
