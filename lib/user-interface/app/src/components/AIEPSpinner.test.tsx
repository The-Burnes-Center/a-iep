/**
 * The shared loading indicator.
 *
 * Two things here are contracts rather than looks, and both have been got
 * wrong in this app before: a spinner with no accessible name (the admin
 * console shipped `role="status"` with nothing inside it, which announces an
 * empty live region), and motion that ignores the OS setting.
 *
 * The reduced-motion half is asserted against AIEPSpinner.css on disk, because
 * that stylesheet is the implementation -- jsdom neither evaluates
 * `prefers-reduced-motion` nor runs animations, so a DOM assertion here could
 * only ever restate the mock. The three checks below are read together: the
 * cells animate by default, the reduce block stops them, and the class the
 * block names is the class the component renders. Break any one and this
 * fails.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import AIEPSpinner from "./AIEPSpinner";

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "AIEPSpinner.css"),
  "utf8",
);

/** The body of the first `@media (...query...)` block, braces balanced. */
function mediaBlock(query: string): string {
  const start = CSS.indexOf(`@media (${query})`);
  expect(start, `AIEPSpinner.css has no @media (${query}) block`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = CSS.indexOf("{", start); i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    if (CSS[i] === "}" && --depth === 0) return CSS.slice(start, i);
  }
  throw new Error(`@media (${query}) block is never closed`);
}

/** The body of a top-level rule, ignoring anything nested in a @media. */
function rule(selector: string): string {
  const body = CSS.slice(0, CSS.indexOf("@media"));
  const start = body.indexOf(`${selector} {`);
  expect(start, `AIEPSpinner.css has no ${selector} rule`).toBeGreaterThan(-1);
  return body.slice(start, body.indexOf("}", start));
}

describe("the loading indicator a parent hears", () => {
  it("announces the wait by name", () => {
    render(<AIEPSpinner label="Loading your summary" />);

    // role=status is a live region: what is read out is the text inside it,
    // so an unnamed spinner announces nothing at all.
    expect(screen.getByRole("status")).toHaveTextContent("Loading your summary");
  });

  it("stays out of the way when a visible label already names the wait", () => {
    // The in-button case: the button reads "Saving...", so announcing the
    // spinner as well would say it twice.
    const { container } = render(<AIEPSpinner />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(container.querySelector(".aiep-spinner")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("draws the four modules of the A-IEP mark", () => {
    const { container } = render(<AIEPSpinner label="Loading" />);

    expect(container.querySelectorAll("rect.aiep-spinner-cell")).toHaveLength(4);
    // The mark itself is decoration; the live region above carries the meaning.
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("sizes itself for a button, a card or a whole page", () => {
    const { container: inButton } = render(<AIEPSpinner size="sm" />);
    expect(inButton.querySelector(".aiep-spinner")).toHaveClass("aiep-spinner-sm");

    const { container: onPage } = render(
      <AIEPSpinner size="lg" fullPage label="Loading" />,
    );
    expect(onPage.querySelector(".aiep-spinner-page")).toBeInTheDocument();
    expect(onPage.querySelector(".aiep-spinner")).toHaveClass("aiep-spinner-lg");
  });

  it("defaults to the in-card size and no page wrapper", () => {
    const { container } = render(<AIEPSpinner label="Loading" />);

    expect(container.querySelector(".aiep-spinner")).toHaveClass("aiep-spinner-md");
    expect(container.querySelector(".aiep-spinner-page")).not.toBeInTheDocument();
  });
});

describe("colour", () => {
  it("lets the in-button size take the colour of the label beside it", () => {
    // Pinned because getting this wrong is invisible rather than broken: the
    // brand green is also the primary button's fill, so a spinner that forced
    // it disappeared into the "Saving..." button entirely.
    expect(rule(".aiep-spinner-sm")).toMatch(/color:\s*inherit/);
  });

  it("draws every colour from a palette token", () => {
    // color-contrast.test.tsx enforces this across the app; here so that a
    // literal introduced in this file fails with a message about this file.
    const literals = CSS.replace(/\/\*[\s\S]*?\*\//g, "").match(
      /#[0-9a-fA-F]{3,8}\b|rgba?\(/g,
    );
    expect(literals).toBeNull();
  });
});

describe("prefers-reduced-motion", () => {
  it("animates the modules when nothing has asked it not to", () => {
    // Without this the reduce assertion below would pass on a spinner that
    // never moved in the first place.
    expect(rule(".aiep-spinner-cell")).toMatch(
      /animation:\s*aiep-spinner-cycle\s/,
    );
    expect(CSS).toMatch(/@keyframes\s+aiep-spinner-cycle\s*{/);
  });

  it("stops the animation rather than slowing it down", () => {
    const reduced = mediaBlock("prefers-reduced-motion: reduce");

    expect(reduced).toContain(".aiep-spinner-cell");
    expect(reduced).toMatch(/animation:\s*none/);
    // Left visible, not faded out at whatever opacity the cycle stopped on.
    expect(reduced).toMatch(/opacity:\s*1/);
  });

  it("targets the class the component actually renders", () => {
    // The two assertions above are about a file. This is what ties them to
    // the DOM: rename the class in one place only and the suite goes red.
    const { container } = render(<AIEPSpinner label="Loading" />);
    const animated = container.querySelectorAll(".aiep-spinner-cell");

    expect(animated.length).toBeGreaterThan(0);
    expect(mediaBlock("prefers-reduced-motion: reduce")).toContain(
      ".aiep-spinner-cell",
    );
  });
});
