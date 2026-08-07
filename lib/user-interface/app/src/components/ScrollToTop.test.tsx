/**
 * Behaviour tests for the app-wide scroll reset.
 *
 * Parents reported opening a page and landing partway down it, or at its
 * bottom: React Router keeps the window's scroll offset across a client-side
 * navigation, and every page in this app renders a footer, so a footer link
 * left the next page already scrolled. ScrollToTop is mounted once next to the
 * routes and is the only thing that resets it.
 *
 * The real router drives these — only `window.scrollTo` is stubbed, because
 * jsdom has no layout — so what is asserted is "a navigation of this shape
 * does / does not reset the offset", not that a mock was wired up. The three
 * negative cases matter as much as the positive ones: a reset that fires on
 * back/forward, on an `#anchor`, or on a query-string-only change is its own
 * bug.
 */
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import ScrollToTop from "./ScrollToTop";

let scrollTo: ReturnType<typeof vi.spyOn>;

/**
 * Buttons for each shape of navigation the reset has to tell apart, plus a
 * readout of where the router currently is.
 */
const Page = ({ name }: { name: string }) => {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div>
      <div data-testid="page">{name}</div>
      <div data-testid="url">{location.pathname + location.search + location.hash}</div>
      <button onClick={() => navigate("/second")}>go to second</button>
      <button onClick={() => navigate("/second", { replace: true })}>replace with second</button>
      <button onClick={() => navigate("/first#goals")}>go to an anchor</button>
      <button onClick={() => navigate("/first?ref=abc")}>change the query string</button>
      <button onClick={() => navigate(-1)}>browser back</button>
    </div>
  );
};

const renderRoutes = () => {
  render(
    <MemoryRouter initialEntries={["/first"]}>
      <ScrollToTop />
      <Routes>
        <Route path="/first" element={<Page name="first" />} />
        <Route path="/second" element={<Page name="second" />} />
      </Routes>
    </MemoryRouter>,
  );

  return userEvent.setup();
};

const click = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
  await user.click(screen.getByRole("button", { name: label }));
};

beforeEach(() => {
  // jsdom has no layout, so its scrollTo only reports "not implemented".
  scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

describe("resets the offset", () => {
  test("on a push to another page", async () => {
    const user = renderRoutes();

    await click(user, "go to second");

    expect(screen.getByTestId("page")).toHaveTextContent("second");
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  test("on a replace, which is how the post-login redirect navigates", async () => {
    const user = renderRoutes();

    await click(user, "replace with second");

    expect(screen.getByTestId("page")).toHaveTextContent("second");
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });
});

describe("leaves the offset alone", () => {
  test("on first render, so a reload keeps the browser's restored position", () => {
    renderRoutes();

    expect(screen.getByTestId("page")).toHaveTextContent("first");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  test("on browser back, which the browser restores itself", async () => {
    const user = renderRoutes();

    await click(user, "go to second");
    scrollTo.mockClear();

    await click(user, "browser back");

    expect(screen.getByTestId("page")).toHaveTextContent("first");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  test("on an #anchor link, which asks for a position on the page", async () => {
    const user = renderRoutes();

    await click(user, "go to an anchor");

    expect(screen.getByTestId("url")).toHaveTextContent("/first#goals");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  test("on a query-string-only change, which is state and not a page change", async () => {
    const user = renderRoutes();

    await click(user, "change the query string");

    expect(screen.getByTestId("url")).toHaveTextContent("/first?ref=abc");
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
