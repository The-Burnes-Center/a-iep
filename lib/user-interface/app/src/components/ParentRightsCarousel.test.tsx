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
import { describe, expect, test } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import ParentRightsCarousel, { SlideData } from "./ParentRightsCarousel";
import ProcessingModal from "./ProcessingModal";
import { LanguageContext } from "../common/language-context";
import type { SupportedLanguage } from "../common/languages";

import en from "../translations/en.json";
import es from "../translations/es.json";
import zh from "../translations/zh.json";
import vi from "../translations/vi.json";
import ar from "../translations/ar.json";

const INDICATOR_TEMPLATE = "{number}. {title}";

/** The real deck's shape: a divider, the app slides, a divider, the rights. */
const deck: SlideData[] = [
  { id: "section-what-aiep-does", type: "section", title: "What AIEP does", content: "", theme: "green" },
  { id: "privacy-slide-1", type: "privacy", title: "Your IEP won't be changed", content: "A separate document.", image: "/images/carousel/joyful.png" },
  { id: "privacy-slide-2", type: "privacy", title: "We care about your privacy", content: "We remove personal details.", image: "/images/carousel/joyful.png" },
  { id: "section-your-rights", type: "section", title: "Your Rights", content: "", theme: "pink" },
  { id: "rights-slide-1", type: "rights", title: "You can request a translator", content: "Ask for one.", image: "/images/carousel/blissful.png" },
  { id: "rights-slide-2", type: "rights", title: "You can take your time", content: "No rush.", image: "/images/carousel/blissful.png" },
  { id: "rights-slide-3", type: "rights", title: "You can consent or not", content: "All, some or none.", image: "/images/carousel/blissful.png" },
  { id: "section-what-you-will-see-next", type: "section", title: "What you'll see next", content: "", theme: "blue" },
  { id: "tutorial-slide-1", type: "tutorial", title: "Where the summary lives", content: "At the top.", image: "/images/tutorial-01.jpg" },
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

describe("the section dividers", () => {
  test("open each of the deck's three sections, in order", () => {
    renderCarousel();

    const visited = [activeSlideId()];
    for (let i = 1; i < deck.length; i += 1) {
      clickNext();
      visited.push(activeSlideId());
    }

    expect(visited).toEqual([
      "section-what-aiep-does",
      "privacy-slide-1",
      "privacy-slide-2",
      "section-your-rights",
      "rights-slide-1",
      "rights-slide-2",
      "rights-slide-3",
      "section-what-you-will-see-next",
      "tutorial-slide-1",
    ]);
  });

  test("carry their title alone, with no image and no body text", () => {
    // A divider marks a boundary between sections. The illustrations read as
    // content rather than as a break, so it is title-only by design; this pins
    // that so one cannot drift back in.
    renderCarousel();

    const divider = screen.getByTestId("carousel-active-slide");
    expect(divider).toHaveAttribute("data-slide-type", "section");
    expect(within(divider).getByRole("heading", { level: 1 })).toHaveTextContent("What AIEP does");
    expect(divider.querySelector("img")).toBeNull();
  });

  test("wear one colour each, so three dividers are told apart", () => {
    renderCarousel();

    expect(screen.getByTestId("carousel-active-slide")).toHaveClass(
      "parent-rights-card",
      "parent-rights-card--green",
    );
    clickNext(3);
    expect(screen.getByTestId("carousel-active-slide")).toHaveClass("parent-rights-card--pink");
    clickNext(4);
    expect(screen.getByTestId("carousel-active-slide")).toHaveClass("parent-rights-card--blue");
  });

  test("every divider's text block carries the hint, not its repeated title", () => {
    // The block has to hold its full height or the indicator dots move under
    // the parent's thumb, so it shows the hint rather than sitting empty. It
    // must NOT repeat the divider's title, which is already in the card above.
    const { container } = renderCarousel({ sectionHint: "Swipe to learn more" });

    const dividerText = container.querySelectorAll(".slide-rights-content--section");
    expect(dividerText).toHaveLength(3);
    dividerText.forEach((block) => {
      expect(block).toHaveTextContent("Swipe to learn more");
      expect(block.querySelector("h1, h2")).toBeNull();
    });
  });

  test("the hint never names a side, because RTL mirrors the arrows", () => {
    // The app sets document.dir and this carousel flips its own buttons under
    // RTL, so in Arabic "next" sits on the LEFT. Copy naming a side would send
    // Arabic readers the wrong way; the shipped strings say "the arrows".
    const sides = /\b(right|left|derecha|izquierda|phải|trái|右|左|يمين|يسار)\b/;
    for (const [code, dict] of Object.entries({ en, es, zh, vi, ar })) {
      const hint = (dict as Record<string, string>)["carousel.section.hint"];
      expect(hint, `${code} hint must exist`).toBeTruthy();
      expect(hint, `${code} hint must not name a side: ${hint}`).not.toMatch(sides);
    }
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

  test("counts the rights only, not the dividers or the other slides", () => {
    renderCarousel();

    // Three rights in a deck of nine with three dividers in it: the first
    // right is "1.", not "5.".
    expect(screen.getAllByTestId("rights-indicator")).toHaveLength(3);
    expect(screen.getByText("1. You can request a translator")).toBeInTheDocument();
    // And the old "n/6" progress count is gone.
    expect(screen.queryByText(/^\d+\/\d+$/)).not.toBeInTheDocument();
  });

  test("is the only heading on a right, so the title is not said twice", () => {
    const { container } = renderCarousel();

    const rightsSlide = container.querySelectorAll(".carousel-slide")[4];
    expect(
      within(rightsSlide as HTMLElement).getAllByRole("heading", { level: 2 }),
    ).toHaveLength(1);
    expect(rightsSlide).toHaveTextContent("1. You can request a translator");
  });

  test("the app slides, the tutorial slides and the dividers show no number", () => {
    renderCarousel();

    expect(screen.getByText("Your IEP won't be changed")).toBeInTheDocument();
    expect(screen.getByText("Where the summary lives")).toBeInTheDocument();
    expect(screen.queryByText(/^\d+\. Your IEP/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^\d+\. Where the summary/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^\d+\. What AIEP does$/)).not.toBeInTheDocument();
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
    // One of each kind of slide: the privacy pair, the six rights, the
    // tutorial slides. Each is a different key namespace, and each was
    // English before.
    expect(text).toContain(es["privacy.slide2.content"]);
    expect(text).toContain(es["privacy.slide1.content"]);
    expect(text).toContain(es["rights.slide1.content"]);
    expect(text).toContain(es["rights.slide6.content"]);
    expect(text).toContain(es["rights.slide7.content"]);
    expect(text).toContain(es["rights.slide10.content"]);
  });

  test("leaves no English and no raw translation key behind", () => {
    const { container } = inLanguage("vi", bare());

    const text = container.textContent ?? "";
    expect(text).not.toContain(en["rights.slide1.content"]);
    expect(text).not.toContain(en["privacy.slide1.content"]);
    // t() renders the key itself on a miss, so a slide wired to a key that
    // does not exist would print "rights.slide7.content" at the parent.
    expect(text).not.toMatch(/\b(rights|privacy|carousel)\.[a-zA-Z0-9.]+/);
  });

  test("translates the header cards, the numbering and the arrows too", () => {
    inLanguage("es", bare());

    // The green privacy header is what slide 1 wears.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      es["rights.header.title.green"],
    );
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
   * processing one carries the section dividers.
   */
  const callerDeck: SlideData[] = [
    { id: "caller-section", type: "section", title: "Lo que hace AIEP", content: "", theme: "green" },
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
        sectionHint="Pista del interlocutor"
      />,
    );

    // On the divider: its hint, and its green header, not the dictionary's.
    expect(screen.getAllByText("Pista del interlocutor").length).toBeGreaterThan(0);
    expect(screen.queryByText(es["carousel.section.hint"])).toBeNull();
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
        sectionHint={t("carousel.section.hint")}
      />,
    );

    expect(screen.getByTestId("processing-modal")).toBeInTheDocument();
    expect(container.querySelectorAll(".carousel-slide")).toHaveLength(callerDeck.length);
    expect(container.textContent).toContain("Texto del interlocutor.");
    expect(container.textContent).not.toContain(es["rights.slide1.content"]);
  });
});

describe("the strings this change adds", () => {
  const locales = { en, es, zh, vi, ar } as Record<string, Record<string, string>>;
  /** Prose: every locale must say its own thing. */
  const proseKeys = [
    "carousel.section.whatAiepDoes",
    "carousel.section.yourRights",
    "carousel.section.whatYouWillSeeNext",
    // Added for PreferredLanguage.tsx, which hardcodes them in English today.
    "preferredLanguage.update.title",
    "preferredLanguage.update.description",
  ];
  const allKeys = [...proseKeys, "carousel.rights.indicator"];

  test.each(Object.keys(locales))("%s translates all of them", (code) => {
    for (const key of allKeys) {
      expect(locales[code][key], `${code} is missing ${key}`).toBeTruthy();
    }
    // A template missing a placeholder would silently drop the number or the
    // right's title in that language only.
    expect(locales[code]["carousel.rights.indicator"]).toContain("{number}");
    expect(locales[code]["carousel.rights.indicator"]).toContain("{title}");
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
