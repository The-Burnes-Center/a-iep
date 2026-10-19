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

// Bootstrap is loaded through one <link id="bootstrap-css"> (instead of the
// static import in main.tsx) so the LTR/RTL build can be swapped at runtime.
// index.html declares that link with the LTR build, so the request starts with
// the document rather than after the JS bundle runs. This module only swaps its
// href, and only for RTL. A document without the element (a bare test page)
// gets one created here, ahead of the existing stylesheets, so custom CSS
// (app.scss, etc.) keeps winning the cascade.
const resolveBootstrapLink = (): HTMLLinkElement => {
  const existing = document.getElementById('bootstrap-css');
  if (existing instanceof HTMLLinkElement) return existing;

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.id = 'bootstrap-css';
  link.href = bootstrapLtrUrl;
  document.head.insertBefore(
    link,
    document.head.querySelector('link[rel="stylesheet"], style')
  );
  return link;
};
const bootstrapLink = resolveBootstrapLink();

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
