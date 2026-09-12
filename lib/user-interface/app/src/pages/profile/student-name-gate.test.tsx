/**
 * studentNameGate: the redirect itself, and what counts as a missing name.
 *
 * The product's call is student name first, then parent name, never a race
 * between the two (docs/STUDENT_NAME_REDACTION_PLAN.md, "Mandatory student
 * name in onboarding"). These drive the real onboarding components -
 * PreferredLanguage (the mandatory-checks gate a returning parent hits),
 * ConsentForm (the same gate on the "continue" path) and ViewAndAddChild (the
 * gate's destination) - through the DOM with the real router, mocking only
 * the boundary (Amplify's `Auth` and `fetch`).
 */
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import PreferredLanguage from "./PreferredLanguage";
import ConsentForm from "./ConsentForm";
import ViewAndAddChild from "./ViewAndAddChild";
import { AppContext } from "../../common/app-context";
import { LanguageContext } from "../../common/language-context";
import { AuthProvider } from "../../common/auth-provider";
import { DEFAULT_CHILD_NAME } from "../../common/features";
import type { AppConfig } from "../../common/types";
import type { Feature } from "../../common/features";
import type { SupportedLanguage } from "../../common/languages";

const Auth = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  fetchAuthSession: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("aws-amplify/auth", () => Auth);

const API_BASE = "https://api.example.test/api";

const appConfig = (enabledFeatures: Feature[]): AppConfig =>
  ({
    httpEndpoint: `${API_BASE}/`,
    enabledFeatures,
    enabledLanguages: ["en"],
  }) as unknown as AppConfig;

/** A returning parent: onboarding already marked done, so the mandatory
 * checks (consent, then studentNameGate) are what
 * decide where they land -- the branch these tests exercise. */
const profileWith = (overrides: Record<string, unknown>) => ({
  userId: "parent-1",
  secondaryLanguage: "en",
  consentGiven: true,
  showOnboarding: false,
  parentName: "Jane Rivera",
  children: [{ childId: "child-1", name: "Alex Rivera", schoolCity: "Boston" }],
  ...overrides,
});

const noStudentName = (extra: Record<string, unknown> = {}) =>
  profileWith({ children: [{ childId: "child-1", name: "", schoolCity: "Boston" }], ...extra });

const placeholderStudentName = (extra: Record<string, unknown> = {}) =>
  profileWith({
    children: [{ childId: "child-1", name: DEFAULT_CHILD_NAME, schoolCity: "Boston" }],
    ...extra,
  });

const Here = () => {
  const { pathname } = useLocation();
  return <div data-testid="landed-on">{pathname}</div>;
};

const languageValue = {
  language: "en" as SupportedLanguage,
  setLanguage: vi.fn(),
  // Identity: assertions read the destination, not the wording.
  t: (key: string) => key,
  translationsLoaded: true,
  enabledLanguages: ["en"] as SupportedLanguage[],
};

/** Answers every profile/document call. GET /profile returns `profile`;
 * the per-child documents GET always reports "no document" so the
 * hasExistingDocument branch stays out of the way; writes succeed unless
 * `failWrites`. */
const stubFetch = (profile: Record<string, unknown>, { failWrites = false } = {}) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (typeof url === "string" && url.includes("/documents")) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (method === "GET") {
        return { ok: true, status: 200, json: async () => ({ profile }) };
      }
      if (failWrites) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      if (typeof url === "string" && url.endsWith("/profile/children")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ message: "ok", childId: "new-child-id", createdAt: 1, createdAtISO: "x" }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
};

const renderPage = (
  path: string,
  page: React.ReactElement,
  enabledFeatures: Feature[],
) => {
  render(
    // Every test here walks the onboarding flow, and onboarding carries this
    // state on every hop. ViewAndAddChild reads it to tell finishing the flow
    // apart from coming back later to correct the name.
    <MemoryRouter initialEntries={[{ pathname: path, state: { onboardingContinue: true } }]}>
      <AppContext.Provider value={appConfig(enabledFeatures)}>
        <LanguageContext.Provider value={languageValue}>
          <AuthProvider>
            <Here />
            <Routes>
              <Route path={path} element={page} />
              <Route path="/consent-form" element={<div>consent step</div>} />
              <Route path="/view-update-add-child" element={<ViewAndAddChild />} />
              <Route path="/account-center/profile" element={<div>parent name step</div>} />
              <Route path="/iep-documents" element={<div>iep documents</div>} />
              <Route path="/summary-and-translations" element={<div>summary</div>} />
              <Route path="/how-to-use-the-tool" element={<div>how to use the tool</div>} />
              <Route path="/do-you-have-pdf" element={<div>pdf question</div>} />
            </Routes>
          </AuthProvider>
        </LanguageContext.Provider>
      </AppContext.Provider>
    </MemoryRouter>,
  );

  return userEvent.setup();
};

