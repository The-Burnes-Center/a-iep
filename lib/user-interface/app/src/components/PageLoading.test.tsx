/**
 * The one page-level loading state.
 *
 * df46e8e unified the loading indicator and left its placement per-screen, so
 * sixteen screens hand-rolled a wrapper in five different shapes. All five
 * centred horizontally and none centred vertically, which is why a parent saw
 * the mark sitting near the top of the screen rather than in the middle of it.
 *
 * Two things are pinned here. The announcement, because the old shape said
 * the same string twice to a screen reader (a labelled spinner AND a visible
 * <p> of the same text). And the source scan at the bottom, because the way
 * this regresses is somebody pasting a spinner into a <Container> on screen
 * seventeen, which no render test can see.
 *
 * The vertical centring itself is CSS (AIEPSpinner.css) and needs layout, so
 * jsdom cannot assert it. It was measured in a real browser instead: on a
 * 375x812 phone with the in-app bar and the compact footer, the mark's centre
 * moved from 39% of the viewport to 51%.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { render, screen } from "@testing-library/react";
import PageLoading from "./PageLoading";

describe("what a parent waiting is told", () => {
  test("a message is visible, and announced exactly once", () => {
    render(<PageLoading message="Loading your document" />);

    expect(screen.getByText("Loading your document")).toBeInTheDocument();

    // One announcement, not two. The old shape passed the same string as the
    // spinner's accessible name AND rendered it visibly, so it was read out
    // twice in a row.
    const announced = screen.getAllByRole("status");
    expect(announced).toHaveLength(1);
    expect(announced[0]).toHaveTextContent("Loading your document");
  });

  test("the mark is decoration when a message carries the wait", () => {
    const { container } = render(<PageLoading message="Loading" />);

    const mark = container.querySelector(".aiep-spinner");
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark).not.toHaveAttribute("role");
  });

  test("with no message, the mark itself names the wait", () => {
    // The route guards: there is no page yet to describe, so nothing visible
    // would carry the name if the spinner did not.
    render(<PageLoading label="Loading" />);

    const announced = screen.getAllByRole("status");
    expect(announced).toHaveLength(1);
    expect(announced[0]).toHaveTextContent("Loading");
  });

  test("a silent wait is impossible to ship by accident", () => {
    // Neither prop: nothing is announced. Asserted rather than left implicit
    // so the failure is visible here instead of in front of a parent using a
    // screen reader.
    render(<PageLoading />);
    expect(screen.queryAllByRole("status")).toHaveLength(0);
  });
});

describe("it fills the space rather than sitting in a fixed box", () => {
  test("carries the class the shell's flex fill is scoped to", () => {
    // .app-shell__main:has(> .aiep-spinner-page) is what turns <main> into a
    // column so this can take the free space. The selector is a direct-child
    // one, so the class has to be on the element the screen returns.
    const { container } = render(<PageLoading message="Loading" />);
    const box = container.firstElementChild;

    expect(box).toHaveClass("aiep-spinner-page");
    expect(box).toHaveClass("aiep-page-loading");
  });
});

// ---------------------------------------------------------------------------
// The regression a render test cannot see

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * Where a spinner larger than the in-button `sm` is legitimately not this
 * component:
 *
 *  - PageLoading itself, which draws it.
 *  - app-configured: the boot screen, which renders ABOVE AppShell and does
 *    want a whole viewport rather than the space <main> has.
 *  - ProcessingModal: inside a dark-green card, on its own layout.
 *  - CurrentIEPDocument: replaces one row of a card while the rest of the
 *    screen stays put, which is an inline wait, not a page-level one.
 */
const INLINE_BY_DESIGN =
  /components\/(PageLoading|AIEPSpinner|app-configured|ProcessingModal)\.tsx$|iep-folder\/CurrentIEPDocument\.tsx$/;

describe("the page-level loading state lives in one place", () => {
  test("no screen hand-rolls one out of AIEPSpinner", () => {
    const offenders = walk(SRC)
      .filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f))
      .filter((f) => !INLINE_BY_DESIGN.test(f))
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        // Every remaining legitimate use is the in-button size. Anything
        // bigger is a page-level wait and belongs in PageLoading.
        const uses = src.match(/<AIEPSpinner[^>]*>/g) ?? [];
        return uses.some((u) => !/size="sm"/.test(u));
      })
      .map((f) => relative(SRC, f));

    expect(
      offenders,
      "PageLoading is the page-level loading state; these build their own:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  test("none of the five old wrappers has come back", () => {
    // The exact shapes that were replaced: a centred box whose only job was
    // to hold a spinner. Matching the markup rather than the component means
    // this also catches a copy that reaches for react-bootstrap's Spinner.
    const offenders = walk(SRC)
      .filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f))
      .filter((f) => !INLINE_BY_DESIGN.test(f))
      .filter((f) =>
        /<(Container|div)[^>]*className="[^"]*text-center[^"]*"[^>]*>\s*(<div[^>]*>\s*)?<(AIEPSpinner|Spinner)/.test(
          readFileSync(f, "utf8"),
        ),
      )
      .map((f) => relative(SRC, f));

    expect(
      offenders,
      "these centre a spinner by hand instead of using PageLoading:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });
});
