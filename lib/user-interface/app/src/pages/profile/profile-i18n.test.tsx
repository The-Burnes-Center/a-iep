/**
 * The onboarding and profile flow, read by a parent who does not read English.
 *
 * Every screen here was already translated except its outcomes: the welcome
 * step had no t() call at all, and the toasts and error banners that report
 * what just happened were English literals in an otherwise Spanish page. The
 * language picker was the worst of them — a parent chose Vietnamese and was
 * told "Language preference updated successfully".
 *
 * These drive the real components with the REAL LanguageProvider and the real
 * dictionaries off disk, mocking only the boundary (Amplify's `Auth` and
 * `fetch`). t() is `translations[key] || key`, so a key that was never added
 * to es.json shows up here as the raw key on screen rather than as a passing
 * test — which is the whole failure mode this suite exists to catch.
 */
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import WelcomeIntro from "./WelcomeIntro";
import PreferredLanguage from "./PreferredLanguage";
import ConsentForm from "./ConsentForm";
import ViewAndAddChild from "./ViewAndAddChild";
import { AppContext } from "../../common/app-context";
import { LanguageProvider } from "../../common/language-context";
import { NotificationContext, NotificationProvider } from "../../components/notif-manager";
import type { AppConfig } from "../../common/types";

import en from "../../translations/en.json";
import es from "../../translations/es.json";
import ar from "../../translations/ar.json";

const Auth = vi.hoisted(() => ({
  currentAuthenticatedUser: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("aws-amplify", () => ({ Auth }));

const API_BASE = "https://api.example.test/api";
const LANGUAGE_STORAGE_KEY = "aiep-language-preference";

const appConfig = {
  httpEndpoint: `${API_BASE}/`,
  enabledFeatures: [],
  enabledLanguages: ["en", "es", "zh", "vi", "ar"],
} as unknown as AppConfig;

/** A parent past the language step, consent given, one child on file. */
const PROFILE = {
  userId: "parent-1",
  parentName: "Ana",
  secondaryLanguage: "es",
  consentGiven: true,
  showOnboarding: true,
  children: [{ childId: "child-1", name: "Luis", schoolCity: "Oakland" }],
};

/**
 * A parent at the very start: no language on file yet, so the picker stays put
 * instead of redirecting them onward.
 */
const NEW_PROFILE = { ...PROFILE, secondaryLanguage: undefined, consentGiven: false };

/**
 * What a parent would actually see of a notification. NotificationBar renders
 * `notif.content` into a Cloudscape Flashbar; this renders the same field, so
 * the assertion is on the string the page hands over, not on a call argument.
 */
const NotificationProbe = () => {
  const { notifications } = React.useContext(NotificationContext);
  return (
    <div data-testid="notifications">
      {notifications.map((notif) => (
        <div key={notif.id}>{notif.content}</div>
      ))}
    </div>
  );
};

const notificationText = () => screen.getByTestId("notifications").textContent ?? "";

/**
 * Mounts `page` under the real language provider in `language`, with stub
 * routes for everywhere the flow can navigate. Resolves once the provider has
 * loaded its dictionary and rendered its children (it renders null until then).
 */
const renderPage = async (language: string, path: string, page: React.ReactElement) => {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, language);

  render(
    <MemoryRouter initialEntries={[path]}>
      <AppContext.Provider value={appConfig}>
        <LanguageProvider>
          <NotificationProvider>
            <NotificationProbe />
            <Routes>
              <Route path={path} element={page} />
              <Route path="/preferred-language" element={<div>language step</div>} />
              <Route path="/consent-form" element={<div>consent step</div>} />
              <Route path="/welcome-intro" element={<div>welcome step</div>} />
              <Route path="/iep-documents" element={<div>iep documents</div>} />
              <Route path="/summary-and-translations" element={<div>summary</div>} />
              <Route path="/profile" element={<div>profile</div>} />
              <Route path="/account-center/profile" element={<div>name step</div>} />
            </Routes>
          </NotificationProvider>
        </LanguageProvider>
      </AppContext.Provider>
    </MemoryRouter>,
  );

  await screen.findByTestId("notifications");
  return userEvent.setup();
};

/**
 * A fetch that answers every profile call. `failWrites` turns the PUT/POST
 * calls into 500s while the initial GET still succeeds, which is exactly the
 * shape of the failure the error toasts report.
 */
const stubFetch = ({ failWrites = false, failReads = false, profile = PROFILE } = {}) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const isRead = (init?.method ?? "GET") === "GET";
      if (isRead && failReads) return { ok: false, status: 500, json: async () => ({}) };
      if (!isRead && failWrites) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ profile }) };
    }),
  );
};