beforeEach(() => {
  Auth.getCurrentUser.mockResolvedValue({ username: "test-user", userId: "test-user" });
  Auth.fetchAuthSession.mockResolvedValue({
    tokens: { idToken: { toString: () => "id-token", payload: {} } },
  });
});

describe("PreferredLanguage's mandatory-checks gate", () => {
  test("sends a parent missing both names to the child form, not the parent form", async () => {
    stubFetch(noStudentName({ parentName: undefined }));
    renderPage("/preferred-language", <PreferredLanguage />, ["studentNameGate"]);

    await waitFor(() =>
      expect(screen.getByTestId("landed-on")).toHaveTextContent("/view-update-add-child"),
    );
  });

  test("goes straight into the app once the student's name is on file", async () => {
    // The parent's name is no longer collected during onboarding, so the
    // child's name is the last thing standing between here and the app.
    stubFetch(profileWith({ parentName: undefined }));
    renderPage("/preferred-language", <PreferredLanguage />, ["studentNameGate"]);

    await waitFor(() =>
      expect(screen.getByTestId("landed-on")).not.toHaveTextContent("/view-update-add-child"),
    );
    expect(screen.getByTestId("landed-on")).not.toHaveTextContent("/account-center/profile");
  });

  test("treats the auto-created 'My Child' placeholder as no name given", async () => {
    stubFetch(placeholderStudentName());
    renderPage("/preferred-language", <PreferredLanguage />, ["studentNameGate"]);

    await waitFor(() =>
      expect(screen.getByTestId("landed-on")).toHaveTextContent("/view-update-add-child"),
    );
  });

  test("does not redirect once a real name is on file (the gate stops firing)", async () => {
    stubFetch(profileWith({}));
    renderPage("/preferred-language", <PreferredLanguage />, ["studentNameGate"]);

    await waitFor(() =>
      expect(screen.getByTestId("landed-on")).toHaveTextContent("/summary-and-translations"),
    );
  });

  test("dark feature: a missing name does not redirect when studentNameGate is off", async () => {
    stubFetch(noStudentName());
    renderPage("/preferred-language", <PreferredLanguage />, []);

    await waitFor(() =>
      expect(screen.getByTestId("landed-on")).toHaveTextContent("/summary-and-translations"),
    );
  });
});

describe("ConsentForm's continue button, when consent is already given", () => {
  // The profile fixture already has consentGiven: true, so the checkbox
  // starts unchecked and flips on once loadProfile's async fetch resolves.
  // Clicking it (rather than waiting) would race that update and could
  // toggle it back off, so these wait for checked, then only click Continue.

  test("sends a parent missing both names to the child form first", async () => {
    stubFetch(noStudentName({ parentName: undefined }));
    const user = renderPage("/consent-form", <ConsentForm />, ["studentNameGate"]);

    await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
    await user.click(screen.getByRole("button", { name: "consent.button" }));

    await waitFor(() =>
      expect(screen.getByTestId("landed-on")).toHaveTextContent("/view-update-add-child"),
    );
  });

  test("goes on to how the tool works once the student's name is on file", async () => {
    // No parent-name step to fall through to any more: a parent whose child
    // is named carries on into the rest of onboarding from here.
    stubFetch(profileWith({ parentName: undefined }));
    const user = renderPage("/consent-form", <ConsentForm />, ["studentNameGate"]);

    await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
    await user.click(screen.getByRole("button", { name: "consent.button" }));

    await waitFor(() =>
      expect(screen.getByTestId("landed-on")).toHaveTextContent("/how-to-use-the-tool"),
    );
  });
});

describe("ViewAndAddChild, the gate's destination", () => {
  test("does not prefill the placeholder name as if it were a real answer", async () => {
    stubFetch(placeholderStudentName());
    renderPage("/view-update-add-child", <ViewAndAddChild />, ["studentNameGate"]);

    const nameField = (await screen.findByPlaceholderText(
      "child.name.placeholder",
    )) as HTMLInputElement;
    expect(nameField.value).toBe("");
    expect(screen.getByTestId("child-save-button")).toBeDisabled();
  });

  test("goes on into the rest of onboarding when the parent-name gate is not owed", async () => {
    stubFetch(noStudentName({ parentName: "Jane Rivera" }));
    const user = renderPage("/view-update-add-child", <ViewAndAddChild />, []);

    const nameField = await screen.findByPlaceholderText("child.name.placeholder");
    await user.type(nameField, "Alex Rivera");
    await user.click(screen.getByTestId("child-save-button"));

    await waitFor(() =>
      expect(screen.getByTestId("landed-on")).toHaveTextContent("/how-to-use-the-tool"),
    );
  });
});
