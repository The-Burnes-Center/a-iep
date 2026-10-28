import { useState, useMemo } from 'react';
import { Carousel } from 'react-bootstrap';
import './ParentRightsBanner.css';
import { useLanguage } from '../common/language-context';

interface SlideData {
    id: string;
    type: 'privacy' | 'rights';
    title: string;
    content: string;
    image: string;
}

interface ParentRightsBannerProps {
    slides?: SlideData[];
    className?: string;
    onLastSlideReached?: () => void;
    headerPinkTitle?: string;
    headerGreenTitle?: string;
}

/** Same key and English wording ParentRightsCarousel names its dots with. */
const GO_TO_SLIDE_KEY = 'carousel.goToSlide';
const DEFAULT_GO_TO_SLIDE_TEMPLATE = 'Go to slide {number}';

const defaultSlideData: SlideData[] = [
    { id: 'slide-1', type: 'privacy', title: 'Your data is safe', content: "We're removing your personal information from the summaries. We will not store any of your or your child's personal details.", image: '/images/carousel/surprised.png' },
    { id: 'slide-2', type: 'privacy', title: "Your IEP won't be changed", content: "We're creating a separate document with your summary. You can download it by clicking on the button.", image: '/images/carousel/blissful.png' },
    { id: 'slide-3', type: 'rights', title: 'You can request a translator', content: 'You can request a translator for IEP meetings to ensure clear communication.', image: '/images/carousel/joyful.png' },
    { id: 'slide-4', type: 'rights', title: 'You can take your time', content: "You have the right to take your time before signing an IEP - you don't need to sign until you're ready.", image: '/images/carousel/surprised.png' },
    { id: 'slide-5', type: 'rights', title: 'You can consent or not', content: "You can consent to all, some, or none of the proposed services - your child won't receive new services without your approval.", image: '/images/carousel/blissful.png' },
    { id: 'slide-6', type: 'rights', title: 'You can request a meeting', content: 'You have the right to request an IEP meeting at any time, not just at the annual review, and the school must schedule it within 30 days.', image: '/images/carousel/joyful.png' },
    { id: 'slide-7', type: 'rights', title: 'You can reschedule', content: "If an administrator isn't present at the meeting, you have the right to reschedule for a time when they can attend.", image: '/images/carousel/surprised.png' },
    { id: 'slide-8', type: 'rights', title: 'You must be given a booklet of your rights', content: 'By law, your case manager must provide you with a booklet of your parental rights before the IEP meeting.', image: '/images/carousel/blissful.png' },
];

