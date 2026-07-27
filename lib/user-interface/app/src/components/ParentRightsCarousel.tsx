import React, { useState } from 'react';
import { Carousel } from 'react-bootstrap';
import './ParentRightsCarousel.css';

// eslint-disable-next-line react-refresh/only-export-components -- slide data belongs beside the carousel that renders it; moving exports is out of scope for this lint pass
export const defaultSlideData = [
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

export interface SlideData {
  id: string;
  type: 'privacy' | 'rights' | 'tutorial';
  title: string;
  content: string;
  image: string;
}

export interface ParentRightsCarouselProps {
  slides?: SlideData[];
  className?: string;
  onLastSlideReached?: () => void;
  headerPinkTitle?: string;
  headerGreenTitle?: string;
}

const ParentRightsCarousel: React.FC<ParentRightsCarouselProps> = ({ slides = defaultSlideData, className = '', onLastSlideReached, headerPinkTitle = "Your rights as a parent", headerGreenTitle = "Your data is safe with us" }) => {
 
  const [activeIndex, setActiveIndex] = useState(0);

  const handleSelect = (selectedIndex: number) => {
    if(selectedIndex === 0 && activeIndex && slides.length -1){
      onLastSlideReached();
    }

    setActiveIndex(selectedIndex);
  };

  const handlePrevious = () => {
    if(activeIndex > 0){
      setActiveIndex((prev) => prev - 1)
    }
  }

  const handleNext = () => {
    if(activeIndex < slides.length){
      setActiveIndex((prev) => prev + 1)
    }

    if(activeIndex == slides.length - 1){
      // console.log("Calling callback onLastSlideReached")
      onLastSlideReached();
    }
  }

  return (
    <div className="parent-rights-container">
      

      {
        slides[activeIndex].type === 'privacy' ? (
          <div className="parent-rights-card parent-rights-card--green">
            <h1>{headerGreenTitle}</h1>
            <img src={slides[activeIndex].image} className="slide-rights-image" alt={slides[activeIndex].title} /> 
          </div>
        ) : slides[activeIndex].type === 'rights' ? (
          <div className="parent-rights-card parent-rights-card--pink">
          <h1>{headerPinkTitle}</h1>
          <img src={slides[activeIndex].image} className="slide-rights-image" alt={slides[activeIndex].title} /> 
        </div>
        ) : (
          <div key={slides[activeIndex].id} className="tutorial-card" style={{ '--tutorial-bg': `url(${slides[activeIndex].image})` } as React.CSSProperties}>
          </div>
        )
      }

      <div className='parent-rights-carousel-buttons'>
          <button 
            onClick={handlePrevious}
            disabled={activeIndex === 0}
            className='carousel-nav-button carousel-prev-button'
          >
            <img src="/images/arrow.svg" alt="Previous" className="arrow-icon-prev" />
          </button>
          <button 
            onClick={handleNext}
            className='carousel-nav-button carousel-next-button'
          >
            <img src="/images/arrow.svg" alt="Next" className="arrow-icon-next" />
          </button>
      </div>

      {/* Carousel*/}
      <div className="parent-rights-carousel-wrapper">
        <Carousel 
          activeIndex={activeIndex}
          onSelect={handleSelect}       
          controls={false} 
          indicators={true}
          interval={null}
          pause="hover"
          className={`parent-rights-carousel ${className}`}
        >
          {slides.map((slide, index) => (
            <Carousel.Item key={slide.id}>
              <div className={`carousel-slide slide-${index + 1}`}>
                <div className="slide-rights-content">
                  {index > 1 && <h2>{index - 1 > 6 ? index - 7 : index - 1}/{index - 1 > 6 ? 4 : 6}</h2>}
                  <h2>{slide.title}</h2>
                  <p>{slide.content}</p>
                </div>
              </div>
            </Carousel.Item>
          ))}
        </Carousel>
      </div>
    </div>
  );
};

export default ParentRightsCarousel; 