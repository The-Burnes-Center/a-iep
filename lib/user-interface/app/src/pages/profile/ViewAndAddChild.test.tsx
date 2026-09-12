/**
 * The student-name step, rebuilt to the designer's screen.
 *
 * It asks one question ("What is the name of your child?"), takes one answer,
 * and is the gate every family passes through once studentNameGate is on, so
 * these cover the three things that can break a parent's onboarding:
 *
 *  - the screen itself: one field, no School District, the line that explains
 *    why the name is asked for at all;
 *  - the contract underneath it: addChild still 400s without a schoolCity, so
 *    dropping the input must not drop the value;
 *  - where a save sends them, which is a three-way branch nothing else covers.
 *
 * The real component is driven through the DOM with the real router, mocking
 * only the boundary (Amplify's `Auth` and `fetch`), and the fetch stub records
 * every request so the assertions are about what reached the API rather than
 * about a spy on the client.
 */
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import ViewAndAddChild from "./ViewAndAddChild";
import { AppContext } from "../../common/app-context";
import { LanguageContext } from "../../common/language-context";
import { DEFAULT_CHILD_NAME } from "../../common/features";
import { ALL_LANGUAGES } from "../../common/languages";
import type { AppConfig } from "../../common/types";
import type { Feature } from "../../common/features";
import type { SupportedLanguage } from "../../common/languages";

// Suffixed: Vietnamese's code is `vi`, which is also vitest's own `vi`, and a
// bare `import vi` shadows it everywhere in this file.
import enDict from "../../translations/en.json";
import esDict from "../../translations/es.json";
import zhDict from "../../translations/zh.json";
import viDict from "../../translations/vi.json";
import arDict from "../../translations/ar.json";

const Auth = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  fetchAuthSession: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("aws-amplify/auth", () => Auth);

const API_BASE = "https://api.example.test/api";
const PAGE = "/view-update-add-child";

/** t() is the identity here, so assertions read translation KEYS: the English
 * wording is pinned once, at the bottom, against the dictionaries themselves. */
const setLanguage = vi.fn();
const languageValue = {
  language: "en" as SupportedLanguage,
  setLanguage,
  t: (key: string) => key,
  translationsLoaded: true,
  enabledLanguages: ["en", "es"] as SupportedLanguage[],
};

const appConfig = (enabledFeatures: Feature[]): AppConfig =>
  ({
    httpEndpoint: `${API_BASE}/`,
    enabledFeatures,
    enabledLanguages: ["en", "es"],
  }) as unknown as AppConfig;

const profileWith = (overrides: Record<string, unknown>) => ({
  userId: "parent-1",
  secondaryLanguage: "en",
  consentGiven: true,
  showOnboarding: false,
  parentName: "Jane Rivera",
  city: "",
  // What consent leaves behind: a child row with the placeholder name and a
  // school city, which is the state nearly every parent reaches this screen in.
  children: [{ childId: "child-1", name: DEFAULT_CHILD_NAME, schoolCity: "Boston" }],
  ...overrides,
});

type Recorded = { url: string; method: string; body: Record<string, unknown> | null };

let requests: Recorded[] = [];

/**
 * Answers every profile/document call and records the writes. `document` is
 * what GET .../documents returns: `{}` reads as "no document" in the client.
 */
