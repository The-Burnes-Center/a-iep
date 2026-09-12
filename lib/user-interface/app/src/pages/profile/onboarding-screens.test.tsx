/**
 * The three screens added to the tail of onboarding, and the chain they form.
 *
 * A parent reaches them straight after the child's name: how the tool works,
 * whether they already have the IEP as a PDF, and — if they do not — how to
 * ask the school for one. None of it writes anything, so what can break is
 * where each button goes and whether the copy arrives in the parent's own
 * language; both are covered here.
 *
 * The real components are driven through the DOM with the real router. t() is
 * the identity, so assertions read translation KEYS; the English wording and
 * the five-dictionary parity are pinned at the bottom of the file against the
 * dictionaries themselves.
 */
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import HowToUseTool from "./HowToUseTool";
import HaveIepPdf from "./HaveIepPdf";
import HowToAskForPdf from "./HowToAskForPdf";
import { LanguageContext } from "../../common/language-context";
import { ALL_LANGUAGES } from "../../common/languages";
import type { SupportedLanguage } from "../../common/languages";

// Suffixed: Vietnamese's code is `vi`, which is also vitest's own `vi`, and a
// bare `import vi` shadows it everywhere in this file.
import enDict from "../../translations/en.json";
import esDict from "../../translations/es.json";
import zhDict from "../../translations/zh.json";
import viDict from "../../translations/vi.json";
import arDict from "../../translations/ar.json";

const languageValue = {
  language: "en" as SupportedLanguage,
  setLanguage: vi.fn(),
  t: (key: string) => key,
  translationsLoaded: true,
  enabledLanguages: ["en", "es"] as SupportedLanguage[],
};

const Here = () => <div data-testid="landed-on">{useLocation().pathname}</div>;

const CHAIN = [
  { path: "/how-to-use-the-tool", element: <HowToUseTool /> },
  { path: "/do-you-have-pdf", element: <HaveIepPdf /> },
  { path: "/how-to-ask-for-pdf", element: <HowToAskForPdf /> },
];

/**
 * Mounts the whole chain at `start`, with stubs for every screen outside it a
 * button can reach, so a wrong destination shows up as a wrong `landed-on`
 * rather than as a blank page.
 */
const renderChain = (start: string) => {
  render(
    <MemoryRouter initialEntries={[start]}>
      <LanguageContext.Provider value={languageValue}>
        <Here />
        <Routes>
          {CHAIN.map((screen) => (
            <Route key={screen.path} path={screen.path} element={screen.element} />
          ))}
          <Route path="/iep-documents" element={<div>upload</div>} />
          <Route path="/view-resources" element={<div>resources</div>} />
          <Route path="/privacy-policy" element={<div>privacy policy</div>} />
        </Routes>
      </LanguageContext.Provider>
    </MemoryRouter>,
  );

  return userEvent.setup();
};

const landedOn = () => screen.getByTestId("landed-on").textContent;

describe("How to use the tool", () => {
  test("shows the heading, the three steps in order, and both buttons", () => {
    renderChain("/how-to-use-the-tool");

    expect(screen.getByRole("heading", { name: "howToUse.heading" })).toBeInTheDocument();

    const steps = screen.getAllByRole("listitem");
    expect(steps.map((step) => step.textContent)).toEqual([
      "1howToUse.step1",
      "2howToUse.step2",
      "3howToUse.step3",
    ]);

    expect(screen.getByTestId("how-to-use-continue")).toHaveTextContent("common.continue");
    expect(screen.getByTestId("how-to-use-privacy")).toHaveTextContent(
      "howToUse.button.privacy",
    );
  });

  test("numbers the steps as a list, so the order is not carried by the circles alone", () => {
    // The circled numbers are aria-hidden decoration; an <ol> is what makes a
    // screen reader announce "1 of 3".
    renderChain("/how-to-use-the-tool");

    expect(screen.getByRole("list").tagName).toBe("OL");
  });

  test("Continue goes to the PDF question", async () => {
    const user = renderChain("/how-to-use-the-tool");

    await user.click(screen.getByTestId("how-to-use-continue"));

    expect(landedOn()).toBe("/do-you-have-pdf");
  });

  test("the privacy button leads somewhere rather than dead-ending", async () => {
    // The dedicated "How we protect your privacy" screen is not written yet
    // (its copy names the vendors that see a document and is still with the
    // product owner), so the button opens the published privacy policy. What
    // this pins is that it is a real destination, not an inert button.
    const user = renderChain("/how-to-use-the-tool");

    await user.click(screen.getByTestId("how-to-use-privacy"));

    expect(landedOn()).not.toBe("/how-to-use-the-tool");
    expect(screen.getByText("privacy policy")).toBeInTheDocument();
  });
});

describe("Do you have the IEP as a PDF?", () => {
  test("shows the heading and both options, each with its own two-part answer", () => {
    renderChain("/do-you-have-pdf");

    expect(screen.getByRole("heading", { name: "havePdf.heading" })).toBeInTheDocument();

    expect(screen.getByTestId("have-pdf-yes")).toHaveTextContent("havePdf.yes.lead");
    expect(screen.getByTestId("have-pdf-yes")).toHaveTextContent("havePdf.yes.detail");
    expect(screen.getByTestId("have-pdf-no")).toHaveTextContent("havePdf.no.lead");
    expect(screen.getByTestId("have-pdf-no")).toHaveTextContent("havePdf.no.detail");
  });

  test("Yes goes to the upload", async () => {
    const user = renderChain("/do-you-have-pdf");

    await user.click(screen.getByTestId("have-pdf-yes"));

    expect(landedOn()).toBe("/iep-documents");
  });

  test("No goes to the screen that explains how to ask for one", async () => {
    const user = renderChain("/do-you-have-pdf");

    await user.click(screen.getByTestId("have-pdf-no"));

    expect(landedOn()).toBe("/how-to-ask-for-pdf");
  });
});

