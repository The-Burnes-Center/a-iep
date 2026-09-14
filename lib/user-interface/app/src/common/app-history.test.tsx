/**
 * When Back has somewhere of ours to go.
 *
 * The defect this replaces: the onboarding bar asked
 * `location.key !== 'default'`, which is a different question. Signing in
 * lands a parent on their next step via `navigate(from, { replace: true })`,
 * and a replace mints a fresh key while adding no history entry. The key said
 * "not the first location", the stack said "nothing behind me", and
 * navigate(-1) stepped off the end onto a blank URL.
 *
 * Two signals, because neither alone is right:
 *  - the counted depth knows about pushes and replaces, and is all MemoryRouter
 *    can offer, but resets to zero on a page reload;
 *  - the browser's index survives a reload but does not exist under
 *    MemoryRouter.
 */
import React from "react";
import { afterEach, describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { AppHistoryDepthProvider, useCanGoBack } from "./app-history";

/** Reports the answer, and offers the two ways of moving that change it. */
const Probe = ({ to }: { to: string }) => {
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="can-go-back">{useCanGoBack() ? "yes" : "no"}</div>
      <button onClick={() => navigate(to)}>push</button>
      <button onClick={() => navigate(to, { replace: true })}>replace</button>
      <button onClick={() => navigate(-1)}>back</button>
    </>
  );
};

const renderProbe = () => {
  render(
    <MemoryRouter initialEntries={["/one"]}>
      <AppHistoryDepthProvider>
        <Routes>
          <Route path="/one" element={<Probe to="/two" />} />
          <Route path="/two" element={<Probe to="/three" />} />
          <Route path="/three" element={<Probe to="/one" />} />
        </Routes>
      </AppHistoryDepthProvider>
    </MemoryRouter>,
  );
  return userEvent.setup();
};

const answer = () => screen.getByTestId("can-go-back").textContent;

afterEach(() => {
  window.history.replaceState(null, "");
});

describe("useCanGoBack", () => {
  test("is no on the screen a parent first lands on", () => {
    renderProbe();

    expect(answer()).toBe("no");
  });

  test("a replace does not make it yes, which is the reported defect", async () => {
    // Exactly what signing in does: CustomLogin sends the parent to their next
    // step with navigate(from, { replace: true }). One entry, still nothing
    // behind it, so Back must stay off.
    const user = renderProbe();

    await user.click(screen.getByRole("button", { name: "replace" }));

    expect(answer()).toBe("no");
  });

  test("a push makes it yes, and going back again makes it no", async () => {
    const user = renderProbe();

    await user.click(screen.getByRole("button", { name: "push" }));
    expect(answer()).toBe("yes");

    await user.click(screen.getByRole("button", { name: "push" }));
    expect(answer()).toBe("yes");

    await user.click(screen.getByRole("button", { name: "back" }));
    expect(answer()).toBe("yes");

    await user.click(screen.getByRole("button", { name: "back" }));
    expect(answer()).toBe("no");
  });

  test("a reload mid-flow still offers Back, because the browser kept the entries", () => {
    // The counted depth is lost when the app remounts, but the entries a
    // parent stacked up are still really there. Without the second signal,
    // refreshing the page would silently take Back away.
    window.history.replaceState({ idx: 2 }, "");

    renderProbe();

    expect(answer()).toBe("yes");
  });

  test("the browser's own index of zero is not mistaken for history", () => {
    window.history.replaceState({ idx: 0 }, "");

    renderProbe();

    expect(answer()).toBe("no");
  });
});