const ParentRightsBanner: React.FC<ParentRightsBannerProps> = ({ slides, className = '', onLastSlideReached, headerPinkTitle, headerGreenTitle }) => {
    const { t, translationsLoaded } = useLanguage();
    const [activeIndex, setActiveIndex] = useState(0);

    // Build translated slide data with fallback to defaults
    const translatedSlideData: SlideData[] = useMemo(() => {
        if (!translationsLoaded) return defaultSlideData;
        
        return [
            // Privacy slides (first 2)
            { id: 'slide-1', type: 'privacy', title: t('privacy.slide1.title'), content: t('privacy.slide1.content'), image: '/images/carousel/surprised.png' },
            { id: 'slide-2', type: 'privacy', title: t('privacy.slide2.title'), content: t('privacy.slide2.content'), image: '/images/carousel/blissful.png' },
            // Rights slides (slides 3-8)
            { id: 'slide-3', type: 'rights', title: t('rights.slide1.title'), content: t('rights.slide1.content'), image: '/images/carousel/joyful.png' },
            { id: 'slide-4', type: 'rights', title: t('rights.slide2.title'), content: t('rights.slide2.content'), image: '/images/carousel/surprised.png' },
            { id: 'slide-5', type: 'rights', title: t('rights.slide3.title'), content: t('rights.slide3.content'), image: '/images/carousel/blissful.png' },
            { id: 'slide-6', type: 'rights', title: t('rights.slide4.title'), content: t('rights.slide4.content'), image: '/images/carousel/joyful.png' },
            { id: 'slide-7', type: 'rights', title: t('rights.slide5.title'), content: t('rights.slide5.content'), image: '/images/carousel/surprised.png' },
            { id: 'slide-8', type: 'rights', title: t('rights.slide6.title'), content: t('rights.slide6.content'), image: '/images/carousel/blissful.png' },
        ];
    }, [t, translationsLoaded]);

    // Use provided slides, or translated data, or default
    const displaySlides = slides ?? translatedSlideData;
    
    // Translate header titles with fallback
    const displayHeaderGreenTitle = headerGreenTitle ?? t('rights.header.title.green') ?? "Your data is safe with us";
    const displayHeaderPinkTitle = headerPinkTitle ?? t('rights.header.title.pink') ?? "Your rights as a parent";

    // An untranslated key comes back as itself, so fall back to the English wording.
    const goToSlideTemplate = t(GO_TO_SLIDE_KEY);
    const displayGoToSlideTemplate = !goToSlideTemplate || goToSlideTemplate === GO_TO_SLIDE_KEY
        ? DEFAULT_GO_TO_SLIDE_TEMPLATE
        : goToSlideTemplate;
    const goToSlideLabel = (index: number) => displayGoToSlideTemplate.replace('{number}', String(index + 1));

    // Default behavior: cycle back to first slide
    const defaultOnLastSlideReached = () => {
        setActiveIndex(0);
    };

    const handleLastSlideReached = onLastSlideReached ?? defaultOnLastSlideReached;

    const handleSelect = (selectedIndex: number) => {
        if (selectedIndex === 0 && activeIndex && displaySlides.length - 1) {
            handleLastSlideReached();
        }
        setActiveIndex(selectedIndex);
    };

    const handlePrevious = () => {
        if (activeIndex > 0) {
            setActiveIndex((prev) => prev - 1);
        }
    };

    const handleNext = () => {
        if (activeIndex < displaySlides.length - 1) {
            setActiveIndex((prev) => prev + 1);
        } else {
            handleLastSlideReached();
        }
    };

    return(
        <div className="parent-rights-banner-container">
            <div className='parent-rights-banner-content'>
                <div className='parent-rights-banner-content-left'>
                    {
                        // h2, not h1: a section of the landing page, whose
                        // one h1 is the hero title (HeroSection.tsx).
                        activeIndex <= 1 ? 
                        <div className="banner-card banner-card--green">
                        <h2>{displayHeaderGreenTitle}</h2>
                        <img loading="lazy" decoding="async" src={displaySlides[activeIndex].image} className="banner-slide-image" alt={displaySlides[activeIndex].title} /> 
                    </div>
                        : (
                        <div className="banner-card banner-card--pink">
                        <h2>{displayHeaderPinkTitle}</h2>
                        <img loading="lazy" decoding="async" src={displaySlides[activeIndex].image} className="banner-slide-image" alt={displaySlides[activeIndex].title} /> 
                        </div>
                        )
                    }
                </div>
                <div className='parent-rights-banner-content-right'>

                    {/* Carousel*/}
                    <div className="banner-carousel-wrapper">
                        <Carousel 
                        activeIndex={activeIndex}
                        onSelect={handleSelect}       
                        controls={false}
                        indicators={false}
                        interval={null}
                        pause="hover"
                        className={`banner-carousel ${className}`}
                        >
                        {displaySlides.map((slide, index) => (
                            <Carousel.Item key={slide.id}>
                            <div className={`banner-carousel-slide slide-${index + 1}`}>
                                <div className="banner-slide-content">
                                {index > 1 && <h2>{index - 1}/6</h2>}
                                <h2>{slide.title}</h2>
                                <p>{slide.content}</p>
                                </div>
                            </div>
                            </Carousel.Item>
                        ))}
                        </Carousel>
                        {/* Ours, not react-bootstrap's indicators: those are 10px and labelled "Slide N" in English. */}
                        <div className="banner-dots" data-testid="banner-dots">
                            {displaySlides.map((slide, index) => (
                                <button
                                    key={slide.id}
                                    type="button"
                                    className={`banner-dot ${index === activeIndex ? 'active' : ''}`}
                                    aria-label={goToSlideLabel(index)}
                                    aria-current={index === activeIndex ? 'true' : undefined}
                                    onClick={() => handleSelect(index)}
                                />
                            ))}
                        </div>
                    </div>

                    <div className='banner-carousel-buttons'>
                        <button 
                            onClick={handlePrevious}
                            disabled={activeIndex === 0}
                            className='banner-nav-button banner-prev-button'
                        >
                            <img loading="lazy" decoding="async" src="/images/arrow.svg" alt="Previous" className="banner-arrow-prev" />
                        </button>
                        <button 
                            onClick={handleNext}
                            className='banner-nav-button banner-next-button'
                        >
                            <img loading="lazy" decoding="async" src="/images/arrow.svg" alt="Next" className="banner-arrow-next" />
                        </button>
                    </div>

                </div>
            </div>
        </div> 
    );
}

export default ParentRightsBanner;