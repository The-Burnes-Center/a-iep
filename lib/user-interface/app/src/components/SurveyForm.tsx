import React, { useEffect } from 'react';
import MobileTopNavigation from './MobileTopNavigation';
import AIEPFooter from './AIEPFooter';
import './SurveyForm.css';

// Extend Window interface to include jotformEmbedHandler
declare global {
  interface Window {
    jotformEmbedHandler: (selector: string, baseUrl: string) => void;
  }
}

const SurveyForm: React.FC = () => {
  useEffect(() => {
    // Load JotForm embed handler script
    const script = document.createElement('script');
    script.src = 'https://cdn.jotfor.ms/s/umd/latest/for-form-embed-handler.js';
    script.async = true;
    document.head.appendChild(script);

    script.onload = () => {
      // Initialize JotForm embed handler after script loads
      if (window.jotformEmbedHandler) {
        window.jotformEmbedHandler("iframe[id='JotFormIFrame-250765400338050']", "https://form.jotform.com/");
      }
    };

    return () => {
      // Cleanup script on component unmount
      document.head.removeChild(script);
    };
  }, []);

  // Add this useEffect after your existing useEffect
  useEffect(() => {
    // Function to handle messages from JotForm iframe
    const handleMessage = (event: MessageEvent) => {
      // Check if the message is from JotForm
      if (event.origin && event.origin.includes('jotform.com')) {
        // Log ALL messages from JotForm for debugging
        // console.log('📩 Message from JotForm:', event.data);
        
        // Check specifically for submission completed
        if (event.data && event.data.action === 'submission-completed') {
          // console.log('FORM SUBMITTED SUCCESSFULLY!');
          // console.log('Form ID:', event.data.formID || 'No ID provided');
        }
      }
    };

    // Add the event listener
    window.addEventListener('message', handleMessage);

    // Cleanup function
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, []);

  return (
    <div className="survey-form-container">
      <MobileTopNavigation />
      <h2 className="survey-form-title">Survey Form:</h2>

      <div className="jotform-container">
        <iframe
          id="JotFormIFrame-250765400338050"
          title="The AIEP Project"
          onLoad={() => window.parent.scrollTo(0,0)}
          allowTransparency={true}
          allow="geolocation; microphone; camera; fullscreen; payment"
          src="https://form.jotform.com/253225624926156"
          className="jotform-iframe"
          scrolling="no"
        />
      </div>
      <AIEPFooter />
    </div>
  );
};

export default SurveyForm;