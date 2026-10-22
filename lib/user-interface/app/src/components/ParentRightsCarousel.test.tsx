/**
 * The carousel a parent watches while their IEP is being processed.
 *
 * What matters here is that the deck is a closed loop that never ends itself.
 * It used to call `onLastSlideReached` on the way past the last slide, which
 * the processing screen turned into "tutorial over": the carousel was replaced
 * by a bare spinner and the parent had no way back to it. Worse, the same
 * callback fired on the standalone /rights-of-parents route, where it is
 * `undefined` — reaching the end there threw.
 *
 * Nothing is mocked: this is the real component, driven through the DOM the
 * way a parent drives it.
 */
import React from "react";
import { afterEach, describe, expect, test } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { fireEvent, render, screen, within } from "@testing-library/react";
import ParentRightsCarousel, { CARD_PATTERN_URLS, SlideData } from "./ParentRightsCarousel";
import ProcessingModal from "./ProcessingModal";
import { LanguageContext } from "../common/language-context";
import type { SupportedLanguage } from "../common/languages";

import en from "../translations/en.json";
import es from "../translations/es.json";
import zh from "../translations/zh.json";
import vi from "../translations/vi.json";
import ar from "../translations/ar.json";

const INDICATOR_TEMPLATE = "{number}. {title}";

/** The real deck's shape, shorter: the privacy slides, then the rights. */
const deck: SlideData[] = [
  { id: "privacy-slide-1", type: "privacy", title: "Your IEP won't be changed", content: "A separate document.", image: "/images/carousel/joyful.png" },
  { id: "privacy-slide-2", type: "privacy", title: "We care about your privacy", content: "We remove personal details.", image: "/images/carousel/joyful.png" },
  { id: "rights-slide-1", type: "rights", title: "You can request a translator", content: "Ask for one.", image: "/images/carousel/blissful.png" },
  { id: "rights-slide-2", type: "rights", title: "You can take your time", content: "No rush.", image: "/images/carousel/blissful.png" },
  { id: "rights-slide-3", type: "rights", title: "You can consent or not", content: "All, some or none.", image: "/images/carousel/blissful.png" },
];

const LAST_ID = deck[deck.length - 1].id;

const renderCarousel = (props: Partial<React.ComponentProps<typeof ParentRightsCarousel>> = {}) =>
  render(
    <ParentRightsCarousel
      slides={deck}
      rightsIndicatorTemplate={INDICATOR_TEMPLATE}
      {...props}
    />,
  );

/** Which slide the carousel is on, read off the card it renders for it. */
const activeSlideId = () => screen.getByTestId("carousel-active-slide").getAttribute("data-slide-id");

const clickNext = (times = 1) => {
  for (let i = 0; i < times; i += 1) {
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
  }
};

const clickPrevious = (times = 1) => {
  for (let i = 0; i < times; i += 1) {
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  }
};

const dictionaries = { en, es, zh, vi, ar } as Record<string, Record<string, string>>;

/**
 * The language context as the app supplies it: a real dictionary off disk and
 * the real `translations[key] || key` lookup, so a key that is missing from a
 * locale surfaces here as the raw key rather than as a pass.
 */
const inLanguage = (code: string, children: React.ReactNode) =>
  render(
    <LanguageContext.Provider
      value={{
        language: code as SupportedLanguage,
        setLanguage: () => {},
        t: (key: string) => dictionaries[code][key] || key,
        translationsLoaded: true,
        enabledLanguages: [code as SupportedLanguage],
      }}
    >
      {children}
    </LanguageContext.Provider>,
  );

