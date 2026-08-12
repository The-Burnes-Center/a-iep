import React, { useMemo, useState } from 'react';
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
      {
        id: 'slide-9',
        type: 'tutorial',
        titleKey: 'rights.slide7.title',
        contentKey: 'rights.slide7.content',
        title: 'Get a first glimpse of the entire IEP document',
        content: 'At the top of the screen, you will find a short summary of the information we found on your IEP document.',
        image: '/images/tutorial-01.jpg'
      },
      {
        id: 'slide-10',
        type: 'tutorial',
        titleKey: 'rights.slide8.title',
        contentKey: 'rights.slide8.content',
        title: 'Understand the main insights from the IEP',
        content: 'In the sections below, you will find the key insights we drew from the document you uploaded. Click on the titles to read the information.',
        image: '/images/tutorial-02.jpg'
      },
      {
        id: 'slide-11',
        type: 'tutorial',
        titleKey: 'rights.slide9.title',
        contentKey: 'rights.slide9.content',
        title: 'Find the meaning of complex terms',
        content: "Whenever you see a blue word, you will be able to click on it to show its definition. When you're done, click on the X to return to your summary.",
        image: '/images/tutorial-03.jpg'
      },
      {
        id: 'slide-12',
        type: 'tutorial',
        titleKey: 'rights.slide10.title',
        contentKey: 'rights.slide10.content',
        title: 'Contrast the content with the original IEP',
        content: 'Below the title of each key insight, you will find the page number where we took the information from. If something feels wrong, always double check!',
        image: '/images/tutorial-04.jpg'
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

// Preload tutorial images at module load time to prevent lag when navigating
DEFAULT_DECK
  .filter(slide => slide.type === 'tutorial')
  .forEach(slide => {
    const img = new Image();
    img.src = slide.image;
  });

/**
 * A slide's kind decides which card it wears above the text:
 * - `privacy`  green pattern card under the "your data is safe" header
 * - `rights`   pink pattern card under the "your rights" header
 * - `tutorial` full-bleed screenshot card, no header
 * - `section`  a divider that introduces the group of slides after it. It
 *              carries only its own title and an image, no body copy.
 */
export type SlideType = 'privacy' | 'rights' | 'tutorial' | 'section';

export interface SlideData {
  id: string;
  type: SlideType;
  title: string;
  content: string;
  /** Absent on `section` dividers, which carry their title alone. */
  image?: string;
  /**
   * Only read for `section` dividers: one colour per section, so the three
   * dividers are told apart at a glance. Defaults to green.
   */
  theme?: SectionTheme;
}

const SECTION_THEMES = ['green', 'pink', 'blue'] as const;

export type SectionTheme = (typeof SECTION_THEMES)[number];

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

const DEFAULT_SECTION_HINT = 'Swipe or tap the arrows to learn more';

const DEFAULT_HEADER_PINK_TITLE = 'Your rights as a parent';

const DEFAULT_HEADER_GREEN_TITLE = 'Your data is safe with us';

const DEFAULT_PREVIOUS_LABEL = 'Previous';

const DEFAULT_NEXT_LABEL = 'Next';

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
  /**
   * Body copy for a section divider, which has no content of its own. It fills
   * what would otherwise be an empty block and tells a parent how to move on.
   *
   * Deliberately says "the arrows" rather than naming a side: the app sets
   * document.dir, and this carousel mirrors its own buttons under RTL, so in
   * Arabic "next" sits on the LEFT. Naming a side would point Arabic readers
   * the wrong way.
   */
  sectionHint?: string;
}

