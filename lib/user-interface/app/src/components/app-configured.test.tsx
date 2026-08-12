/**
 * app-configured is where the app's provider tree is decided, and two of the
 * things decided there have gone wrong before.
 *
 * The notification queue was mounted only by a layout component nothing routed
 * imported, so roughly ten addNotification calls resolved to the context
 * default and were discarded for two years. Mounting it correctly is not just
 * "a provider exists": it has to sit under LanguageProvider, so the toast
 * chrome can call t(), and OUTSIDE <Routes>, because every profile form saves
 * and then navigates. So this suite renders the REAL AppConfigured and stubs
 * only AppRoutes, with a route pair that raises a toast and immediately leaves
 * the page. A provider moved inside the route element passes a hand-built
 * tree and fails here.
 *
 * The boot and configuration-error screens are the other half: they render
 * ABOVE LanguageProvider, which is why their text is English, and they are the
 * only thing a parent sees if /aws-exports.json is missing.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AppConfigured from "./app-configured";

const { SUCCESS_TEXT, ERROR_TEXT, NEXT_PAGE } = vi.hoisted(() => ({
  SUCCESS_TEXT: "Your translation is ready",
  ERROR_TEXT: "Saving failed",
  NEXT_PAGE: "the page after the redirect",
}));

const Amplify = vi.hoisted(() => ({ configure: vi.fn() }));
const Auth = vi.hoisted(() => ({
  currentAuthenticatedUser: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("aws-amplify", () => ({ Amplify, Auth }));

/**
 * Stands in for the route tree. It owns a real <Routes>, exactly as the real
 * AppRoutes does, so "outside <Routes>" is a property this suite can actually
 * observe: the home route raises a notification and navigates away in the same
 * handler, which is what ConsentForm, ViewAndAddChild and DeleteProfileModal
 * all do.
 */
vi.mock("./AppRoutes", async () => {
  const { Route, Routes, useNavigate } = await import("react-router-dom");
  const { useNotifications } = await import("./notif-manager");

  const SaveAndLeave = () => {
    const { addNotification } = useNotifications();
    const navigate = useNavigate();
    return (
      <>
        <button
          onClick={() => {
            addNotification("success", SUCCESS_TEXT);
            navigate("/next");
          }}
        >
          save and leave
        </button>
        <button onClick={() => addNotification("error", ERROR_TEXT)}>fail in place</button>
      </>
    );
  };

  return {
    default: () => (
      <Routes>
        <Route path="/" element={<SaveAndLeave />} />
        <Route path="/next" element={<div>{NEXT_PAGE}</div>} />
      </Routes>
    ),
  };
});

const CONFIG = {
  httpEndpoint: "https://api.example.test/api/",
  // Not "prod", so initAnalytics stays out of it.
  environment: "dev",
  enabledFeatures: [],
  enabledLanguages: ["en"],
};

/** Answers the one fetch AppConfigured makes, for /aws-exports.json. */
const stubConfigFetch = (answer: "ok" | "reject" | "pending") => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      if (answer === "reject") return Promise.reject(new Error("404"));
      if (answer === "pending") return new Promise(() => {});
      return Promise.resolve({ json: async () => CONFIG });
    }),
  );
};

/** Renders and waits for the language dictionary, which gates all children. */
const renderApp = async () => {
  render(<AppConfigured />);
  await screen.findByText("save and leave");
};

beforeEach(() => {
  // AppConfigured mounts a real BrowserRouter, which reads jsdom's one shared
  // history. Without this reset the navigation in the first test below leaves
  // every later test starting on /next.
  window.history.pushState({}, "", "/");
  Auth.currentAuthenticatedUser.mockRejectedValue(new Error("not signed in"));
  // console.error is the real one; the error-state test drives a rejected
  // fetch through the component's own catch, which logs on purpose.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("boot states", () => {
  test("shows a spinner with a name while the configuration loads", () => {
    stubConfigFetch("pending");
    render(<AppConfigured />);

    // role=status is a live region: the text inside it is what gets read out,
    // and a bare spinning div would announce nothing at all.
    const indicator = screen.getByRole("status");
    expect(indicator).toHaveTextContent("Loading configuration...");
    expect(indicator).toHaveClass("spinner-border");
  });

  test("reports a missing configuration as an alert, not a blank screen", async () => {
    stubConfigFetch("reject");
    render(<AppConfigured />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Configuration error");
    expect(alert).toHaveTextContent("/aws-exports.json");
    expect(screen.getByRole("link", { name: "/aws-exports.json" })).toHaveAttribute(
      "href",
      "/aws-exports.json",
    );
  });
});

describe("the notification queue in the real provider tree", () => {
  test("a toast raised just before a navigation survives it", async () => {
    stubConfigFetch("ok");
    await renderApp();

    fireEvent.click(screen.getByText("save and leave"));

    // The page that raised it is gone...
    expect(await screen.findByText(NEXT_PAGE)).toBeInTheDocument();
    expect(screen.queryByText("save and leave")).not.toBeInTheDocument();
    // ...and the confirmation is still on screen. This is the whole reason the
    // provider sits above <Routes> rather than inside a route element.
    expect(screen.getByText(SUCCESS_TEXT)).toBeInTheDocument();
  });

  test("an error raised from a route reaches the parent as an alert", async () => {
    stubConfigFetch("ok");
    await renderApp();

    fireEvent.click(screen.getByText("fail in place"));

    const toast = await screen.findByTestId("notification-error");
    expect(toast).toHaveTextContent(ERROR_TEXT);
    expect(toast).toHaveAttribute("role", "alert");
  });

  test("the dismiss control is translated by the dictionary this tree loads", async () => {
    stubConfigFetch("ok");
    await renderApp();
    fireEvent.click(screen.getByText("fail in place"));

    // Not the raw key: proves the toast really is under LanguageProvider, with
    // en.json loaded, rather than falling back to the identity t() of the
    // default context.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Dismiss notification" }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "notifications.dismiss" })).toBeNull();
  });
});