describe("looping", () => {
  test("the last slide wraps forward to the first", () => {
    renderCarousel();

    clickNext(deck.length - 1);
    expect(activeSlideId()).toBe(LAST_ID);

    clickNext();

    expect(activeSlideId()).toBe(deck[0].id);
  });

  test("the first slide wraps backward to the last", () => {
    renderCarousel();
    expect(activeSlideId()).toBe(deck[0].id);

    clickPrevious();

    expect(activeSlideId()).toBe(LAST_ID);
  });

  test("the Previous button is offered on the first slide, not disabled", () => {
    renderCarousel();

    // It used to be disabled at index 0, which is what made the deck a
    // dead end in one direction.
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
  });

  test("keeps going round for as long as the parent keeps swiping", () => {
    renderCarousel();

    // Two and a bit laps: the deck must still be there, on the slide the
    // arithmetic says, rather than having ended itself somewhere.
    clickNext(deck.length * 2 + 3);

    expect(screen.getByTestId("carousel-active-slide")).toBeInTheDocument();
    expect(activeSlideId()).toBe(deck[3].id);
  });

  test("never unmounts itself, and never navigates, on reaching the end", () => {
    // No props at all: exactly how /rights-of-parents mounts it. Going past
    // the last slide here used to throw, because the completion callback the
    // component called unconditionally is undefined on that route.
    const { container } = render(<ParentRightsCarousel />);
    const firstId = activeSlideId();

    clickNext(40);

    expect(container.querySelector(".parent-rights-container")).toBeInTheDocument();
    expect(screen.getByTestId("carousel-active-slide")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
    // And it came back round to where it started rather than stopping.
    clickPrevious(40);
    expect(activeSlideId()).toBe(firstId);
  });

  test("loop={false} still stops at both ends", () => {
    // The prop is the gate: the default is a closed loop, and a caller that
    // wants the old bounded deck has to ask for it.
    renderCarousel({ loop: false });

    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    clickNext(deck.length + 5);

    expect(activeSlideId()).toBe(LAST_ID);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });
});

describe("the section labels", () => {
  const eyebrows = () =>
    Array.from(document.querySelectorAll(".slide-eyebrow")).map((node) => node.textContent);

  test("every slide says which section it is in and where in it, in order", () => {
    renderCarousel();

    expect(eyebrows()).toEqual([
      "What AIEP does · 1 of 2",
      "What AIEP does · 2 of 2",
      "Your Rights · 1 of 3",
      "Your Rights · 2 of 3",
      "Your Rights · 3 of 3",
    ]);
  });

  test("the deck has no divider slides: one slide per privacy or rights entry", () => {
    const { container } = renderCarousel();

    expect(container.querySelectorAll(".carousel-slide")).toHaveLength(deck.length);
    const visited = [activeSlideId()];
    for (let i = 1; i < deck.length; i += 1) {
      clickNext();
      visited.push(activeSlideId());
    }
    expect(visited).toEqual(deck.map((slide) => slide.id));
  });

  test("the label sits above the slide's own title, and does not repeat it", () => {
    const { container } = renderCarousel();

    const slide = container.querySelectorAll(".carousel-slide")[2] as HTMLElement;
    const label = slide.querySelector(".slide-eyebrow") as HTMLElement;
    const title = within(slide).getByRole("heading", { level: 2 });

    expect(label.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(label.textContent).not.toContain(title.textContent);
    expect(title.textContent).not.toContain("Your Rights");
  });

  test("the card wears the slide's kind: green for privacy, pink for rights", () => {
    renderCarousel();

    expect(screen.getByTestId("carousel-active-slide")).toHaveClass("parent-rights-card--green");
    clickNext(2);
    expect(screen.getByTestId("carousel-active-slide")).toHaveClass("parent-rights-card--pink");
  });

  test("takes its words and its punctuation from the locale's template", () => {
    inLanguage("zh", <ParentRightsCarousel slides={deck} />);

    const labels = eyebrows();
    expect(labels[0]).toBe(
      zh["carousel.section.position"]
        .replace("{section}", zh["carousel.section.whatAiepDoes"])
        .replace("{number}", "1")
        .replace("{total}", "2"),
    );
    expect(labels[2]).toContain(zh["carousel.section.yourRights"]);
    // Not the English template with the Chinese section name poured into it.
    expect(labels[2]).not.toContain(" of ");
  });

  test("reads right to left in Arabic, with the locale's own word for 'of'", () => {
    render(
      <LanguageContext.Provider
        value={{
          language: "ar" as SupportedLanguage,
          setLanguage: () => {},
          t: (key: string) => dictionaries.ar[key] || key,
          translationsLoaded: true,
          enabledLanguages: ["ar"] as SupportedLanguage[],
        }}
      >
        <div dir="rtl">
          <ParentRightsCarousel slides={deck} />
        </div>
      </LanguageContext.Provider>,
    );

    const first = document.querySelector(".slide-eyebrow") as HTMLElement;
    expect(first).toHaveTextContent(ar["carousel.section.whatAiepDoes"]);
    expect(first.textContent).toContain(" من ");
    expect(first.closest('[dir="rtl"]')).not.toBeNull();
  });
});

describe("the heading outline", () => {
  test("a slide never renders an h1: the screen's one h1 is the status headline", () => {
    const { container } = renderCarousel();

    for (let i = 0; i < deck.length; i += 1) {
      expect(container.querySelectorAll("h1")).toHaveLength(0);
      clickNext();
    }
  });

  test("the card's illustration is decoration, so a title is not read twice", () => {
    renderCarousel();

    const card = screen.getByTestId("carousel-active-slide");
    expect(card.querySelector("img")).toHaveAttribute("alt", "");
  });
});

describe("the rights indicator", () => {
  test("names the right by number and title", () => {
    renderCarousel();

    const indicators = screen.getAllByTestId("rights-indicator");

    expect(indicators.map((node) => node.textContent)).toEqual([
      "1. You can request a translator",
      "2. You can take your time",
      "3. You can consent or not",
    ]);
  });

  test("counts the rights only, not the privacy slides", () => {
    renderCarousel();

    // Three rights in a deck of five with two privacy slides in it: the first
    // right is "1.", not "3.".
    expect(screen.getAllByTestId("rights-indicator")).toHaveLength(3);
    expect(screen.getByText("1. You can request a translator")).toBeInTheDocument();
    // And the old "n/6" progress count is gone.
    expect(screen.queryByText(/^\d+\/\d+$/)).not.toBeInTheDocument();
  });

  test("is the only heading on a right, so the title is not said twice", () => {
    const { container } = renderCarousel();

    const rightsSlide = container.querySelectorAll(".carousel-slide")[2];
    expect(
      within(rightsSlide as HTMLElement).getAllByRole("heading", { level: 2 }),
    ).toHaveLength(1);
    expect(rightsSlide).toHaveTextContent("1. You can request a translator");
  });

  test("the privacy slides show no number", () => {
    renderCarousel();

    expect(screen.getByText("Your IEP won't be changed")).toBeInTheDocument();
    expect(screen.queryByText(/^\d+\. Your IEP/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^\d+\. We care/)).not.toBeInTheDocument();
  });

  test("follows the locale's own template, right-to-left included", () => {
    const arabicRights: SlideData[] = [
      { id: "rights-slide-1", type: "rights", title: "يمكنك طلب مترجم", content: "اطلب مترجمًا.", image: "/images/carousel/blissful.png" },
      { id: "rights-slide-2", type: "rights", title: "يمكنك أخذ وقتك", content: "لا تستعجل.", image: "/images/carousel/blissful.png" },
    ];

    render(
      <div dir="rtl">
        <ParentRightsCarousel
          slides={arabicRights}
          rightsIndicatorTemplate={ar["carousel.rights.indicator"]}
        />
      </div>,
    );

    const indicators = screen.getAllByTestId("rights-indicator");
    // The whole label is one text node under dir="rtl", so the browser's bidi
    // algorithm places the numeral at the start of the line (the right).
    // Nothing here hardcodes a direction or a separator: both come from ar.json.
    expect(indicators[0]).toHaveTextContent("1. يمكنك طلب مترجم");
    expect(indicators[1]).toHaveTextContent("2. يمكنك أخذ وقتك");
    expect(indicators[0].closest('[dir="rtl"]')).not.toBeNull();
  });
});

describe("the standalone /rights-of-parents route", () => {
  /**
   * AppRoutes mounts `<ParentRightsCarousel />` bare, so the twelve slides used
   * to be the hardcoded English ones no matter what language the parent had
   * chosen. The component reads the dictionary itself now; these pin that it
   * reads ALL of it, not just the parts that were easy.
   */
  const bare = () => <ParentRightsCarousel />;

  test("shows the whole deck in the parent's language", () => {
    const { container } = inLanguage("es", bare());

    const text = container.textContent ?? "";
    // One of each kind of slide: the privacy pair and the six rights. Each is
    // a different key namespace, and each was English before.
    expect(text).toContain(es["privacy.slide2.content"]);
    expect(text).toContain(es["privacy.slide1.content"]);
    expect(text).toContain(es["rights.slide1.content"]);
    expect(text).toContain(es["rights.slide6.content"]);
  });

  test("is the same eight slides as the processing screen: no tutorial slides", () => {
    // The tutorial slides (rights.slide7..10) moved to the guided tour.
    const { container } = inLanguage("es", bare());

    expect(container.querySelectorAll(".carousel-slide")).toHaveLength(8);
    expect(container.textContent).not.toContain(es["rights.slide7.content"]);
    expect(container.textContent).not.toContain(es["rights.slide10.content"]);
    expect(screen.getByTestId("carousel-counter")).toHaveTextContent("1 / 8");
  });

  test("leaves no English and no raw translation key behind", () => {
    const { container } = inLanguage("vi", bare());

    const text = container.textContent ?? "";
    expect(text).not.toContain(en["rights.slide1.content"]);
    expect(text).not.toContain(en["privacy.slide1.content"]);
    // t() renders the key itself on a miss, so a slide wired to a key that
    // does not exist would print "rights.slide7.content" at the parent.
    expect(text).not.toMatch(/\b(rights|privacy|carousel)\.[a-zA-Z0-9.]+/);
    // The chrome this change added is translated too: no English counter label.
    expect(text).not.toContain("Slide 1 of 8");
    expect(text).not.toContain(" of 6");
  });

  test("translates the header cards, the numbering and the arrows too", () => {
    inLanguage("es", bare());

    // The green privacy header is what slide 1 wears.
    expect(screen.getByText(es["rights.header.title.green"])).toBeInTheDocument();
    expect(screen.getByRole("button", { name: es["common.previous"] })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: es["common.next"] })).toBeInTheDocument();
    expect(screen.getAllByTestId("rights-indicator")[0]).toHaveTextContent(
      es["carousel.rights.indicator"]
        .replace("{number}", "1")
        .replace("{title}", es["rights.slide1.title"]),
    );
  });

  test("numbers the rights 1 to 6, and nothing else", () => {
    inLanguage("ar", bare());

    const indicators = screen.getAllByTestId("rights-indicator");
    expect(indicators).toHaveLength(6);
    expect(indicators[0]).toHaveTextContent(ar["rights.slide1.title"]);
    expect(indicators[5]).toHaveTextContent(ar["rights.slide6.title"]);
  });

  test("still shows English rather than raw keys when no dictionary is loaded", () => {
    // The documented fallback: this is the only reason the English literals
    // are still in the file, and a t() call with no guard would have replaced
    // them with "rights.slide1.title" on screen.
    const { container } = render(<ParentRightsCarousel />);

    const text = container.textContent ?? "";
    expect(text).toContain("You can request a translator");
    expect(text).not.toMatch(/\b(rights|privacy|carousel)\.[a-zA-Z0-9.]+/);
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
  });

  test("falls back per string, so one missing key does not print itself", () => {
    // t() answers a miss with the key, so a locale that never got
    // `rights.slide1.content` would show a parent the dot-separated key in the
    // middle of an otherwise Spanish deck. English is the worse-but-readable
    // answer; the raw key is not an answer at all.
    const holey = { ...es };
    delete holey["rights.slide1.content"];
    delete holey["common.next"];

    render(
      <LanguageContext.Provider
        value={{
          language: "es" as SupportedLanguage,
          setLanguage: () => {},
          t: (key: string) => holey[key] || key,
          translationsLoaded: true,
          enabledLanguages: ["es"] as SupportedLanguage[],
        }}
      >
        <ParentRightsCarousel />
      </LanguageContext.Provider>,
    );

    expect(screen.getByText(en["rights.slide1.content"])).toBeInTheDocument();
    expect(screen.queryByText("rights.slide1.content")).toBeNull();
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
    // Everything the dictionary DOES have is still Spanish.
    expect(screen.getByText(es["rights.slide2.content"])).toBeInTheDocument();
  });
});

