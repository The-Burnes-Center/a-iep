/**
 * The bar's default picker: the parent's saved language preference.
 *
 * Two silent paths it used to have: with no profile loaded a pick did
 * nothing at all, and a failed save rolled back without a word, so the
 * choice simply seemed not to register.
 */
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import LanguagePreferenceDropdown from "./LanguagePreferenceDropdown";
import { AppContext } from "../common/app-context";
import { LanguageContext } from "../common/language-context";
import type { AppConfig } from "../common/types";
import type { SupportedLanguage } from "../common/languages";

const Api = vi.hoisted(() => ({
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
}));
vi.mock("../common/api-client/api-client", () => ({
  ApiClient: class {
    profile = { getProfile: Api.getProfile, updateProfile: Api.updateProfile };
  },
}));

const setLanguage = vi.fn();

const renderPicker = (withQueryClient = true) => {
  const languageValue = {
    language: "en" as SupportedLanguage,
    setLanguage,
    t: (key: string) => key,
    translationsLoaded: true,
    enabledLanguages: ["en", "es"] as SupportedLanguage[],
  };
  const tree = (
    <AppContext.Provider value={{ httpEndpoint: "https://api.example.test/" } as unknown as AppConfig}>
      <LanguageContext.Provider value={languageValue}>
        <LanguagePreferenceDropdown />
      </LanguageContext.Provider>
    </AppContext.Provider>
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(withQueryClient ? <QueryClientProvider client={client}>{tree}</QueryClientProvider> : tree);
  return userEvent.setup();
};

const toggle = () => screen.getByTestId("language-preference-toggle");

const pick = async (user: ReturnType<typeof userEvent.setup>, code: string) => {
  await user.click(toggle());
  await user.click(await screen.findByTestId(`language-preference-option-${code}`));
};

beforeEach(() => {
  Api.getProfile.mockReset();
  Api.updateProfile.mockReset();
  setLanguage.mockReset();
});

describe("the default picker", () => {
  test("saves the preference and switches the screen", async () => {
    Api.getProfile.mockResolvedValue({ secondaryLanguage: "en" });
    Api.updateProfile.mockResolvedValue({});
    const user = renderPicker();
    await waitFor(() => expect(toggle()).toHaveAttribute("data-ready", "true"));

    await pick(user, "es");

    expect(Api.updateProfile).toHaveBeenCalledWith({ secondaryLanguage: "es" });
    expect(setLanguage).toHaveBeenCalledWith("es");
  });

  test("still switches the screen when the profile could not be loaded", async () => {
    Api.getProfile.mockRejectedValue(new Error("down"));
    const user = renderPicker();
    await waitFor(() => expect(Api.getProfile).toHaveBeenCalled());

    await pick(user, "es");

    expect(setLanguage).toHaveBeenCalledWith("es");
    expect(Api.updateProfile).not.toHaveBeenCalled();
  });

  test("says so when the save fails, and puts the old language back", async () => {
    Api.getProfile.mockResolvedValue({ secondaryLanguage: "en" });
    Api.updateProfile.mockRejectedValue(new Error("down"));
    const user = renderPicker();
    await waitFor(() => expect(toggle()).toHaveAttribute("data-ready", "true"));

    await pick(user, "es");

    expect(await screen.findByRole("alert")).toHaveTextContent("languageMenu.saveFailed");
    expect(setLanguage).toHaveBeenLastCalledWith("en");
  });

  test("is named for what it is, with the language it shows", async () => {
    Api.getProfile.mockResolvedValue({ secondaryLanguage: "es" });
    renderPicker();

    await waitFor(() => expect(toggle()).toHaveAccessibleName("languageMenu.label: Español ES"));
  });

  test("lines the screen up when the pick is the language already saved", async () => {
    // The browser forgot (cleared storage) and shows English; Spanish is saved.
    Api.getProfile.mockResolvedValue({ secondaryLanguage: "es" });
    const user = renderPicker();
    await waitFor(() => expect(toggle()).toHaveAttribute("data-ready", "true"));

    await pick(user, "es");

    expect(setLanguage).toHaveBeenCalledWith("es");
    expect(Api.updateProfile).not.toHaveBeenCalled();
  });

  test("shows the screen's language when the saved one is not offered here", async () => {
    // Arabic saved, but this environment offers English and Spanish only.
    Api.getProfile.mockResolvedValue({ secondaryLanguage: "ar" });
    renderPicker();

    await waitFor(() => expect(toggle()).toHaveAttribute("data-ready", "true"));
    expect(toggle()).toHaveAccessibleName("languageMenu.label: English EN");
  });

  test("a second pick while the first is saving sends nothing", async () => {
    Api.getProfile.mockResolvedValue({ secondaryLanguage: "en" });
    Api.updateProfile.mockReturnValue(new Promise(() => {}));
    const user = renderPicker();
    await waitFor(() => expect(toggle()).toHaveAttribute("data-ready", "true"));

    await pick(user, "es");
    expect(toggle()).toHaveAttribute("aria-disabled", "true");
    await user.click(toggle());

    // The menu stays mounted once opened, so "did not open" is aria-expanded.
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(Api.updateProfile).toHaveBeenCalledTimes(1);
  });

  test("without the app's query client, switches the screen only", async () => {
    const user = renderPicker(false);

    await pick(user, "es");

    expect(setLanguage).toHaveBeenCalledWith("es");
    expect(Api.getProfile).not.toHaveBeenCalled();
  });
});