describe("How to ask for a PDF IEP", () => {
  test("shows the heading, the video and both buttons", () => {
    renderChain("/how-to-ask-for-pdf");

    expect(screen.getByRole("heading", { name: "howToAsk.heading" })).toBeInTheDocument();
    expect(screen.getByTestId("how-to-ask-video")).toBeInTheDocument();
    expect(screen.getByTestId("how-to-ask-upload")).toHaveTextContent("howToAsk.button.upload");
    expect(screen.getByTestId("how-to-ask-resources")).toHaveTextContent(
      "howToAsk.button.resources",
    );
  });

  test("says the video is still to come rather than embedding a guessed one", () => {
    // HOW_TO_ASK_VIDEO is deliberately null until the real URL is confirmed.
    // A wrong third-party embed would put an unrelated video, and whatever
    // that host sets on the device, in front of a family.
    renderChain("/how-to-ask-for-pdf");

    expect(screen.getByText(/howToAsk\.video\.comingSoon/)).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
  });

  test("Go to document upload goes to the upload", async () => {
    const user = renderChain("/how-to-ask-for-pdf");

    await user.click(screen.getByTestId("how-to-ask-upload"));

    expect(landedOn()).toBe("/iep-documents");
  });

  test("Get other resources goes to the resources page", async () => {
    const user = renderChain("/how-to-ask-for-pdf");

    await user.click(screen.getByTestId("how-to-ask-resources"));

    expect(landedOn()).toBe("/view-resources");
  });
});

describe("the chain, walked end to end", () => {
  test("how the tool works -> the PDF question -> how to ask -> the upload", async () => {
    // The long way round, the one a parent holding a printed IEP takes. The
    // short way (Yes at the question) is covered above.
    const user = renderChain("/how-to-use-the-tool");

    await user.click(screen.getByTestId("how-to-use-continue"));
    expect(landedOn()).toBe("/do-you-have-pdf");

    await user.click(screen.getByTestId("have-pdf-no"));
    expect(landedOn()).toBe("/how-to-ask-for-pdf");

    await user.click(screen.getByTestId("how-to-ask-upload"));
    expect(landedOn()).toBe("/iep-documents");
  });

  test("every screen offers a way back to the one before it", async () => {
    const user = renderChain("/how-to-use-the-tool");

    await user.click(screen.getByTestId("how-to-use-continue"));
    await user.click(screen.getByTestId("have-pdf-no"));
    expect(landedOn()).toBe("/how-to-ask-for-pdf");

    await user.click(screen.getByRole("button", { name: /common\.back/ }));
    expect(landedOn()).toBe("/do-you-have-pdf");

    await user.click(screen.getByRole("button", { name: /common\.back/ }));
    expect(landedOn()).toBe("/how-to-use-the-tool");
  });

  test("no Back button on the first screen a parent could land on directly", () => {
    // Same rule the student-name step uses: with nothing of ours behind this
    // page, Back would leave the app.
    renderChain("/how-to-use-the-tool");

    expect(screen.queryByRole("button", { name: /common\.back/ })).toBeNull();
  });
});

describe("the copy these screens depend on", () => {
  const dictionaries: Record<string, Record<string, string>> = {
    en: enDict, es: esDict, zh: zhDict, vi: viDict, ar: arDict,
  };
  // Every key the three screens render. t() is `translations[key] || key`, so
  // a value missing from one file shows a parent "howToUse.heading".
  const keys = [
    "howToUse.heading",
    "howToUse.step1",
    "howToUse.step2",
    "howToUse.step3",
    "howToUse.button.privacy",
    "havePdf.heading",
    "havePdf.yes.lead",
    "havePdf.yes.detail",
    "havePdf.no.lead",
    "havePdf.no.detail",
    "howToAsk.heading",
    "howToAsk.video.label",
    "howToAsk.video.comingSoon",
    "howToAsk.button.upload",
    "howToAsk.button.resources",
    "common.continue",
    "common.back",
  ];

  test("is in all five dictionaries, non-empty", () => {
    expect(Object.keys(dictionaries).sort()).toEqual([...ALL_LANGUAGES].sort());
    const missing = ALL_LANGUAGES.flatMap((lang) =>
      keys.filter((key) => !dictionaries[lang][key]).map((key) => `${lang}: ${key}`),
    );
    expect(missing).toEqual([]);
  });

  test("is actually translated, not left in English", () => {
    // "No," is genuinely the same word in Spanish, so it is exempt by name
    // rather than by weakening the check for everything else.
    const sameInSomeLanguages = new Set(["havePdf.no.lead"]);
    const untranslated = ALL_LANGUAGES.filter((lang) => lang !== "en").flatMap((lang) =>
      keys
        .filter((key) => !sameInSomeLanguages.has(key))
        .filter((key) => dictionaries[lang][key] === dictionaries.en[key])
        .map((key) => `${lang}: ${key}`),
    );
    expect(untranslated).toEqual([]);
  });

  test("reads the way the design does", () => {
    expect(enDict["howToUse.heading"]).toBe("How to use the tool");
    expect(enDict["howToUse.step1"]).toBe("Upload your IEP");
    expect(enDict["howToUse.step2"]).toBe("Summarize it");
    expect(enDict["howToUse.step3"]).toBe("Download it");
    expect(enDict["havePdf.heading"]).toBe("Do you have the IEP as a PDF?");
    expect(enDict["howToAsk.heading"]).toBe("How to ask for a PDF IEP");
  });
});
