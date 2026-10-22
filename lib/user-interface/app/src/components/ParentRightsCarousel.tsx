import React, { useEffect, useMemo, useState } from 'react';
import { Carousel } from 'react-bootstrap';
import { useLanguage } from '../common/language-context';
import './ParentRightsCarousel.css';

/**
 * A slide of the deck this component owns. `title`/`content` are the English
 * the parent sees only before a dictionary is in memory; the keys beside them
 * are what actually gets read once one is.
 */
interface DefaultSlide extends SlideData {
  titleKey: string;
  contentKey: string;
}

/**
 * The deck the standalone /rights-of-parents route shows, since it mounts this
 * component with no slides of its own.
 *
 * The keys are the same ones the processing screen builds its deck from, so a
 * parent reads the same words in the same language on both screens. The two
 * privacy slides run in the opposite order to the dictionary's numbering: this
 * route opens on "your data is safe", which is `privacy.slide2`.
 */
const DEFAULT_DECK: DefaultSlide[] = [
      {
        id: 'slide-1',
        type: 'privacy',
        titleKey: 'privacy.slide2.title',
        contentKey: 'privacy.slide2.content',
        title: 'Your data is safe',
        content: "We're removing your personal information from the summaries. We will not store any of your or your child's personal details.",
        image: '/images/carousel/surprised.png'
      },
      {
        id: 'slide-2',
        type: 'privacy',
        titleKey: 'privacy.slide1.title',
        contentKey: 'privacy.slide1.content',
        title: "Your IEP won't be changed",
        content: "We're creating a separate document with your summary. You can download it by clicking on the button.",
        image: '/images/carousel/blissful.png'
      },
      {
        id: 'slide-3',
        type: 'rights',
        titleKey: 'rights.slide1.title',
        contentKey: 'rights.slide1.content',
        title: 'You can request a translator',
        content: 'You can request a translator for IEP meetings to ensure clear communication.',
        image: '/images/carousel/joyful.png'
      },
      {
        id: 'slide-4',
        type: 'rights',
        titleKey: 'rights.slide2.title',
        contentKey: 'rights.slide2.content',
        title: 'You can take your time',
        content: "You have the right to take your time before signing an IEP - you don't need to sign until you're ready.",
        image: '/images/carousel/surprised.png'
      },
      {
        id: 'slide-5',
        type: 'rights',
        titleKey: 'rights.slide3.title',
        contentKey: 'rights.slide3.content',
        title: 'You can consent or not',
        content: "You can consent to all, some, or none of the proposed services - your child won't receive new services without your approval.",
        image: '/images/carousel/blissful.png'
      },
      {
        id: 'slide-6',
        type: 'rights',
        titleKey: 'rights.slide4.title',
        contentKey: 'rights.slide4.content',
        title: 'You can request a meeting',
        content: 'You have the right to request an IEP meeting at any time, not just at the annual review, and the school must schedule it within 30 days.',
        image: '/images/carousel/joyful.png'
      },
      {
        id: 'slide-7',
        type: 'rights',
        titleKey: 'rights.slide5.title',
        contentKey: 'rights.slide5.content',
        title: 'You can reschedule',
        content: "If an administrator isn't present at the meeting, you have the right to reschedule for a time when they can attend.",
        image: '/images/carousel/surprised.png'
      },
      {
        id: 'slide-8',
        type: 'rights',
        titleKey: 'rights.slide6.title',
        contentKey: 'rights.slide6.content',
        title: 'You must be given a booklet of your rights',
        content: 'By law, your case manager must provide you with a booklet of your parental rights before the IEP meeting.',
        image: '/images/carousel/blissful.png'
      },
    ];

/**
 * The dictionary's wording for `key`, or `fallback` when it has none.
 *
 * t() is `translations[key] || key`, so a miss comes back as the key itself
 * and a raw "rights.slide1.title" on screen is worse for a parent than
 * English. That covers all three ways there can be no wording: no provider at
 * all, a dictionary still downloading, and a key one locale never got.
 */
const withFallback = (t: (key: string) => string, key: string, fallback: string): string => {
  const value = t(key);
  return !value || value === key ? fallback : value;
};

