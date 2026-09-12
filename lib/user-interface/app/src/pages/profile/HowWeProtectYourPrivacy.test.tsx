/**
 * "How we protect your privacy", the screen the privacy button on "How to use
 * the tool" now opens.
 *
 * Nothing here writes anything, so what can break is what a parent is told and
 * what they can reach: the five steps, the two providers, the closing line,
 * where the buttons go, and whether any of it survives the trip into the other
 * four languages. The illustration is markup rather than an image precisely so
 * that it can be asserted, so it is: the sample values are pinned to the
 * strings the design drew, the redacted copy is pinned to placeholders, and
 * every document shape is pinned as hidden from assistive technology.
 *
 * The real component is driven through the DOM with the real router and the
 * real dictionaries -- t() is a lookup in the file on disk, not the identity --
 * because half of what is under test (the emphasised words) only exists once a
 * real string has been through it.
 */
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import HowWeProtectYourPrivacy from "./HowWeProtectYourPrivacy";
import HowToUseTool from "./HowToUseTool";
import { LanguageContext } from "../../common/language-context";
import { ALL_LANGUAGES } from "../../common/languages";
import type { SupportedLanguage } from "../../common/languages";

// Suffixed: Vietnamese's code is `vi`, which is also vitest's own `vi`.
import enDict from "../../translations/en.json";
import esDict from "../../translations/es.json";
import zhDict from "../../translations/zh.json";
import viDict from "../../translations/vi.json";
import arDict from "../../translations/ar.json";

const DICTIONARIES: Record<string, Record<string, string>> = {
  en: enDict, es: esDict, zh: zhDict, vi: viDict, ar: arDict,
};

const ROUTE = "/how-we-protect-your-privacy";

/** Every key this screen renders. */
const KEYS = [
  "privacy.heading",
  "privacy.label.original",
  "privacy.label.copy",
  "privacy.field.ssn",
  "privacy.field.address",
  "privacy.step1",
  "privacy.step2",
  "privacy.step3",
  "privacy.step4",
  "privacy.step5",
  "privacy.closing",
  "privacy.button.upload",
  "privacy.button.resources",
];

const STEP_KEYS = ["privacy.step1", "privacy.step2", "privacy.step3", "privacy.step4", "privacy.step5"];

const Here = () => <div data-testid="landed-on">{useLocation().pathname}</div>;

/** The screen with a real dictionary behind it, plus stubs for its exits. */
const renderScreen = (lang: SupportedLanguage = "en", start: string = ROUTE) => {
  const dictionary = DICTIONARIES[lang];
  render(
    <MemoryRouter initialEntries={[start]}>
      <LanguageContext.Provider
        value={{
          language: lang,
          setLanguage: vi.fn(),
          t: (key: string) => dictionary[key] || key,
          translationsLoaded: true,
          enabledLanguages: ["en", "es"] as SupportedLanguage[],
        }}
      >
        <Here />
        <Routes>
          <Route path={ROUTE} element={<HowWeProtectYourPrivacy />} />
          <Route path="/how-to-use-the-tool" element={<HowToUseTool />} />
          <Route path="/iep-documents" element={<div>upload</div>} />
          <Route path="/view-resources" element={<div>resources</div>} />
        </Routes>
      </LanguageContext.Provider>
    </MemoryRouter>,
  );

  return userEvent.setup();
};

const landedOn = () => screen.getByTestId("landed-on").textContent;

/** The sentence as a reader sees it, with the emphasis markers resolved. */
const plain = (value: string) => value.replace(/\*/g, "");