/** No English literal and no raw dot-separated key made it onto the screen. */
const expectNoEnglishLeak = (englishStrings: string[]) => {
  for (const english of englishStrings) {
    expect(screen.queryByText(english), `"${english}" leaked in English`).toBeNull();
  }
  expect(document.body.textContent).not.toMatch(/\b[a-z]+(?:[A-Za-z]*\.[a-zA-Z]+){2,}\b/);
};

beforeEach(() => {
  localStorage.clear();
  Auth.currentAuthenticatedUser.mockResolvedValue({
    signInUserSession: { idToken: { jwtToken: "id-token" } },
  });
  stubFetch();
});

describe("the welcome step", () => {
  test("is read in Spanish, headline, body and button alike", async () => {
    await renderPage("es", "/welcome-intro", <WelcomeIntro />);

    expect(await screen.findByText(es["welcomeIntro.title"])).toBeInTheDocument();
    expect(screen.getByText(es["welcomeIntro.body1"])).toBeInTheDocument();
    expect(screen.getByText(es["welcomeIntro.body2"])).toBeInTheDocument();
    expect(screen.getByTestId("welcome-intro-continue")).toHaveTextContent(
      es["welcomeIntro.button.continue"],
    );
  });

  test("leaks neither the English wording nor a raw translation key", async () => {
    // The page had zero t() calls, so every string on it was English. A
    // half-done fix shows up as either the old English or, if a key never made
    // it into es.json, as "welcomeIntro.title" printed at the parent.
    await renderPage("es", "/welcome-intro", <WelcomeIntro />);
    await screen.findByText(es["welcomeIntro.title"]);

    expectNoEnglishLeak([
      en["welcomeIntro.title"],
      en["welcomeIntro.body1"],
      en["welcomeIntro.body2"],
      en["welcomeIntro.button.continue"],
    ]);
  });

  test("is read right-to-left in Arabic, with the document direction to match", async () => {
    await renderPage("ar", "/welcome-intro", <WelcomeIntro />);

    expect(await screen.findByText(ar["welcomeIntro.title"])).toBeInTheDocument();
    expect(screen.getByText(ar["welcomeIntro.body1"])).toBeInTheDocument();
    expect(document.documentElement.dir).toBe("rtl");
  });

  test("continues into the app, and says so in Spanish while it waits", async () => {
    // The button's disabled label was 'Loading...'; the navigation it guards
    // is what must still happen.
    const user = await renderPage("es", "/welcome-intro", <WelcomeIntro />);

    await user.click(await screen.findByTestId("welcome-intro-continue"));

    await waitFor(() => expect(screen.getByText("iep documents")).toBeInTheDocument());
  });
});