describe("the processing screen's own slides", () => {
  /**
   * ProcessingModal is rendered by a page that already owns a translator and
   * hands over a finished deck. Now that the carousel has a deck of its own,
   * the caller's has to keep winning: the two are not the same length and the
   * processing one is eight slides.
   */
  const callerDeck: SlideData[] = [
    { id: "caller-privacy", type: "privacy", title: "Privacidad del interlocutor", content: "Privacidad.", image: "/images/carousel/joyful.png" },
    { id: "caller-right", type: "rights", title: "Derecho del interlocutor", content: "Texto del interlocutor.", image: "/images/carousel/blissful.png" },
  ];

  test("an explicit deck replaces the component's own, it does not merge with it", () => {
    const { container } = inLanguage(
      "es",
      <ParentRightsCarousel slides={callerDeck} rightsIndicatorTemplate="[{number}] {title}" />,
    );

    expect(container.querySelectorAll(".carousel-slide")).toHaveLength(callerDeck.length);
    expect(container.textContent).toContain("Texto del interlocutor.");
    // Nothing from the carousel's own deck leaked in alongside it.
    expect(container.textContent).not.toContain(es["rights.slide1.content"]);
  });

  test("every explicit string wins over the dictionary's", () => {
    inLanguage(
      "es",
      <ParentRightsCarousel
        slides={callerDeck}
        headerPinkTitle="Encabezado del interlocutor"
        headerGreenTitle="Encabezado verde del interlocutor"
        rightsIndicatorTemplate="[{number}] {title}"
      />,
    );

    // On the first slide: the caller's green header, not the dictionary's.
    expect(screen.getByText("Encabezado verde del interlocutor")).toBeInTheDocument();
    expect(screen.queryByText(es["rights.header.title.green"])).toBeNull();
    expect(screen.getByTestId("rights-indicator")).toHaveTextContent(
      "[1] Derecho del interlocutor",
    );
  });

  test("through the real ProcessingModal, the page's deck is what a parent reads", () => {
    // The actual caller, wired the way the summary page wires it.
    const t = (key: string) => dictionaries.es[key] || key;

    const { container } = inLanguage(
      "es",
      <ProcessingModal
        error={null}
        tutorialPhase="parent-rights"
        t={t}
        parentRightsSlideData={callerDeck}
        headerPinkTitle={t("rights.header.title.pink")}
        headerGreenTitle={t("rights.header.title.green")}
        rightsIndicatorTemplate={t("carousel.rights.indicator")}
        progressDocument={{ status: "PROCESSING", progress: 22, current_step: "cleanup_complete" }}
        progressStepLabel={t("summary.processing.step.summarizing")}
        pollingStopped={false}
        onCheckAgain={() => undefined}
      />,
    );

    expect(screen.getByTestId("processing-modal")).toBeInTheDocument();
    expect(container.querySelectorAll(".carousel-slide")).toHaveLength(callerDeck.length);
    expect(container.textContent).toContain("Texto del interlocutor.");
    expect(container.textContent).not.toContain(es["rights.slide1.content"]);
  });
});