/** The same deck in the parent's language. Drops the keys; keeps everything else. */
const localizeDeck = (t: (key: string) => string): SlideData[] =>
  DEFAULT_DECK.map(({ titleKey, contentKey, ...slide }) => ({
    ...slide,
    title: withFallback(t, titleKey, slide.title),
    content: withFallback(t, contentKey, slide.content),
  }));

/**
 * A slide's kind decides which card it wears above the text, and which section
 * its eyebrow label names:
 * - `privacy`  green pattern card, in the "What AIEP does" section
 * - `rights`   pink pattern card, in the "Your Rights" section
 *
 * The deck used to carry divider slides between sections and the screenshot
 * tutorial slides after them. The dividers are labels now and the tutorial
 * belongs to the guided tour on the finished summary.
 */
export type SlideType = 'privacy' | 'rights';

export interface SlideData {
  id: string;
  type: SlideType;
  title: string;
  content: string;
  image: string;
}

/**
 * Every string below is a fallback, not a default: a caller's prop wins, and
 * failing that the dictionary does. They are the English shown only while no
 * dictionary is in memory, which is why they must never be raw keys.
 *
 * The indicator is a template rather than string concatenation so each locale
 * owns its own separator and word order; ProcessingModal passes the translated
 * one, the standalone /rights-of-parents route reads it from the dictionary.
 */
const DEFAULT_RIGHTS_INDICATOR_TEMPLATE = '{number}. {title}';

/**
 * The card patterns ParentRightsCarousel.css paints the header cards with.
 * The browser only fetches a CSS background when an element using it renders,
 * so the pink one used to start its 1 MB download the moment a parent reached
 * the first right. Fetched on mount instead, they are cached by then.
 */
export const CARD_PATTERN_URLS = [
  '/images/patterns-dark-green.jpg',
  '/images/patterns-pink.jpg',
] as const;

const DEFAULT_HEADER_PINK_TITLE = 'Your rights as a parent';

const DEFAULT_HEADER_GREEN_TITLE = 'Your data is safe with us';

const DEFAULT_PREVIOUS_LABEL = 'Previous';

const DEFAULT_NEXT_LABEL = 'Next';

/**
 * Templates for the same reason the rights indicator is one: word order, and
 * the separators each language uses. They are read from the dictionary by the
 * carousel itself; these are the English shown only before one is in memory.
 */
const DEFAULT_SECTION_POSITION_TEMPLATE = '{section} · {number} of {total}';

const DEFAULT_COUNTER_TEMPLATE = '{number} / {total}';

const DEFAULT_COUNTER_LABEL_TEMPLATE = 'Slide {number} of {total}';

const DEFAULT_ANNOUNCE_TEMPLATE = 'Slide {number} of {total}: {title}';

const DEFAULT_CAROUSEL_LABEL = 'While you wait: your data and your rights';

const DEFAULT_SECTION_LABELS: Record<SlideType, string> = {
  privacy: 'What AIEP does',
  rights: 'Your Rights',
};

/** The dictionary key of the name each kind of slide's section goes by. */
const SECTION_LABEL_KEYS: Record<SlideType, string> = {
  privacy: 'carousel.section.whatAiepDoes',
  rights: 'carousel.section.yourRights',
};

/** Fills `{name}` placeholders. Each locale's template owns word order. */
const fillTemplate = (template: string, values: Record<string, string | number>): string =>
  Object.entries(values).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    template,
  );

/**
 * Every text prop here is optional and every one of them wins when given. A
 * caller that already owns a translator (the processing screen) hands over its
 * own strings; a caller that does not (the standalone /rights-of-parents
 * route) omits them and the carousel reads the same keys itself.
 */
export interface ParentRightsCarouselProps {
  /** Omit to get this component's own deck, in the parent's language. */
  slides?: SlideData[];
  className?: string;
  headerPinkTitle?: string;
  headerGreenTitle?: string;
  /**
   * Wrap past both ends instead of stopping there. On by default because the
   * carousel's only job is to keep a waiting parent company: the deck has to
   * outlast the document, and a parent who swipes to the end must be able to
   * get back rather than be dropped somewhere else.
   *
   * Nothing about finishing the deck ends anything. Whatever renders this
   * decides when to stop showing it (the processing screen does that from the
   * document's status), so the standalone rights page can never inherit a
   * navigation it has no document for.
   */
  loop?: boolean;
  rightsIndicatorTemplate?: string;
}

