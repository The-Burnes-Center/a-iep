// Google Analytics helper functions
declare global {
  interface Window {
    dataLayer: unknown[];
    gtag: (...args: unknown[]) => void;
  }
}

export const GA_MEASUREMENT_ID = 'G-HR9GRXHLHK';

let analyticsEnabled = false;

// Loads gtag.js and turns tracking on. Called once at startup, and only when
// aws-exports.json says environment === 'prod': staging is also built with
// NODE_ENV=production, so a build-time check cannot keep staging traffic out
// of the production GA property.
export const initAnalytics = () => {
  if (analyticsEnabled || typeof window === 'undefined') return;
  analyticsEnabled = true;

  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params -- gtag.js requires the live arguments object, not an array
    window.dataLayer.push(arguments);
  };
  window.gtag('js', new Date());
  // AppRoutes fires trackPageView on every location change including the
  // first, so the automatic initial page_view would double-count it.
  window.gtag('config', GA_MEASUREMENT_ID, { send_page_view: false });

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(script);
};

export const trackPageView = (page_path: string, page_title?: string) => {
  if (!analyticsEnabled) return;
  window.gtag('config', GA_MEASUREMENT_ID, {
    page_path,
    page_title,
  });
};

export const trackEvent = (action: string, parameters?: Record<string, unknown>) => {
  if (!analyticsEnabled) return;
  window.gtag('event', action, parameters);
};
