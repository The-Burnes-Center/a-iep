import bootstrapLtrUrl from 'bootstrap/dist/css/bootstrap.min.css?url';
import bootstrapRtlUrl from 'bootstrap/dist/css/bootstrap.rtl.min.css?url';

export type Dir = 'ltr' | 'rtl';

const RTL_LANGUAGES = new Set(['ar']);

export const getDirForLanguage = (lang: string): Dir =>
  RTL_LANGUAGES.has(lang) ? 'rtl' : 'ltr';

// Bootstrap is loaded through this single managed <link> (instead of the
// static import in main.tsx) so the LTR/RTL build can be swapped at runtime.
// It is inserted BEFORE existing stylesheets so custom CSS (app.scss, etc.)
// keeps winning the cascade, matching the old import order in main.tsx.
//
// Dev-only: Vite's dev server also injects ?url-imported CSS as inline
// <style> tags, which would load BOTH bootstrap builds at once (their rules
// then fight, e.g. input-group corner rounding). Remove those duplicates so
// dev renders like the production build, where ?url emits assets only.
if (import.meta.env.DEV) {
  const removeViteInjectedBootstrap = () =>
    document
      .querySelectorAll('style[data-vite-dev-id*="/bootstrap/dist/css/"]')
      .forEach((el) => el.remove());
  removeViteInjectedBootstrap();
  new MutationObserver(removeViteInjectedBootstrap).observe(document.head, { childList: true });
}

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