describe("How we protect your privacy", () => {
  test("shows the heading, both providers, all five steps and the closing line", () => {
    renderScreen();

    expect(
      screen.getByRole("heading", { level: 1, name: "How we protect your privacy" }),
    ).toBeInTheDocument();

    // The providers are named so a parent can look them up. Product names, so
    // they are not in the dictionaries and are the same in all five languages.
    expect(screen.getByRole("heading", { level: 2, name: "AWS COMPREHEND" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "OPEN AI" })).toBeInTheDocument();

    const steps = screen.getAllByRole("listitem");
    expect(steps.map((step) => step.textContent)).toEqual([
      expect.stringContaining(plain(enDict["privacy.step1"])),
      expect.stringContaining(plain(enDict["privacy.step2"])),
      expect.stringContaining(plain(enDict["privacy.step3"])),
      expect.stringContaining(plain(enDict["privacy.step4"])),
      expect.stringContaining(plain(enDict["privacy.step5"])),
    ]);

    expect(document.querySelector(".privacy-closing")).toHaveTextContent(
      plain(enDict["privacy.closing"]),
    );
  });

  test("offers both buttons", () => {
    renderScreen();

    expect(screen.getByTestId("privacy-upload")).toHaveTextContent("Go to document upload");
    expect(screen.getByTestId("privacy-resources")).toHaveTextContent("Get other resources");
  });

  test("numbers the steps as lists, so the count is not carried by the circles alone", () => {
    // The circled digits are aria-hidden decoration. An <ol> is what makes a
    // screen reader announce how many steps there are, and role="list" keeps
    // that true in Safari, where `list-style: none` strips list semantics.
    renderScreen();

    const lists = screen.getAllByRole("list");
    expect(lists.map((list) => list.tagName)).toEqual(["OL", "OL"]);
    // Two lists because an <ol> may only contain <li>, so one cannot span the
    // two provider cards. The second continues the first rather than
    // restarting, which is what the circles show.
    expect(lists[0]).toHaveAttribute("role", "list");
    expect(lists[1]).toHaveAttribute("start", "3");
    expect(within(lists[0]).getAllByRole("listitem")).toHaveLength(2);
    expect(within(lists[1]).getAllByRole("listitem")).toHaveLength(3);
  });

  test("emphasises the words that carry the meaning, as emphasis rather than as a weight", () => {
    renderScreen();

    const emphasised = Array.from(document.querySelectorAll("strong")).map((el) => el.textContent);
    expect(emphasised).toEqual([
      "detect",
      "without",
      "delete",
      "redacted",
      "summary",
      "translate",
      "do not store",
    ]);
  });

  test("shows the sample values exactly as the design drew them", () => {
    // Synthetic and deliberately malformed: a real SSN is nine digits and a
    // real address has a city. If this test ever fails because somebody made
    // them look plausible, the fix is to put them back, not to update the
    // expectation.
    renderScreen();

    expect(screen.getByText("123-4567")).toBeInTheDocument();
    expect(screen.getByText("12 Oak St.")).toBeInTheDocument();
    expect(screen.queryByText(/\d{3}-\d{2}-\d{4}/)).toBeNull();
  });

  test("highlights the two values the redactor is about to take out", () => {
    renderScreen();

    for (const value of ["123-4567", "12 Oak St."]) {
      const shown = screen.getByText(value);
      expect(shown.tagName).toBe("MARK");
      expect(shown).toHaveClass("privacy-doc-value--highlight");
    }
  });

  test("shows the copy of the document with placeholders, not with values", () => {
    // Two copies of each: the "COPY" beside the discarded original in step 2,
    // and the same document going into OpenAI in step 3.
    renderScreen();

    expect(screen.getAllByText("[SSN]")).toHaveLength(2);
    expect(screen.getAllByText("[address]")).toHaveLength(2);
    for (const placeholder of screen.getAllByText(/^\[(SSN|address)\]$/)) {
      expect(placeholder).toHaveClass("privacy-doc-value--redacted");
    }
  });

  test("hides every document shape from assistive technology", () => {
    // A screen reader should get the five sentences and the closing line, not
    // a dozen unlabelled rectangles.
    renderScreen();

    const figures = document.querySelectorAll(".privacy-figure");
    expect(figures.length).toBe(5);
    figures.forEach((figure) => expect(figure).toHaveAttribute("aria-hidden", "true"));

    // Nothing drawn inside them reaches the accessibility tree: the sample
    // data, the placeholders and the illustrative glyphs are all sealed off.
    for (const drawn of ["123-4567", "12 Oak St.", "ABC", "日月金"]) {
      expect(screen.getByText(drawn).closest('[aria-hidden="true"]')).not.toBeNull();
    }

    // So are the circled digits and the arrow between the two providers.
    document
      .querySelectorAll(".onboarding-step-number")
      .forEach((circle) => expect(circle).toHaveAttribute("aria-hidden", "true"));
    expect(document.querySelector(".privacy-arrow")).toHaveAttribute("aria-hidden", "true");
  });

  test("Go to document upload goes to the upload", async () => {
    const user = renderScreen();

    await user.click(screen.getByTestId("privacy-upload"));

    expect(landedOn()).toBe("/iep-documents");
  });

  test("Get other resources goes to the resources page", async () => {
    // Same destination as the identically-labelled button on "How to ask for a
    // PDF IEP"; /view-resources is the only resources screen in AppRoutes.
    const user = renderScreen();

    await user.click(screen.getByTestId("privacy-resources"));

    expect(landedOn()).toBe("/view-resources");
  });

  test("is where the privacy button on 'How to use the tool' now goes", async () => {
    const user = renderScreen("en", "/how-to-use-the-tool");

    await user.click(screen.getByTestId("how-to-use-privacy"));

    expect(landedOn()).toBe(ROUTE);
    expect(
      screen.getByRole("heading", { level: 1, name: "How we protect your privacy" }),
    ).toBeInTheDocument();
  });

  test("reads right to left in Arabic", async () => {
    // The page is built from logical properties, so the only thing the
    // component itself has to get right is that the Arabic copy arrives; the
    // mirroring is the browser's job from there.
    renderScreen("ar");

    expect(
      screen.getByRole("heading", { level: 1, name: arDict["privacy.heading"] }),
    ).toBeInTheDocument();
    const steps = screen.getAllByRole("listitem");
    expect(steps[0].textContent).toContain(plain(arDict["privacy.step1"]));
    // Two emphasised runs in step 2, one of them prefixed by a conjunction
    // that has to stay outside the bold.
    expect(Array.from(document.querySelectorAll("strong")).map((el) => el.textContent)).toHaveLength(7);
  });
});