const stubFetch = (
  profile: Record<string, unknown>,
  { failWrites = false, document = {} as Record<string, unknown> } = {},
) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      requests.push({
        url,
        method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });

      if (url.includes("/documents")) {
        return { ok: true, status: 200, json: async () => document };
      }
      if (method === "GET") {
        return { ok: true, status: 200, json: async () => ({ profile }) };
      }
      if (failWrites) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      if (url.endsWith("/profile/children")) {
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

const Here = () => <div data-testid="landed-on">{useLocation().pathname}</div>;

/**
 * Mounts the screen with stub routes for everywhere it can send a parent.
 * `from` puts an earlier entry behind it in the history stack, which is what
 * decides whether the Back control renders at all.
 */
const renderPage = (
  { enabledFeatures = [] as Feature[], from = null as string | null } = {},
) => {
  render(
    <MemoryRouter
      initialEntries={from ? [from, PAGE] : [PAGE]}
      initialIndex={from ? 1 : 0}
    >
      <AppContext.Provider value={appConfig(enabledFeatures)}>
        <LanguageContext.Provider value={languageValue}>
          <Here />
          <Routes>
            <Route path={PAGE} element={<ViewAndAddChild />} />
            <Route path="/account-center" element={<div>account center</div>} />
            <Route path="/account-center/profile" element={<div>parent name step</div>} />
            <Route path="/summary-and-translations" element={<div>summary</div>} />
            <Route path="/welcome-intro" element={<div>welcome intro</div>} />
          </Routes>
        </LanguageContext.Provider>
      </AppContext.Provider>
    </MemoryRouter>,
  );

  return userEvent.setup();
};

const nameField = () => screen.getByPlaceholderText("child.name.placeholder");
const saveButton = () => screen.getByTestId("child-save-button");
/** The form is on screen once the mount-time profile load has resolved. */
const waitForForm = () => screen.findByPlaceholderText("child.name.placeholder");

/** The write this screen makes, whichever of the two paths it took. */
const childWrite = () =>
  requests.find((r) => r.method === "POST" && r.url.endsWith("/profile/children")
    && r.body?.name !== DEFAULT_CHILD_NAME)
  ?? requests.find((r) => r.method === "PUT" && Array.isArray(r.body?.children));

beforeEach(() => {
  requests = [];
  setLanguage.mockClear();
  Auth.getCurrentUser.mockResolvedValue({ username: "test-user", userId: "test-user" });
  Auth.fetchAuthSession.mockResolvedValue({
    tokens: { idToken: { toString: () => "id-token", payload: {} } },
  });
});

describe("the screen", () => {
  test("asks one question, with one field and one button", async () => {
    stubFetch(profileWith({}));
    renderPage();
    await waitForForm();

    expect(screen.getByRole("heading", { name: "child.heading" })).toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(saveButton()).toHaveTextContent("child.button.save");
  });

  test("no longer asks for the school district", async () => {
    // The design has one field, and nothing reads schoolCity. The input is
    // gone by id (the e2e suite's anchor), by placeholder and by label.
    stubFetch(profileWith({}));
    renderPage();
    await waitForForm();

    expect(document.querySelector("#formSchoolCity")).toBeNull();
    expect(screen.queryByPlaceholderText("child.school.placeholder")).toBeNull();
    expect(screen.queryByText("child.school.label")).toBeNull();
  });

  test("carries no sub-copy under the heading", async () => {
    // The design is heading, field, button. What the name is used for is
    // explained on the privacy screen later in onboarding, so the old
    // `child.description` line is not rendered here (the key stays in the
    // dictionaries for that screen).
    stubFetch(profileWith({}));
    renderPage();
    await waitForForm();

    expect(screen.queryByText("child.description")).toBeNull();
    expect(screen.queryByText("child.title")).toBeNull();
  });

  test("keeps the field id the deployed suite drives", async () => {
    stubFetch(profileWith({}));
    renderPage();

    expect(await waitForForm()).toHaveAttribute("id", "formChildName");
  });
});

describe("the save button", () => {
  test("is disabled until a name is typed", async () => {
    stubFetch(profileWith({}));
    renderPage();
    await waitForForm();

    expect(saveButton()).toBeDisabled();
  });

  test("stays disabled for whitespace", async () => {
    stubFetch(profileWith({}));
    const user = renderPage();
    await waitForForm();

    await user.type(nameField(), "   ");

    expect(saveButton()).toBeDisabled();
  });

  test("enables on the name alone, for a child with no school district on file", async () => {
    // The old form required a school district too. A child row created before
    // consent started supplying one - or whose creation half-failed - has it
    // blank, and the parent was left on a permanently dead button with no
    // second field to fix it in.
    stubFetch(profileWith({ children: [{ childId: "child-1", name: "", schoolCity: "" }] }));
    const user = renderPage();
    await waitForForm();

    await user.type(nameField(), "Alex Rivera");

    expect(saveButton()).toBeEnabled();
  });
});

describe("what it sends", () => {
  test("keeps the school district already on file, for a child that exists", async () => {
    stubFetch(profileWith({}));
    const user = renderPage();
    await waitForForm();

    await user.type(nameField(), "Alex Rivera");
    await user.click(saveButton());

    await waitFor(() => expect(childWrite()).toBeDefined());
    const child = (childWrite()?.body?.children as Record<string, unknown>[])[0];
    expect(child.name).toBe("Alex Rivera");
    expect(child.schoolCity).toBe("Boston");
  });

  test("fills in a school district the child never had, rather than sending a blank one", async () => {
    stubFetch(profileWith({ children: [{ childId: "child-1", name: "", schoolCity: "" }] }));
    const user = renderPage();
    await waitForForm();

    await user.type(nameField(), "Alex Rivera");
    await user.click(saveButton());

    await waitFor(() => expect(childWrite()).toBeDefined());
    const child = (childWrite()?.body?.children as Record<string, unknown>[])[0];
    expect(child.schoolCity).toBeTruthy();
  });

  test("still sends a school district for a new child, because addChild requires one", async () => {
    // The backend answers 400 without it (user-profile-handler: "Missing
    // required fields: name and schoolCity required"), so the screen keeps
    // sending a value it no longer asks for.
    stubFetch(profileWith({ children: [] }));
    const user = renderPage();
    await waitForForm();

    await user.type(nameField(), "Alex Rivera");
    await user.click(saveButton());

    await waitFor(() => expect(childWrite()).toBeDefined());
    expect(childWrite()?.body).toMatchObject({ name: "Alex Rivera" });
    expect(childWrite()?.body?.schoolCity).toBeTruthy();
  });
});

describe("where saving sends a parent", () => {
  test("to the summary when a document is already on file", async () => {
    stubFetch(profileWith({}), { document: { status: "PROCESSED", iepId: "doc-1" } });
    const user = renderPage();
    await waitForForm();

    await user.type(nameField(), "Alex Rivera");
    await user.click(saveButton());

    await waitFor(() =>
      expect(screen.getByTestId("landed-on")).toHaveTextContent("/summary-and-translations"),
    );
  });

  test("to the welcome step when there is no document yet", async () => {
    stubFetch(profileWith({}));
    const user = renderPage();
    await waitForForm();

    await user.type(nameField(), "Alex Rivera");
    await user.click(saveButton());

    await waitFor(() =>
      expect(screen.getByTestId("landed-on")).toHaveTextContent("/welcome-intro"),
    );
  });
});

describe("a child already on file", () => {
  test("loads the stored name into the field for editing", async () => {
    stubFetch(profileWith({
      children: [{ childId: "child-1", name: "Alex Rivera", schoolCity: "Boston" }],
    }));
    renderPage();

    await waitFor(() => expect(nameField()).toHaveValue("Alex Rivera"));
    expect(saveButton()).toBeEnabled();
  });

  test("does not prefill the auto-created placeholder as if it were an answer", async () => {
    stubFetch(profileWith({}));
    renderPage();
    await waitForForm();

    expect(nameField()).toHaveValue("");
  });
});

describe("the Back control", () => {
  test("is not rendered when there is nowhere in the app to go back to", async () => {
    // A parent who opened this URL directly, or who was routed here by the
    // gate on the first navigation after signing in: going "back" would
    // leave the app, so there is no button to press.
    stubFetch(profileWith({}));
    renderPage();
    await waitForForm();

    expect(screen.queryByRole("button", { name: /common\.back/ })).toBeNull();
  });

  test("returns to the previous screen when one is behind it", async () => {
    stubFetch(profileWith({}));
    const user = renderPage({ from: "/account-center" });
    await waitForForm();

    await user.click(screen.getByRole("button", { name: /common\.back/ }));

    expect(screen.getByTestId("landed-on")).toHaveTextContent("/account-center");
  });
});

describe("the language selector", () => {
  test("switches the app's language through the app's own language state", async () => {
    // Reuse, not a second copy: the control writes to the LanguageContext
    // every other language picker in the app writes to.
    stubFetch(profileWith({}));
    const user = renderPage();
    await waitForForm();

    await user.click(screen.getByRole("button", { name: /English/ }));
    await user.click(await screen.findByText("Español"));

    expect(setLanguage).toHaveBeenCalledWith("es");
  });
});

describe("a failed save", () => {
  test("says so on the banner and leaves the parent's answer on screen", async () => {
    // Inline, not a toast, and not a page that replaces the form: the parent
    // has to be able to press the button again.
    stubFetch(profileWith({}), { failWrites: true });
    const user = renderPage();
    await waitForForm();

    await user.type(nameField(), "Alex Rivera");
    await user.click(saveButton());

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("child.error.updateFailed");
    expect(nameField()).toHaveValue("Alex Rivera");
    expect(saveButton()).toBeEnabled();
    expect(screen.getByTestId("landed-on")).toHaveTextContent(PAGE);
  });
});

describe("the copy this screen depends on", () => {
  const dictionaries: Record<string, Record<string, string>> = { en: enDict, es: esDict, zh: zhDict, vi: viDict, ar: arDict };
  // Every key the rebuilt screen renders. t() is `translations[key] || key`,
  // so a value missing from one file shows a parent "child.heading".
  const keys = [
    "child.heading",
    "child.name.label",
    "child.name.placeholder",
    "child.button.save",
    "child.button.saving",
    "child.error.updateFailed",
    "child.error.addFailed",
    "common.back",
    "common.loading",
    "profile.error.serviceUnavailable",
  ];

  test("is in all five dictionaries, non-empty", () => {
    expect(Object.keys(dictionaries).sort()).toEqual([...ALL_LANGUAGES].sort());
    const missing = ALL_LANGUAGES.flatMap((lang) =>
      keys.filter((key) => !dictionaries[lang][key]).map((key) => `${lang}: ${key}`),
    );
    expect(missing).toEqual([]);
  });

  test("is actually translated, not left in English", () => {
    const untranslated = ALL_LANGUAGES.filter((lang) => lang !== "en").flatMap((lang) =>
      keys
        .filter((key) => dictionaries[lang][key] === dictionaries.en[key])
        .map((key) => `${lang}: ${key}`),
    );
    expect(untranslated).toEqual([]);
  });

  test("asks the question and labels the button the way the design does", () => {
    expect(enDict["child.heading"]).toBe("What is the name of your child?");
    // Deliberate wording: it disambiguates for a parent with more than one child.
    expect(enDict["child.name.placeholder"]).toBe("Name of your child with an IEP");
    expect(enDict["child.button.save"]).toBe("Continue");
  });
});