/**
 * The counter between the arrows.
 *
 * It replaced fifteen dots: on a phone they were 16px targets nobody needed,
 * and they carried no information a number does not. The arrows are the
 * control; this only says where you are, in the parent's language.
 */
describe("the counter", () => {
  const counter = () => screen.getByTestId("carousel-counter");

  test("reads 'n / total' between the arrows, and follows the slide", () => {
    renderCarousel();

    expect(counter()).toHaveTextContent("1 / 5");
    clickNext(3);
    expect(counter()).toHaveTextContent("4 / 5");
    clickNext(2);
    // Wrapped round the back, as the loop does.
    expect(counter()).toHaveTextContent("1 / 5");
  });

  test("sits between the previous and next arrows", () => {
    const { container } = renderCarousel();

    const row = container.querySelector(".parent-rights-carousel-buttons") as HTMLElement;
    const children = Array.from(row.children);
    expect(children[0]).toHaveClass("carousel-prev-button");
    expect(children[1]).toContainElement(counter());
    expect(children[2]).toHaveClass("carousel-next-button");
  });

  test("is not a control: no dots, nothing to tab to but the two arrows", () => {
    const { container } = renderCarousel();

    expect(container.querySelector(".parent-rights-dot")).toBeNull();
    expect(screen.queryByTestId("carousel-dots")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  test("a screen reader gets a sentence, not '1 / 5'", () => {
    const { container } = renderCarousel();

    // The glyphs are hidden from assistive technology...
    expect(counter()).toHaveAttribute("aria-hidden", "true");
    // ...and the sentence beside them is what it reads.
    const spoken = container.querySelector(".parent-rights-counter .visually-hidden") as HTMLElement;
    expect(spoken).toHaveTextContent("Slide 1 of 5");
    clickNext();
    expect(spoken).toHaveTextContent("Slide 2 of 5");
  });

  test("keeps its numerals in reading order under right-to-left", () => {
    renderCarousel();

    expect(counter()).toHaveAttribute("dir", "ltr");
  });

  test("is in the parent's language, from the dictionary", () => {
    inLanguage("es", <ParentRightsCarousel slides={deck} />);

    expect(screen.getByText("Diapositiva 1 de 5", { selector: ".visually-hidden" })).toBeInTheDocument();
    expect(counter()).toHaveTextContent("1 / 5");
  });
});

describe("the carousel as a region", () => {
  test("is a named carousel landmark", () => {
    const { container } = renderCarousel();

    const region = container.querySelector(".parent-rights-container") as HTMLElement;
    expect(region).toHaveAttribute("role", "region");
    expect(region).toHaveAttribute("aria-roledescription", "carousel");
    expect(region).toHaveAttribute("aria-label", "While you wait: your data and your rights");
    expect(screen.getByRole("region", { name: /while you wait/i })).toBe(region);
  });

  test("each slide is a numbered group", () => {
    const { container } = renderCarousel();

    const groups = Array.from(container.querySelectorAll('[aria-roledescription="slide"]'));
    expect(groups).toHaveLength(deck.length);
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
      "Slide 1 of 5", "Slide 2 of 5", "Slide 3 of 5", "Slide 4 of 5", "Slide 5 of 5",
    ]);
  });

  test("announces the current slide politely, without moving focus", () => {
    const { container } = renderCarousel();
    const region = container.querySelector('[aria-live="polite"]') as HTMLElement;

    expect(region).toHaveAttribute("aria-atomic", "true");
    expect(region).toHaveTextContent("Slide 1 of 5: Your IEP won't be changed");

    const next = screen.getByRole("button", { name: "Next" });
    next.focus();
    fireEvent.click(next);

    expect(region).toHaveTextContent("Slide 2 of 5: We care about your privacy");
    // The parent is still on the arrow they pressed.
    expect(document.activeElement).toBe(next);
  });

  test("there is exactly one live region, so a change is spoken once", () => {
    const { container } = renderCarousel();

    expect(container.querySelectorAll("[aria-live]")).toHaveLength(1);
  });
});

describe("the strings this change adds", () => {
  const locales = { en, es, zh, vi, ar } as Record<string, Record<string, string>>;
  /** Prose: every locale must say its own thing. */
  const proseKeys = [
    "carousel.section.whatAiepDoes",
    "carousel.section.yourRights",
    "carousel.section.whatYouWillSeeNext",
    "carousel.counter.label",
    "carousel.announce",
    "carousel.label",
    "summary.processing.stepOf",
    "summary.processing.stepValueText",
    "summary.processing.expectation",
    // Added for PreferredLanguage.tsx, which hardcodes them in English today.
    "preferredLanguage.update.title",
    "preferredLanguage.update.description",
  ];
  const allKeys = [
    ...proseKeys,
    "carousel.rights.indicator",
    "carousel.goToSlide",
    "carousel.section.position",
    "carousel.counter",
  ];

  test.each(Object.keys(locales))("%s translates all of them", (code) => {
    for (const key of allKeys) {
      expect(locales[code][key], `${code} is missing ${key}`).toBeTruthy();
    }
    // A template missing a placeholder would silently drop the number or the
    // right's title in that language only.
    expect(locales[code]["carousel.rights.indicator"]).toContain("{number}");
    expect(locales[code]["carousel.rights.indicator"]).toContain("{title}");
    // Same trap for the counter and the eyebrow: a locale that dropped a
    // placeholder would show every slide the same number, in that language only.
    expect(locales[code]["carousel.goToSlide"]).toContain("{number}");
    for (const key of [
      "carousel.section.position", "carousel.counter", "carousel.counter.label",
      "summary.processing.stepOf",
    ]) {
      expect(locales[code][key], `${code} ${key}`).toContain("{number}");
      expect(locales[code][key], `${code} ${key}`).toContain("{total}");
    }
    expect(locales[code]["carousel.section.position"]).toContain("{section}");
    expect(locales[code]["carousel.announce"]).toContain("{title}");
    expect(locales[code]["summary.processing.stepValueText"]).toContain("{step}");
  });

  test.each(["es", "zh", "vi", "ar"])("%s does not fall back to the English wording", (code) => {
    // The indicator template is punctuation only and is legitimately shared;
    // everything else here is prose and must actually be translated.
    for (const key of proseKeys) {
      expect(locales[code][key], `${code} left ${key} in English`).not.toBe(locales.en[key]);
    }
  });

  test("every locale carries exactly the same keys", () => {
    const english = Object.keys(locales.en).sort();
    for (const code of Object.keys(locales)) {
      expect(Object.keys(locales[code]).sort(), `${code} has drifted from en`).toEqual(english);
    }
  });
});

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "ParentRightsCarousel.css"),
  "utf8",
);

