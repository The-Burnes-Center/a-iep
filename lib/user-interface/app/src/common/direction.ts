// Served from public/vendor (copied by scripts/sync-bootstrap.cjs, which runs
// as predev/prebuild). Deliberately NOT ?url imports: importing CSS with ?url
// is broken in Vite 4 production builds — the __VITE_ASSET__ placeholder is
// never replaced, leaving a 404 href.
const bootstrapLtrUrl = '/vendor/bootstrap.min.css';
const bootstrapRtlUrl = '/vendor/bootstrap.rtl.min.css';

export type Dir = 'ltr' | 'rtl';

const RTL_LANGUAGES = new Set(['ar']);

export const getDirForLanguage = (lang: string): Dir =>
  RTL_LANGUAGES.has(lang) ? 'rtl' : 'ltr';

// Bootstrap is loaded through this single managed <link> (instead of the
// static import in main.tsx) so the LTR/RTL build can be swapped at runtime.
// It is inserted BEFORE existing stylesheets so custom CSS (app.scss, etc.)
// keeps winning the cascade, matching the old import order in main.tsx.
const bootstrapLink = document.createElement('link');
bootstrapLink.rel = 'stylesheet';
bootstrapLink.id = 'bootstrap-css';
document.head.insertBefore(
  bootstrapLink,
  document.head.querySelector('link[rel="stylesheet"], style')
);

export function applyDirection(lang: string): void {
  const dir = getDirForLanguage(lang);
  const url = dir === 'rtl' ? bootstrapRtlUrl : bootstrapLtrUrl;
  if (!bootstrapLink.href.endsWith(url)) {
    bootstrapLink.href = url;
  }
  document.documentElement.dir = dir;
  document.documentElement.lang = lang;
}

// Apply synchronously at module evaluation so a returning RTL user never sees
// an LTR first paint. Key literal matches LANGUAGE_STORAGE_KEY in
// language-context.ts (kept as a literal to avoid a circular import).
applyDirection(localStorage.getItem('aiep-language-preference') || 'en');

// Prefetch the OTHER bootstrap build (~31KB gz) during idle time so switching
// between LTR and RTL languages doesn't wait on the stylesheet download.
const prefetchAlternateBootstrap = () => {
  const alternateUrl = bootstrapLink.href.endsWith(bootstrapRtlUrl) ? bootstrapLtrUrl : bootstrapRtlUrl;
  const prefetch = document.createElement('link');
  prefetch.rel = 'prefetch';
  prefetch.as = 'style';
  prefetch.href = alternateUrl;
  document.head.appendChild(prefetch);
};
if (typeof window.requestIdleCallback === 'function') {
  window.requestIdleCallback(prefetchAlternateBootstrap, { timeout: 5000 });
} else {
  setTimeout(prefetchAlternateBootstrap, 2000);
}