const ParentRightsCarousel: React.FC<ParentRightsCarouselProps> = ({
  slides: slidesProp,
  className = '',
  headerPinkTitle,
  headerGreenTitle,
  loop = true,
  rightsIndicatorTemplate,
  sectionHint,
}) => {

  const { t } = useLanguage();
  const [activeIndex, setActiveIndex] = useState(0);

  // The standalone /rights-of-parents route passes nothing, so the component
  // has to translate its own deck. ProcessingModal passes one already
  // translated by the page that owns t(), and that always wins.
  const localizedDeck = useMemo(() => localizeDeck(t), [t]);

  const translated = (key: string, fallback: string) => withFallback(t, key, fallback);

  const slides = slidesProp ?? localizedDeck;
  const displayHeaderPinkTitle = headerPinkTitle ?? translated('rights.header.title.pink', DEFAULT_HEADER_PINK_TITLE);
  const displayHeaderGreenTitle = headerGreenTitle ?? translated('rights.header.title.green', DEFAULT_HEADER_GREEN_TITLE);
  const displayRightsIndicatorTemplate = rightsIndicatorTemplate ?? translated('carousel.rights.indicator', DEFAULT_RIGHTS_INDICATOR_TEMPLATE);
  const displaySectionHint = sectionHint ?? translated('carousel.section.hint', DEFAULT_SECTION_HINT);

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

  // The rights are numbered among THEMSELVES: the dividers, the app slides and
  // the tutorial slides are not rights and are not counted, so "3." always
  // means the third right no matter what else the deck carries.
  const rightsIds = slides.filter(slide => slide.type === 'rights').map(slide => slide.id);

  const rightsIndicator = (slide: SlideData): string | null => {
    if (slide.type !== 'rights') return null;
    return displayRightsIndicatorTemplate
      .replace('{number}', String(rightsIds.indexOf(slide.id) + 1))
      .replace('{title}', slide.title);
  };

  // Stable hook for "which slide is the carousel actually on": the header card
  // is driven straight off activeIndex, whereas every slide's text stays in the
  // DOM whether or not it is showing.
  const activeSlideProps = {
    'data-testid': 'carousel-active-slide',
    'data-slide-id': currentSlide.id,
    'data-slide-type': currentSlide.type,
  };

  const renderHeaderCard = () => {
    if (currentSlide.type === 'section') {
      const theme = SECTION_THEMES.includes(currentSlide.theme) ? currentSlide.theme : 'green';
      // Title only. A divider's job is to mark a boundary, and an illustration
      // reads as content rather than as a break.
      return (
        <div className={`parent-rights-card parent-rights-card--${theme} parent-rights-card--section`} {...activeSlideProps}>
          <h1>{currentSlide.title}</h1>
        </div>
      );
    }

    if (currentSlide.type === 'privacy') {
      return (
        <div className="parent-rights-card parent-rights-card--green" {...activeSlideProps}>
          <h1>{displayHeaderGreenTitle}</h1>
          <img src={currentSlide.image} className="slide-rights-image" alt={currentSlide.title} />
        </div>
      );
    }

    if (currentSlide.type === 'rights') {
      return (
        <div className="parent-rights-card parent-rights-card--pink" {...activeSlideProps}>
          <h1>{displayHeaderPinkTitle}</h1>
          <img src={currentSlide.image} className="slide-rights-image" alt={currentSlide.title} />
        </div>
      );
    }

    return (
      <div
        key={currentSlide.id}
        className="tutorial-card"
        style={{ '--tutorial-bg': `url(${currentSlide.image})` } as React.CSSProperties}
        {...activeSlideProps}
      >
      </div>
    );
  };

  return (
    <div className="parent-rights-container">

      {renderHeaderCard()}

      {/* The alt text is the only name these two buttons have, so it is the
          parent's label for them and is localized like any other. */}
      <div className='parent-rights-carousel-buttons'>
          <button
            onClick={() => goToSlide(currentIndex - 1)}
            disabled={!loop && currentIndex === 0}
            className='carousel-nav-button carousel-prev-button'
          >
            <img src="/images/arrow.svg" alt={translated('common.previous', DEFAULT_PREVIOUS_LABEL)} className="arrow-icon-prev" />
          </button>
          <button
            onClick={() => goToSlide(currentIndex + 1)}
            disabled={!loop && currentIndex === slideCount - 1}
            className='carousel-nav-button carousel-next-button'
          >
            <img src="/images/arrow.svg" alt={translated('common.next', DEFAULT_NEXT_LABEL)} className="arrow-icon-next" />
          </button>
      </div>

      {/* Carousel*/}
      <div className="parent-rights-carousel-wrapper">
        <Carousel
          activeIndex={currentIndex}
          onSelect={goToSlide}
          controls={false}
          indicators={true}
          interval={null}
          pause="hover"
          wrap={loop}
          className={`parent-rights-carousel ${className}`}
        >
          {slides.map((slide, index) => (
            <Carousel.Item key={slide.id}>
              <div className={`carousel-slide slide-${index + 1}`}>
                {slide.type === 'section' ? (
                  // A divider's title lives in the card above, so repeating it
                  // here would say the same thing twice. The block still has to
                  // hold its full height (anything shorter moves the indicator
                  // dots under the parent's thumb), so it carries the hint
                  // rather than sitting empty.
                  <div className="slide-rights-content slide-rights-content--section">
                    <p>{displaySectionHint}</p>
                  </div>
                ) : (
                  <div className="slide-rights-content">
                    {/* A right is headed by its own number and title — the one
                        the parent is on, not a list of all six. Everything else
                        is headed by its plain title. */}
                    <h2 data-testid={slide.type === 'rights' ? 'rights-indicator' : undefined}>
                      {rightsIndicator(slide) ?? slide.title}
                    </h2>
                    <p>{slide.content}</p>
                  </div>
                )}
              </div>
            </Carousel.Item>
          ))}
        </Carousel>
      </div>
    </div>
  );
};

export default ParentRightsCarousel;