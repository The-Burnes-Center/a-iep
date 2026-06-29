import React, { useState } from 'react';
import { Carousel } from 'react-bootstrap';
import { useLanguage } from '../common/language-context';
import './AppTutorialCarousel.css';

interface SlideData {
  id: string;
  title: string;
  content: string;
  image: string;
}

interface AppTutorialCarouselProps {
  slides: SlideData[];
  className?: string;
  onLastSlideReached?: () => void;
}

const AppTutorialCarousel: React.FC<AppTutorialCarouselProps> = ({ slides, className = '',onLastSlideReached}) => {
  const { t } = useLanguage();
  const [activeIndex, setActiveIndex] = useState(0);

  const handleSelect = (selectedIndex: number) => {
    if(selectedIndex === 0 && activeIndex && slides.length -1){
      onLastSlideReached();
    }

    setActiveIndex(selectedIndex);
  };

  const handlePrevious = () => {
    if (activeIndex > 0) {
      setActiveIndex(activeIndex - 1);
    }
  };

  const handleNext = () => {
    if (activeIndex < slides.length - 1) {
      setActiveIndex(activeIndex + 1);
    }
  };

  return (
    <div className="app-tutorial-container">
      <div className="app-tutorial-carousel-wrapper">
        <Carousel 
          controls={false} 
          indicators={true}
          interval={null}
          pause="hover"
          activeIndex={activeIndex}
          onSelect={handleSelect}
          className={`app-tutorial-carousel ${className}`}
        >
          {slides.map((slide, index) => (
            <Carousel.Item key={slide.id}>
              <div className={`carousel-slide slide-${index + 1}`}>
                <img src={slide.image} className="slide-image" alt="" />
                <div className="slide-tutorial-content">
                  <p>{slide.content}</p>
                </div>
              </div>
            </Carousel.Item>
          ))}
        </Carousel>
        
        <div className="carousel-desktop-navigation">
          <button
            className="carousel-nav-btn prev-btn"
            onClick={handlePrevious}
            disabled={activeIndex === 0}
          >
            {t('common.previous')}
          </button>
          <button
            className="carousel-nav-btn next-btn"
            onClick={handleNext}
            disabled={activeIndex === slides.length - 1}
          >
            {t('common.next')}
          </button>
         </div>
      </div>
    </div>
  );
};

export default AppTutorialCarousel;