import React, { useState } from 'react';
import { Carousel } from 'react-bootstrap';
import './ParentRightsCarousel.css';

// eslint-disable-next-line react-refresh/only-export-components -- slide data belongs beside the carousel that renders it; moving exports is out of scope for this lint pass
export const defaultSlideData: SlideData[] = [
      {
        id: 'slide-1',
        type: 'privacy',
        title: 'Your data is safe',
        content: "We're removing your personal information from the summaries. We will not store any of your or your child's personal details.",
        image: '/images/carousel/surprised.png'
      },
      {
        id: 'slide-2',
        type: 'privacy',
        title: "Your IEP won't be changed",
        content: "We're creating a separate document with your summary. You can download it by clicking on the button.",
        image: '/images/carousel/blissful.png'
      },
      {
        id: 'slide-3',
        type: 'rights',
        title: 'You can request a translator',
        content: 'You can request a translator for IEP meetings to ensure clear communication.',
        image: '/images/carousel/joyful.png'
      },
      {
        id: 'slide-4',
        type: 'rights',
        title: 'You can take your time',
        content: "You have the right to take your time before signing an IEP - you don't need to sign until you're ready.",
        image: '/images/carousel/surprised.png'
      },
      {
        id: 'slide-5',
        type: 'rights',
        title: 'You can consent or not',
        content: "You can consent to all, some, or none of the proposed services - your child won't receive new services without your approval.",
        image: '/images/carousel/blissful.png'
      },
      {
        id: 'slide-6',
        type: 'rights',
        title: 'You can request a meeting',
        content: 'You have the right to request an IEP meeting at any time, not just at the annual review, and the school must schedule it within 30 days.',
        image: '/images/carousel/joyful.png'
      },
      {
        id: 'slide-7',
        type: 'rights',
        title: 'You can reschedule',
        content: "If an administrator isn't present at the meeting, you have the right to reschedule for a time when they can attend.",
        image: '/images/carousel/surprised.png'
      },
      {
        id: 'slide-8',
        type: 'rights',
        title: 'You must be given a booklet of your rights',
        content: 'By law, your case manager must provide you with a booklet of your parental rights before the IEP meeting.',
        image: '/images/carousel/blissful.png'
      },
      {
        id: 'slide-9',
        type: 'tutorial',
        title: 'Get a first glimpse of the entire IEP document',
        content: 'At the top of the screen, you will find a short summary of the information we found on your IEP document.',
        image: '/images/tutorial-01.jpg'
      },
      {
        id: 'slide-10',
        type: 'tutorial',
        title: 'Understand the main insights from the IEP',
        content: 'In the sections below, you will find the key insights we drew from the document you uploaded. Click on the titles to read the information.',
        image: '/images/tutorial-02.jpg'
      },
      {
        id: 'slide-11',
        type: 'tutorial',
        title: 'Find the meaning of complex terms',
        content: "Whenever you see a blue word, you will be able to click on it to show its definition. When you're done, click on the X to return to your summary.",
        image: '/images/tutorial-03.jpg'
      },
      {
        id: 'slide-12',
        type: 'tutorial',
        title: 'Contrast the content with the original IEP',
        content: 'Below the title of each key insight, you will find the page number where we took the information from. If something feels wrong, always double check!',
        image: '/images/tutorial-04.jpg'
      },
    ];

// Preload tutorial images at module load time to prevent lag when navigating
defaultSlideData
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
 * How a right is labelled above its text, e.g. "1. You can request a
 * translator". A template rather than string concatenation so each locale
 * owns its own separator and word order; ProcessingModal passes the
 * translated one. This default is the English fallback for the standalone
 * /rights-of-parents route, which renders the untranslated defaultSlideData.
 */
const DEFAULT_RIGHTS_INDICATOR_TEMPLATE = '{number}. {title}';

// Fallback for the standalone /rights-of-parents route, which mounts this
// component with no props and no translator.
const DEFAULT_SECTION_HINT = 'Swipe or tap the arrows to learn more';

export interface ParentRightsCarouselProps {
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
  slides = defaultSlideData,
  className = '',
  headerPinkTitle = 'Your rights as a parent',
  headerGreenTitle = 'Your data is safe with us',
  loop = true,
  rightsIndicatorTemplate = DEFAULT_RIGHTS_INDICATOR_TEMPLATE,
  sectionHint = DEFAULT_SECTION_HINT,
}) => {

  const [activeIndex, setActiveIndex] = useState(0);

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
    return rightsIndicatorTemplate
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
          <h1>{headerGreenTitle}</h1>
          <img src={currentSlide.image} className="slide-rights-image" alt={currentSlide.title} />
        </div>
      );
    }

    if (currentSlide.type === 'rights') {
      return (
        <div className="parent-rights-card parent-rights-card--pink" {...activeSlideProps}>
          <h1>{headerPinkTitle}</h1>
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

      <div className='parent-rights-carousel-buttons'>
          <button
            onClick={() => goToSlide(currentIndex - 1)}
            disabled={!loop && currentIndex === 0}
            className='carousel-nav-button carousel-prev-button'
          >
            <img src="/images/arrow.svg" alt="Previous" className="arrow-icon-prev" />
          </button>
          <button
            onClick={() => goToSlide(currentIndex + 1)}
            disabled={!loop && currentIndex === slideCount - 1}
            className='carousel-nav-button carousel-next-button'
          >
            <img src="/images/arrow.svg" alt="Next" className="arrow-icon-next" />
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
                    <p>{sectionHint}</p>
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