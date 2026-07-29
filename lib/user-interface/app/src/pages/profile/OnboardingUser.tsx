import React, { useMemo, useState } from 'react';
import { Button } from 'react-bootstrap';
import { Swiper, SwiperSlide } from 'swiper/react';
import type { Swiper as SwiperClass } from 'swiper';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../../common/language-context';
import 'swiper/css';
import 'swiper/css/pagination';
import { Pagination } from 'swiper/modules';
import './OnboardingUser.css';

const OnboardingUser: React.FC = () => {

  const [activeSlide, setActiveSlide] = useState(0);
  const { t, language } = useLanguage();

  const totalSlides = 4;
  const isLastSlide = activeSlide === totalSlides - 1;
  const isFirstSlide = activeSlide === 0;

  const navigate = useNavigate();

  const carouselHeadings = useMemo(() => [
    t('onboarding.carousel.heading.accessible'),
    t('onboarding.carousel.heading.summarize'), 
    t('onboarding.carousel.heading.translate'),
    t('onboarding.carousel.heading.advocate')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- language intentionally retriggers translation of the onboarding copy
  ], [t, language]);


  const carouselParagraphs = useMemo(() => [
    t('onboarding.carousel.paragraph.accessible'),
    t('onboarding.carousel.paragraph.summarize'),
    t('onboarding.carousel.paragraph.translate'),
    t('onboarding.carousel.paragraph.advocate')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- language intentionally retriggers translation of the onboarding copy
  ], [t, language]);

  const getStartedText = useMemo(() =>
    t('parent.button.save'),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- language intentionally retriggers translation of the onboarding copy
  [t, language]);

  // Array of image data
  const slideImages = [
    {
      src: '/images/carousel/Complex_IEP.png',
      alt: 'Complex IEP Document made accessible'
    },
    {
      src: '/images/carousel/Summarize.png', 
      alt: 'Summarize IEP content'
    },
    {
      src: '/images/carousel/Translate.png',
      alt: 'Translate IEP documents'
    },
    {
      src: '/images/carousel/Advocate.png',
      alt: 'Advocate for your child'
    }
  ];

  const handleBackClick = () => {
    navigate('/');
  };
  
  // Create a ref to access Swiper instance
  const swiperRef = React.useRef<SwiperClass | null>(null);
  
  const handlePrevClick = () => {
    if (swiperRef.current && !isFirstSlide) {
      swiperRef.current.slidePrev();
    }
  };
  
  const handleNextClick = () => {
    if (swiperRef.current && !isLastSlide) {
      swiperRef.current.slideNext();
    }
  };
  
  const handleGetStarted = () => {
    navigate('/consent-form');
  };
  
  return (
    <div className="page modal-wrapper">
      <div className="modal-overlay"></div>
      <div className="modal-container">
        <div className="modal-navigation right">
          <Button variant="outline-secondary" onClick={handleBackClick} className="aiep-button">
            <img 
                    src="/images/arrow-back.svg" 
                    alt=""
                    className="btn-icon"
                  />
              {t('common.back')}
          </Button>
          <Button variant="outline-secondary" className="aiep-button" onClick={handleGetStarted}>
            {t('common.skip')}
          </Button>
        </div>
        <div className="carousel-container">
          <Swiper
            slidesPerView={1}
            spaceBetween={100}
            centeredSlides={true}
            threshold={20}
            pagination={{
              clickable: true,
              el: '.swiper-custom-pagination',
            }}
            onSlideChange={(swiper) => setActiveSlide(swiper.activeIndex)}
            modules={[Pagination]}
            className="mySwiper"
            onSwiper={(swiper) => {
              swiperRef.current = swiper;
            }}
          >
            {slideImages.map((image, index) => (
              <SwiperSlide key={index}>
                <div className="image-container">
                  <img 
                  src={image.src} 
                  alt={image.alt}
                />
                </div>
              </SwiperSlide>
            ))}
          </Swiper>
        <div className='heading-paragraph-container'>
          <h5 className="carousel-heading">
            {carouselHeadings[activeSlide]}
          </h5>
          <p className="carousel-paragraph">
            {carouselParagraphs[activeSlide]}
          </p>
        </div>

        <div className="swiper-custom-pagination"></div>
        
        <div className="carousel-navigation">
          <Button 
            variant="outline-primary" 
            className="aiep-button prev-btn" 
            disabled={isFirstSlide}
            onClick={handlePrevClick}
          >
            {t('common.previous')}
          </Button>
          
          {isLastSlide ? (
            <Button 
              variant="primary" 
              className="aiep-button nav-btn next-btn" 
              onClick={handleGetStarted}
            >
              {getStartedText}
            </Button>
          ) : (
            <Button 
              variant="primary" 
              className="aiep-button nav-btn next-btn" 
              onClick={handleNextClick}
            >
              {t('common.next')}
            </Button>
          )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default OnboardingUser;