describe("the copy this screen depends on", () => {
  test("is in all five dictionaries, non-empty", () => {
    expect(Object.keys(DICTIONARIES).sort()).toEqual([...ALL_LANGUAGES].sort());
    const missing = ALL_LANGUAGES.flatMap((lang) =>
      KEYS.filter((key) => !DICTIONARIES[lang][key]).map((key) => `${lang}: ${key}`),
    );
    expect(missing).toEqual([]);
  });

  test("is actually translated, not left in English", () => {
    // "Original" is genuinely the same word in Spanish, so it is exempt by
    // name rather than by weakening the check for everything else.
    const sameInSomeLanguages = new Set(["privacy.label.original"]);
    const untranslated = ALL_LANGUAGES.filter((lang) => lang !== "en").flatMap((lang) =>
      KEYS.filter((key) => !sameInSomeLanguages.has(key))
        .filter((key) => DICTIONARIES[lang][key] === DICTIONARIES.en[key])
        .map((key) => `${lang}: ${key}`),
    );
    expect(untranslated).toEqual([]);
  });

  test("marks its emphasis with paired asterisks in every language", () => {
    // An odd asterisk leaves a literal "*" on the screen and loses the bold,
    // which is where the meaning of each sentence sits.
    const emphasised = [...STEP_KEYS, "privacy.closing"];
    const wrong = ALL_LANGUAGES.flatMap((lang) =>
      emphasised
        .map((key) => ({ key, markers: (DICTIONARIES[lang][key].match(/\*/g) ?? []).length }))
        .filter(({ markers }) => markers === 0 || markers % 2 !== 0)
        .map(({ key, markers }) => `${lang}: ${key} has ${markers} asterisk(s)`),
    );
    expect(wrong).toEqual([]);
  });

  test("keeps the illustrative glyphs and the redaction tokens out of the dictionaries", () => {
    // "ABC DEF GHI" and the CJK characters are a picture of text, and "[SSN]"
    // is what the redactor literally writes into the copy of the document. A
    // dictionary entry for any of them puts a translator to work producing
    // something a parent would be misled by.
    const notCopy = ["ABC", "DEF", "GHI", "日月金", "木水火", "土竹", "[SSN]", "[address]", "AWS COMPREHEND", "OPEN AI"];
    const leaked = ALL_LANGUAGES.flatMap((lang) =>
      Object.entries(DICTIONARIES[lang])
        .filter(([, value]) => notCopy.includes(value))
        .map(([key]) => `${lang}: ${key}`),
    );
    expect(leaked).toEqual([]);
  });

  test("reads the way the design does", () => {
    expect(enDict["privacy.heading"]).toBe("How we protect your privacy");
    expect(enDict["privacy.step1"]).toBe(
      "We use tools that *detect* personal data in the document you uploaded",
    );
    expect(enDict["privacy.step2"]).toBe(
      "We create a new document *without* your personal data and *delete* the document you uploaded",
    );
    expect(enDict["privacy.step3"]).toBe("We input the *redacted* document to the AI system");
    expect(enDict["privacy.step4"]).toBe("We create a *summary* of the document using AI");
    expect(enDict["privacy.step5"]).toBe(
      "We can *translate* the summary using AI, if you need it",
    );
    expect(enDict["privacy.closing"]).toBe(
      "These providers *do not store* or train AI models with your data",
    );
  });
});
