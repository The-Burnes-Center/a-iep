import React, { createContext, useContext, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconLanguage } from '@tabler/icons-react';
import './NavLanguageSlot.css';

/**
 * A place in the in-app bar for a screen's language picker.
 *
 * The picker belongs to the screen, not the bar: on the summary it chooses
 * which translation of a document to show (and marks the ones not made yet),
 * on Support, Rights and Account it is LanguagePreferenceDropdown. So the bar
 * only owns the spot, and each screen portals its own control into it.
 *
 * Where the spot sits is CSS (NavLanguageSlot.css): on the right of the green
 * bar on desktop, and on phones a round floating button just under the bar,
 * because four nav items already fill a phone's width.
 *
 * InAppChrome provides the context. Without a provider — a screen rendered
 * bare in a test — the control renders where it stands instead of vanishing.
 */
type SlotContextValue = {
  slot: HTMLElement | null;
  setSlot: (el: HTMLElement | null) => void;
};

const NavLanguageSlotContext = createContext<SlotContextValue | null>(null);

export function NavLanguageSlotProvider({ children }: { children: React.ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <NavLanguageSlotContext.Provider value={{ slot, setSlot }}>
      {children}
    </NavLanguageSlotContext.Provider>
  );
}

/** The spot itself, rendered by MobileTopNavigation. */
export function NavLanguageSlotTarget() {
  const context = useContext(NavLanguageSlotContext);
  return <div className="nav-language-slot" ref={context?.setSlot} />;
}

/** Wraps a screen's language picker so it renders into the bar. */
export function NavLanguageSlot({ children }: { children: React.ReactNode }) {
  const context = useContext(NavLanguageSlotContext);
  if (!context) return <>{children}</>;
  if (!context.slot) return null;
  return createPortal(children, context.slot);
}

/**
 * The toggle's contents: the language name as a pill on desktop, a language
 * icon on the phone's round button. Both are always rendered and CSS picks
 * one; on the phone the name is only visually hidden, so the toggle's
 * accessible name is the same on both.
 */
export function NavLanguageToggleContent({ label }: { label: string }) {
  return (
    <>
      <IconLanguage className="nav-language-icon" size={24} stroke={1.75} aria-hidden="true" />
      <span className="nav-language-label">{label}</span>
    </>
  );
}
