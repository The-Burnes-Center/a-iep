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
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import HowToUseTool from "./HowToUseTool";
import HaveIepPdf from "./HaveIepPdf";
import HowToAskForPdf from "./HowToAskForPdf";
import { LanguageContext } from "../../common/language-context";
import { AppContext } from "../../common/app-context";
import type { AppConfig } from "../../common/types";
import type { Feature } from "../../common/features";
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
const appConfig = (enabledFeatures: Feature[]): AppConfig =>
  ({ enabledFeatures, enabledLanguages: ["en", "es"] }) as unknown as AppConfig;

const renderChain = (start: string, enabledFeatures: Feature[] = ["pdfHelpScreens"]) => {
  render(
    <MemoryRouter initialEntries={[start]}>
      <AppContext.Provider value={appConfig(enabledFeatures)}>
      <LanguageContext.Provider value={languageValue}>
        <Here />
        <Routes>
          {CHAIN.map((screen) => (
            <Route key={screen.path} path={screen.path} element={screen.element} />
          ))}
          <Route path="/iep-documents" element={<div>upload</div>} />
          <Route path="/view-resources" element={<div>resources</div>} />
          <Route path="/how-we-protect-your-privacy" element={<div>how we protect your privacy</div>} />
          {/* Where the trail on the first screen of the chain leads, under
              each setting of studentNameGate. */}
          <Route path="/consent-form" element={<div>consent step</div>} />
          <Route path="/view-update-add-child" element={<div>child name step</div>} />
        </Routes>
      </LanguageContext.Provider>
      </AppContext.Provider>
    </MemoryRouter>,
  );

  return userEvent.setup();
};

const landedOn = () => screen.getByTestId("landed-on").textContent;

/**
 * The lists belonging to the page itself. The breadcrumb trail is an <ol> too,
 * so a bare getAllByRole("list") now picks it up alongside the numbered steps
 * these tests are about.
 */
const contentLists = () =>
  screen.getAllByRole("list").filter((list) => !list.closest("nav"));

/** Every step across those lists, in reading order. */
const contentListItems = () =>
  contentLists().flatMap((list) => within(list).getAllByRole("listitem"));

describe("How to use the tool", () => {
  test("shows the heading, the three steps in order, and both buttons", () => {
    renderChain("/how-to-use-the-tool");

    expect(screen.getByRole("heading", { name: "howToUse.heading" })).toBeInTheDocument();

    const steps = contentListItems();
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

    expect(contentLists().map((list) => list.tagName)).toEqual(["OL"]);
  });

  test("Continue goes to the PDF question", async () => {
    const user = renderChain("/how-to-use-the-tool");

    await user.click(screen.getByTestId("how-to-use-continue"));

    expect(landedOn()).toBe("/do-you-have-pdf");
  });

  test("the privacy button opens the screen that explains what happens to the document", async () => {
    // The dedicated screen, not the published privacy policy: see
    // HowWeProtectYourPrivacy.test.tsx for what it says once it is open.
    const user = renderChain("/how-to-use-the-tool");

    await user.click(screen.getByTestId("how-to-use-privacy"));

    expect(landedOn()).toBe("/how-we-protect-your-privacy");
  });
});

describe("where the printed-IEP screens are held back", () => {
  test("Continue goes straight to the upload, skipping the question", async () => {
    // Production, where pdfHelpScreens is dark. The question only exists to
    // lead to the guide, so with the guide held back there is nothing to ask.
    const user = renderChain("/how-to-use-the-tool", []);

    await user.click(screen.getByTestId("how-to-use-continue"));

    expect(landedOn()).toBe("/iep-documents");
  });

  test("Continue asks the question wherever they are enabled", async () => {
    const user = renderChain("/how-to-use-the-tool", ["pdfHelpScreens"]);

    await user.click(screen.getByTestId("how-to-use-continue"));

    expect(landedOn()).toBe("/do-you-have-pdf");
  });

  test("the privacy screen stays reachable either way", async () => {
    // It is not part of the pair, and a parent should be able to read what
    // happens to their document whatever else is held back.
    const user = renderChain("/how-to-use-the-tool", []);

    await user.click(screen.getByTestId("how-to-use-privacy"));

    expect(landedOn()).toBe("/how-we-protect-your-privacy");
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

  test("every screen's trail leads back to the one before it", async () => {
    // The trail is walked backwards here, which is the half of the chain the
    // forward test above cannot reach. Each crumb is followed by its LABEL,
    // so a screen that named the wrong previous step fails on the name before
    // it fails on the route.
    const user = renderChain("/how-to-use-the-tool");

    await user.click(screen.getByTestId("how-to-use-continue"));
    await user.click(screen.getByTestId("have-pdf-no"));
    expect(landedOn()).toBe("/how-to-ask-for-pdf");

    await user.click(screen.getByRole("link", { name: "breadcrumb.yourIep" }));
    expect(landedOn()).toBe("/do-you-have-pdf");

    await user.click(screen.getByRole("link", { name: "breadcrumb.howItWorks" }));
    expect(landedOn()).toBe("/how-to-use-the-tool");
  });

  test("each screen says which step it is, and offers exactly one way back", async () => {
    const user = renderChain("/how-to-use-the-tool");
    expect(screen.getByText("breadcrumb.howItWorks")).toHaveAttribute("aria-current", "page");
    expect(screen.getAllByRole("link")).toHaveLength(1);

    await user.click(screen.getByTestId("how-to-use-continue"));
    expect(screen.getByText("breadcrumb.yourIep")).toHaveAttribute("aria-current", "page");
    expect(screen.getAllByRole("link")).toHaveLength(1);

    await user.click(screen.getByTestId("have-pdf-no"));
    expect(screen.getByText("breadcrumb.askForPdf")).toHaveAttribute("aria-current", "page");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  // These two replace a test that pinned "no Back button here", which was the
  // old bar's answer to not knowing what came before. studentNameGate is what
  // decides it: with the gate on, consent reaches this screen through the
  // child's name; with it off, consent reaches it directly.
  test("the first screen of the chain points at the child step where that gate is on", async () => {
    const user = renderChain("/how-to-use-the-tool", ["studentNameGate"]);

    await user.click(screen.getByRole("link", { name: "breadcrumb.child" }));

    expect(landedOn()).toBe("/view-update-add-child");
  });

  test("and at consent where it is off, which is production today", async () => {
    const user = renderChain("/how-to-use-the-tool", []);

    await user.click(screen.getByRole("link", { name: "breadcrumb.consent" }));

    expect(landedOn()).toBe("/consent-form");
  });

  test("no crumb anywhere in the chain leaves the app", async () => {
    // The defect the old Back button had: '/' is the logged-out marketing
    // page and its only door back in is the login form.
    const user = renderChain("/how-to-use-the-tool");
    const hrefs: string[] = [];

    const collect = () =>
      screen.getAllByRole("link").forEach((link) => hrefs.push(link.getAttribute("href") ?? ""));

    collect();
    await user.click(screen.getByTestId("how-to-use-continue"));
    collect();
    await user.click(screen.getByTestId("have-pdf-no"));
    collect();

    expect(hrefs).toEqual(["/consent-form", "/how-to-use-the-tool", "/do-you-have-pdf"]);
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
    "breadcrumb.label",
    "breadcrumb.consent",
    "breadcrumb.child",
    "breadcrumb.howItWorks",
    "breadcrumb.yourIep",
    "breadcrumb.askForPdf",
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
