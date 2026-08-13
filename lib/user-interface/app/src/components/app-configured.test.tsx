/**
 * The boot and configuration-error screens.
 *
 * These render ABOVE LanguageProvider, which is why their text is English, and
 * they are the only thing a parent sees if /aws-exports.json is missing. They
 * were Cloudscape's StatusIndicator and Alert until the Cloudscape removal;
 * these tests pin the accessible semantics that swap had to preserve, which is
 * the part a visual check would miss.
 *
 * This file also used to cover the notification queue's position in the
 * provider tree. The toasts were removed at DB's request, so there is nothing
 * left to pin there.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import AppConfigured from "./app-configured";

const Amplify = vi.hoisted(() => ({ configure: vi.fn() }));
const Auth = vi.hoisted(() => ({
  currentAuthenticatedUser: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("aws-amplify", () => ({ Amplify, Auth }));

/** The route tree is not what this file is about; keep it out of the way. */
vi.mock("./AppRoutes", () => ({ default: () => <div>the routed app</div> }));

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

beforeEach(() => {
  // AppConfigured mounts a real BrowserRouter, which reads jsdom's one shared
  // history.
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

  test("renders the routed app once the configuration is in", async () => {
    stubConfigFetch("ok");
    render(<AppConfigured />);

    // The provider tree resolving at all is the thing here: LanguageProvider
    // renders null until its dictionary lands, so a broken provider order shows
    // up as this never appearing.
    expect(await screen.findByText("the routed app")).toBeInTheDocument();
  });
});