/** The body of the first top-level `selector { ... }` rule, outside any @media. */
function rule(selector: string): string {
  const topLevel = CSS.slice(0, CSS.indexOf("@media"));
  const start = topLevel.search(new RegExp(`(^|\\n)${selector.replace(/[.-]/g, (c) => `\\${c}`)}\\s*\\{`));
  expect(start, `ParentRightsCarousel.css has no top-level ${selector} rule`).toBeGreaterThan(-1);
  const open = topLevel.indexOf("{", start);
  return topLevel.slice(open + 1, topLevel.indexOf("}", open));
}

describe("the stylesheet", () => {
  // jsdom lays nothing out and applies no media queries, so these pin the
  // rules themselves.
  test("the eyebrow is the green that clears 4.5:1 on the deck, and is never spaced or upper-cased", () => {
    const body = rule(".slide-rights-content .slide-eyebrow");
    expect(body).toMatch(/color:\s*var\(--aiep-green\)/);
    // Both break joined Arabic script and mean nothing in Chinese.
    expect(body).not.toMatch(/letter-spacing|text-transform/);
  });

  test("slides stay start-aligned, so Arabic reads from the right", () => {
    expect(rule(".slide-rights-content")).toMatch(/text-align:\s*start/);
  });

  test("the arrows are 44px targets", () => {
    const body = rule(".carousel-nav-button");
    expect(body).toMatch(/min-width:\s*44px/);
    expect(body).toMatch(/min-height:\s*44px/);
  });

  test("the slide transition is switched off for a parent who asked for less motion", () => {
    const block = CSS.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/);
    expect(block, "no prefers-reduced-motion block").not.toBeNull();
    const body = block?.[1] ?? "";
    expect(body).toContain(".parent-rights-carousel .carousel-item");
    expect(body).toMatch(/transition:\s*none/);
    // And the motion it switches off really is there to switch off.
    expect(CSS).toMatch(/\.parent-rights-carousel \.carousel-item\s*\{\s*transition:\s*transform/);
  });
});

describe("the header card patterns", () => {
  const realImage = globalThis.Image;
  afterEach(() => {
    globalThis.Image = realImage;
  });

  // A CSS background is only fetched when an element using it renders, and
  // until it arrived the card showed the scrim over nothing: a grey frame
  // before each divider's colour.
  test.each(["green", "pink"])("the %s card has a solid colour under its pattern", (theme) => {
    expect(rule(`.parent-rights-card--${theme}`)).toMatch(/background-color:\s*var\(--aiep-pattern-[a-z]+-base\)/);
  });

  test("every pattern the stylesheet uses is preloaded, so the list cannot drift", () => {
    const used = [...CSS.matchAll(/url\(['"]?(\/images\/patterns-[^'")]+)['"]?\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    expect([...new Set(used)].sort()).toEqual([...CARD_PATTERN_URLS].sort());
  });

  test("both are requested as soon as the carousel mounts, before the first right shows", () => {
    const requested: string[] = [];
    globalThis.Image = class {
      set src(value: string) {
        requested.push(value);
      }
    } as unknown as typeof Image;
    renderCarousel();
    expect(requested.sort()).toEqual([...CARD_PATTERN_URLS].sort());
  });
});
