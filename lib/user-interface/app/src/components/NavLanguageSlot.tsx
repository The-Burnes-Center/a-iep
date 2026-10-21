import React, { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import './NavLanguageSlot.css';

/**
 * The language picker's one place in the in-app bar.
 *
 * Every signed-in screen shows the picker in the same spot: on the right of
 * the green bar on desktop, and on phones a round floating button just under
 * the bar (NavLanguageSlot.css). By default the bar fills that spot itself
 * with the parent's language preference (MobileTopNavigation passes it as
 * the `fallback`), so a screen gets the picker without doing anything.
 *
 * A screen that needs a different picker there claims the spot by rendering
 * <NavLanguageSlot>: the summary puts its own (which marks the languages not
 * translated yet), and the language step of onboarding renders it empty,
 * because that whole screen is a language picker. Claims are made in a
 * layout effect, so the default never flashes before a screen's own.
 *
 * Without a provider (a screen rendered bare in a test) NavLanguageSlot
 * renders its children where it stands instead of vanishing.
 */
type SlotContextValue = {
  slot: HTMLElement | null;
  setSlot: (el: HTMLElement | null) => void;
  claims: number;
  claim: () => () => void;
};

const NavLanguageSlotContext = createContext<SlotContextValue | null>(null);

export function NavLanguageSlotProvider({ children }: { children: React.ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [claims, setClaims] = useState(0);
  const claim = useCallback(() => {
    setClaims((count) => count + 1);
    return () => setClaims((count) => count - 1);
  }, []);
  const value = useMemo(() => ({ slot, setSlot, claims, claim }), [slot, claims, claim]);
  return <NavLanguageSlotContext.Provider value={value}>{children}</NavLanguageSlotContext.Provider>;
}

/**
 * The spot itself, rendered by MobileTopNavigation. `fallback` is what shows
 * there when no screen has claimed it.
 */
export function NavLanguageSlotTarget({ fallback }: { fallback?: React.ReactNode }) {
  const context = useContext(NavLanguageSlotContext);
  // Only under a provider: without one (the bar rendered bare in a test)
  // there is no way for a screen to claim the spot, so nothing is assumed.
  const showFallback = Boolean(context) && context!.claims === 0;
  return (
    <div className="nav-language-slot" ref={context?.setSlot}>
      {showFallback ? fallback : null}
    </div>
  );
}

/**
 * Claims the spot for a screen's own picker. With no children it claims the
 * spot and leaves it empty, which hides the bar's default.
 */
export function NavLanguageSlot({ children }: { children?: React.ReactNode }) {
  const context = useContext(NavLanguageSlotContext);
  const claim = context?.claim;
  useLayoutEffect(() => (claim ? claim() : undefined), [claim]);
  if (!context) return <>{children}</>;
  if (!context.slot || children == null) return null;
  return createPortal(children, context.slot);
}
