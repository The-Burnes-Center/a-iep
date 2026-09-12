/**
 * The consent step, rebuilt to the designer's screen: the heading, the
 * paragraph, one outlined row holding the checkbox, and a Continue button that
 * is inert until the box is ticked.
 *
 * The disabled button is the whole point of the screen — it is the only thing
 * standing between a parent and a document being processed without their
 * permission — so it is asserted in both directions, and the "agreed" state is
 * asserted to carry more than a colour change.
 *
 * The real component is driven through the DOM with the real router, mocking
 * only the boundary (Amplify's `Auth` and `fetch`). t() is the identity, so
 * assertions read translation KEYS; the wording is pinned in the dictionaries
 * by common/i18n.test.ts.
 */
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import ConsentForm from "./ConsentForm";
import { AppContext } from "../../common/app-context";
import { LanguageContext } from "../../common/language-context";
import type { AppConfig } from "../../common/types";
import type { SupportedLanguage } from "../../common/languages";

const Auth = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  fetchAuthSession: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("aws-amplify/auth", () => Auth);

const API_BASE = "https://api.example.test/api";
const PAGE = "/consent-form";

/** A parent who has not consented yet: the state the screen exists for. */
const NOT_YET_CONSENTED = {
  userId: "parent-1",
  secondaryLanguage: "en",
  consentGiven: false,
  showOnboarding: true,
  city: "",
  children: [{ childId: "child-1", name: "Alex Rivera", schoolCity: "Boston" }],
};

const appConfig = {
  httpEndpoint: `${API_BASE}/`,
  enabledFeatures: [],
  enabledLanguages: ["en", "es"],
} as unknown as AppConfig;

const stubFetch = (profile: Record<string, unknown>) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") !== "GET") {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ profile }) };
    }),
  );
};

const Here = () => <div data-testid="landed-on">{useLocation().pathname}</div>;

const renderPage = (profile: Record<string, unknown> = NOT_YET_CONSENTED) => {
  stubFetch(profile);
  render(
    <MemoryRouter initialEntries={[PAGE]}>
      <AppContext.Provider value={appConfig}>
        <LanguageContext.Provider
          value={{
            language: "en" as SupportedLanguage,
            setLanguage: vi.fn(),
            t: (key: string) => key,
            translationsLoaded: true,
            enabledLanguages: ["en", "es"] as SupportedLanguage[],
          }}
        >
          <Here />
          <Routes>
            <Route path={PAGE} element={<ConsentForm />} />
            <Route path="/preferred-language" element={<div>language step</div>} />
            <Route path="/how-to-use-the-tool" element={<div>how to use the tool</div>} />
            <Route path="/view-update-add-child" element={<div>child name step</div>} />
          </Routes>
        </LanguageContext.Provider>
      </AppContext.Provider>
    </MemoryRouter>,
  );

  return userEvent.setup();
};

const continueButton = () => screen.getByTestId("consent-continue-button");
/** The form is on screen once the mount-time profile load has resolved. */
const waitForForm = () => screen.findByRole("checkbox");

beforeEach(() => {
  Auth.getCurrentUser.mockResolvedValue({ username: "test-user", userId: "test-user" });
  Auth.fetchAuthSession.mockResolvedValue({
    tokens: { idToken: { toString: () => "id-token", payload: {} } },
  });
});

describe("the screen", () => {
  test("shows the heading, the permission paragraph, the agreement row and the button", async () => {
    renderPage();
    await waitForForm();

    expect(screen.getByRole("heading", { name: "consent.title" })).toBeInTheDocument();
    expect(screen.getByText("consent.text")).toBeInTheDocument();
    expect(screen.getByText("consent.checkbox")).toBeInTheDocument();
    expect(continueButton()).toHaveTextContent("consent.button");
  });
});

describe("the Continue button", () => {
  test("is disabled until the box is checked", async () => {
    renderPage();
    await waitForForm();

    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(continueButton()).toBeDisabled();
  });

  test("is enabled once the box is checked", async () => {
    const user = renderPage();
    await waitForForm();

    await user.click(screen.getByRole("checkbox"));

    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(continueButton()).toBeEnabled();
  });

  test("goes back to being disabled if the box is unchecked again", async () => {
    const user = renderPage();
    await waitForForm();

    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("checkbox"));

    expect(continueButton()).toBeDisabled();
  });
});

describe("the agreement row", () => {
  test("marks the agreed state with a tick, not only with a border colour", async () => {
    const user = renderPage();
    await waitForForm();

    expect(screen.queryByTestId("consent-agreed-tick")).toBeNull();

    await user.click(screen.getByRole("checkbox"));

    expect(screen.getByTestId("consent-agreed-tick")).toBeInTheDocument();
  });
});

describe("where consenting sends a parent", () => {
  test("on into the rest of onboarding", async () => {
    // studentNameGate is off in this config and the child already has a real
    // name, so the next step is how the tool works rather than the name form.
    const user = renderPage();
    await waitForForm();

    await user.click(screen.getByRole("checkbox"));
    await user.click(continueButton());

    await waitFor(() =>
      expect(screen.getByTestId("landed-on")).toHaveTextContent("/how-to-use-the-tool"),
    );
  });
});
