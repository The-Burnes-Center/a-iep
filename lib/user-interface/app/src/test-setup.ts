// Vitest setup, loaded before every file matched by vitest.config.ts.
//
// Lives under src/ on purpose: tsconfig.json includes only "src", so the
// jest-dom matcher type augmentation below reaches the test files and
// `npx tsc --noEmit` type-checks them alongside the app.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Auto-cleanup only self-registers when Vitest runs with `globals: true`;
// this suite imports its APIs explicitly, so unmount here instead. Without it
// a previous test's DOM stays mounted and `getByText` matches two nodes.
afterEach(() => {
  cleanup();
});

// jsdom ships no matchMedia. react-bootstrap's Offcanvas (the summary page's
// jargon drawer) reads it during render via @restart/hooks/useBreakpoint, so
// without this the page cannot mount at all. Reports "no match" and never
// fires, which is what a fixed-size test viewport means.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