const ParentRightsCarousel: React.FC<ParentRightsCarouselProps> = ({
  slides: slidesProp,
  className = '',
  headerPinkTitle,
  headerGreenTitle,
  loop = true,
  rightsIndicatorTemplate,
}) => {

  const { t } = useLanguage();
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    for (const url of CARD_PATTERN_URLS) {
      const image = new Image();
      image.src = url;
    }
  }, []);

  // The standalone /rights-of-parents route passes nothing, so the component
  // has to translate its own deck. ProcessingModal passes one already
  // translated by the page that owns t(), and that always wins.
  const localizedDeck = useMemo(() => localizeDeck(t), [t]);

  const translated = (key: string, fallback: string) => withFallback(t, key, fallback);

  const slides = slidesProp ?? localizedDeck;
  const displayHeaderPinkTitle = headerPinkTitle ?? translated('rights.header.title.pink', DEFAULT_HEADER_PINK_TITLE);
  const displayHeaderGreenTitle = headerGreenTitle ?? translated('rights.header.title.green', DEFAULT_HEADER_GREEN_TITLE);
  const displayRightsIndicatorTemplate = rightsIndicatorTemplate ?? translated('carousel.rights.indicator', DEFAULT_RIGHTS_INDICATOR_TEMPLATE);
  const sectionPositionTemplate = translated('carousel.section.position', DEFAULT_SECTION_POSITION_TEMPLATE);
  const counterTemplate = translated('carousel.counter', DEFAULT_COUNTER_TEMPLATE);
  const counterLabelTemplate = translated('carousel.counter.label', DEFAULT_COUNTER_LABEL_TEMPLATE);
  const announceTemplate = translated('carousel.announce', DEFAULT_ANNOUNCE_TEMPLATE);
  const carouselLabel = translated('carousel.label', DEFAULT_CAROUSEL_LABEL);

  const slideCount = slides.length;

  // Nothing to show rather than crashing on slides[activeIndex]. The summary
  // page hands over an empty deck until its translations load.
  if (slideCount === 0) return null;

  const clampIndex = (index: number) =>
    loop
      ? ((index % slideCount) + slideCount) % slideCount
      : Math.min(Math.max(index, 0), slideCount - 1);

  // Also re-clamps a stale activeIndex if the deck shrank under us.
  const currentIndex = clampIndex(activeIndex);
  const currentSlide = slides[currentIndex];

  const goToSlide = (index: number) => setActiveIndex(clampIndex(index));

  // The rights are numbered among THEMSELVES: the privacy slides are not
  // rights and are not counted, so "3." always means the third right no matter
  // what else the deck carries.
  const rightsIds = slides.filter(slide => slide.type === 'rights').map(slide => slide.id);

  const rightsIndicator = (slide: SlideData): string | null => {
    if (slide.type !== 'rights') return null;
    return displayRightsIndicatorTemplate
      .replace('{number}', String(rightsIds.indexOf(slide.id) + 1))
      .replace('{title}', slide.title);
  };

  // "Your Rights · 3 of 6": the section this slide is in and where in it. The
  // slide's own title sits under it, so the label never repeats the title.
  const sectionEyebrow = (slide: SlideData): string => {
    const siblings = slides.filter(other => other.type === slide.type);
    return fillTemplate(sectionPositionTemplate, {
      section: translated(SECTION_LABEL_KEYS[slide.type], DEFAULT_SECTION_LABELS[slide.type]),
      number: siblings.findIndex(other => other.id === slide.id) + 1,
      total: siblings.length,
    });
  };

  const position = { number: currentIndex + 1, total: slideCount };
  const counterLabel = (index: number) =>
    fillTemplate(counterLabelTemplate, { number: index + 1, total: slideCount });

  // Stable hook for "which slide is the carousel actually on": the header card
  // is driven straight off activeIndex, whereas every slide's text stays in the
  // DOM whether or not it is showing.
  const activeSlideProps = {
    'data-testid': 'carousel-active-slide',
    'data-slide-id': currentSlide.id,
    'data-slide-type': currentSlide.type,
  };

  // The card is a banner for the slide under it, not a heading: the screen's
  // one h1 is the status headline, and the slide's own h2 is below. Its image
  // is decoration for the same reason: the words under it say the same thing,
  // so alt text would have a screen reader read each title twice.
  const renderHeaderCard = () => {
    const isPrivacy = currentSlide.type === 'privacy';
    return (
      <div
        className={`parent-rights-card parent-rights-card--${isPrivacy ? 'green' : 'pink'}`}
        {...activeSlideProps}
      >
        <p className="parent-rights-card-title">{isPrivacy ? displayHeaderGreenTitle : displayHeaderPinkTitle}</p>
        <img src={currentSlide.image} className="slide-rights-image" alt="" />
      </div>
    );
  };

  return (
    // A named region, so a screen reader can find the deck and says what it is.
    <div
      className="parent-rights-container"
      role="region"
      aria-roledescription="carousel"
      aria-label={carouselLabel}
    >

      {renderHeaderCard()}

      {/* Which slide is showing, said aloud when it changes. Polite, and a
          plain text region that nothing focuses: pressing an arrow keeps the
          parent's place on the arrow. Always mounted, so the first change is
          spoken. */}
      <div aria-live="polite" aria-atomic="true" className="visually-hidden">
        {fillTemplate(announceTemplate, { ...position, title: currentSlide.title })}
      </div>

      {/* Carousel*/}
      <div className="parent-rights-carousel-wrapper">
        <Carousel
          activeIndex={currentIndex}
          onSelect={goToSlide}
          controls={false}
          indicators={false}
          interval={null}
          pause="hover"
          wrap={loop}
          className={`parent-rights-carousel ${className}`}
        >
          {slides.map((slide, index) => (
            <Carousel.Item key={slide.id}>
              <div
                className={`carousel-slide slide-${index + 1}`}
                role="group"
                aria-roledescription="slide"
                aria-label={counterLabel(index)}
              >
                <div className="slide-rights-content">
                  <p className="slide-eyebrow">{sectionEyebrow(slide)}</p>
                  {/* A right is headed by its own number and title, the one
                      the parent is on, not a list of all six. Everything else
                      is headed by its plain title. */}
                  <h2 data-testid={slide.type === 'rights' ? 'rights-indicator' : undefined}>
                    {rightsIndicator(slide) ?? slide.title}
                  </h2>
                  <p>{slide.content}</p>
                </div>
              </div>
            </Carousel.Item>
          ))}
        </Carousel>
      </div>

      {/* One row of controls, under the deck: the two arrows with a text
          counter between them. The arrows are the control; the counter only
          says where you are, so it is not a button. (It was fifteen dots,
          which on a phone were 16px targets the parent never needed.)

          The alt text is the only name the two arrows have, so it is the
          parent's label for them and is localized like any other. */}
      <div className='parent-rights-carousel-buttons'>
          <button
            type="button"
            onClick={() => goToSlide(currentIndex - 1)}
            disabled={!loop && currentIndex === 0}
            className='carousel-nav-button carousel-prev-button'
          >
            <img loading="lazy" decoding="async" src="/images/arrow.svg" alt={translated('common.previous', DEFAULT_PREVIOUS_LABEL)} className="arrow-icon-prev" />
          </button>

          {/* The glyphs are what a sighted parent reads; "3 / 8" alone is
              ambiguous aloud, so a screen reader gets the sentence instead.
              dir="ltr" keeps the numerals in reading order under RTL, where
              the bidi algorithm would otherwise put the total first. */}
          <div className="parent-rights-counter">
            <span aria-hidden="true" dir="ltr" data-testid="carousel-counter">
              {fillTemplate(counterTemplate, position)}
            </span>
            <span className="visually-hidden">{counterLabel(currentIndex)}</span>
          </div>

          <button
            type="button"
            onClick={() => goToSlide(currentIndex + 1)}
            disabled={!loop && currentIndex === slideCount - 1}
            className='carousel-nav-button carousel-next-button'
          >
            <img loading="lazy" decoding="async" src="/images/arrow.svg" alt={translated('common.next', DEFAULT_NEXT_LABEL)} className="arrow-icon-next" />
          </button>
      </div>
    </div>
  );
};

export default ParentRightsCarousel;