describe("the language picker's own messages", () => {
  test("confirm the change in the language the parent just chose", async () => {
    // Nothing on file yet, so choosing anything is a change and the save (and
    // the toast with it) actually happens.
    stubFetch({ profile: NEW_PROFILE });
    const user = await renderPage("es", "/preferred-language", <PreferredLanguage />);

    await user.click(await screen.findByRole("button", { name: /Prefiero Español/ }));

    await waitFor(() =>
      expect(notificationText()).toContain(es["preferredLanguage.success.updated"]),
    );
    expect(notificationText()).not.toContain(en["preferredLanguage.success.updated"]);
  });

  test("report a failed save in that language too", async () => {
    stubFetch({ failWrites: true, profile: NEW_PROFILE });
    const user = await renderPage("es", "/preferred-language", <PreferredLanguage />);

    await user.click(await screen.findByRole("button", { name: /Prefiero Español/ }));

    await waitFor(() =>
      expect(notificationText()).toContain(es["preferredLanguage.error.updateFailed"]),
    );
    expect(notificationText()).not.toContain(en["preferredLanguage.error.updateFailed"]);
  });

  test("say the service is down in Spanish, not in English", async () => {
    stubFetch({ failReads: true });
    await renderPage("es", "/preferred-language", <PreferredLanguage />);

    expect(await screen.findByText(es["profile.error.serviceUnavailable"])).toBeInTheDocument();
    expect(screen.queryByText(en["profile.error.serviceUnavailable"])).toBeNull();
  });
});

describe("the consent step's outcomes", () => {
  test("offer a way back in Spanish when the profile cannot be loaded", async () => {
    // Both the banner and the button beside it were English on a page whose
    // every other word is translated.
    stubFetch({ failReads: true });
    await renderPage("es", "/consent-form", <ConsentForm />);

    expect(await screen.findByText(es["profile.error.serviceUnavailable"])).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: es["common.tryAgain"] }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en["common.tryAgain"] })).toBeNull();
  });

  test("report a failed save in Spanish, on the banner and in the toast", async () => {
    // A parent who has not consented yet: ticking the box and continuing is
    // what writes, and the write is what fails here.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if ((init?.method ?? "GET") !== "GET") {
          return { ok: false, status: 500, json: async () => ({}) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ profile: { ...PROFILE, consentGiven: false } }),
        };
      }),
    );
    const user = await renderPage("es", "/consent-form", <ConsentForm />);

    await user.click(await screen.findByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: es["consent.button"] }));

    await waitFor(() =>
      expect(notificationText()).toContain(es["consent.error.saveFailed"]),
    );
    expect(await screen.findByText(es["consent.error.saveFailedRetry"])).toBeInTheDocument();
    expect(screen.queryByText(en["consent.error.saveFailedRetry"])).toBeNull();
  });
});

describe("the child step's outcomes", () => {
  test("confirm an update in Spanish", async () => {
    const user = await renderPage("es", "/view-update-add-child", <ViewAndAddChild />);

    await user.click(await screen.findByTestId("child-save-button"));

    await waitFor(() => expect(notificationText()).toContain(es["child.success.updated"]));
    expect(notificationText()).not.toContain(en["child.success.updated"]);
  });

  test("report a failed update in Spanish", async () => {
    stubFetch({ failWrites: true });
    const user = await renderPage("es", "/view-update-add-child", <ViewAndAddChild />);

    await user.click(await screen.findByTestId("child-save-button"));

    await waitFor(() => expect(notificationText()).toContain(es["child.error.updateFailed"]));
    expect(notificationText()).not.toContain(en["child.error.updateFailed"]);
  });
});

describe("the keys these screens depend on", () => {
  const locales = { en, es, ar } as Record<string, Record<string, string>>;
  const keys = [
    "welcomeIntro.title",
    "welcomeIntro.body1",
    "welcomeIntro.body2",
    "welcomeIntro.button.continue",
    "accountCenter.adminConsole",
    "common.loading",
    "common.saving",
    "common.tryAgain",
    "consent.success.saved",
    "consent.error.saveFailed",
    "consent.error.saveFailedRetry",
    "child.success.updated",
    "child.success.added",
    "child.error.updateFailed",
    "child.error.addFailed",
    "preferredLanguage.success.updated",
    "preferredLanguage.error.updateFailed",
  ];

  test.each(["es", "ar"])("%s translates every one of them", (code) => {
    for (const key of keys) {
      expect(locales[code][key], `${code} is missing ${key}`).toBeTruthy();
      expect(locales[code][key], `${code} left ${key} in English`).not.toBe(locales.en[key]);
    }
  });
});
