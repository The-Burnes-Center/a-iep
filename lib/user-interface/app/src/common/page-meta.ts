/**
 * Per-page title, description and canonical link for the public pages, the
 * only ones a search engine can reach.
 *
 * index.html carries the home page's tags, so a crawler that never runs the
 * bundle still reads a real title and description. Every other public page
 * shared them, so search results showed five pages called the same thing.
 * This rewrites them on each public route, in the parent's language, and
 * puts the defaults back when the parent leaves the public pages.
 *
 * The paths mirror PUBLIC_PATHS in lib/user-interface/site-files.ts, which
 * builds the sitemap; page-meta.test.ts fails if the two drift apart.
 */
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useLanguage } from './language-context';

/** Production's origin. Canonical links name it on every environment: staging
 * is noindex, and a canonical pointing at itself would only invite indexing. */
export const SITE_ORIGIN = 'https://a-iep.org';

export interface PageMetaKeys {
  title: string;
  description: string;
}

export const PUBLIC_PAGE_META: Record<string, PageMetaKeys> = {
  '/': { title: 'meta.home.title', description: 'meta.home.description' },
  '/faqs': { title: 'meta.faqs.title', description: 'meta.faqs.description' },
  '/about-the-project': { title: 'meta.about.title', description: 'meta.about.description' },
  '/public-privacy-policy': { title: 'meta.privacy.title', description: 'meta.privacy.description' },
  '/aiep-hub': { title: 'meta.hub.title', description: 'meta.hub.description' },
};

export interface PageMeta {
  title: string;
  description: string;
  canonicalUrl: string;
}

function setMeta(doc: Document, selector: string, attribute: 'name' | 'property', key: string, value: string) {
  let tag = doc.head.querySelector<HTMLMetaElement>(selector);
  if (!tag) {
    tag = doc.createElement('meta');
    tag.setAttribute(attribute, key);
    doc.head.appendChild(tag);
  }
  tag.content = value;
}

function setCanonical(doc: Document, href: string) {
  let link = doc.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!link) {
    link = doc.createElement('link');
    link.rel = 'canonical';
    doc.head.appendChild(link);
  }
  link.href = href;
}

export function applyPageMeta(meta: PageMeta, doc: Document = document): void {
  doc.title = meta.title;
  setMeta(doc, 'meta[name="description"]', 'name', 'description', meta.description);
  setMeta(doc, 'meta[property="og:title"]', 'property', 'og:title', meta.title);
  setMeta(doc, 'meta[property="og:description"]', 'property', 'og:description', meta.description);
  setMeta(doc, 'meta[property="og:url"]', 'property', 'og:url', meta.canonicalUrl);
  setCanonical(doc, meta.canonicalUrl);
}

/** What index.html shipped with, so leaving the public pages restores it. */
export function readPageMeta(doc: Document = document): PageMeta {
  return {
    title: doc.title,
    description: doc.head.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ?? '',
    canonicalUrl: doc.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? `${SITE_ORIGIN}/`,
  };
}

/**
 * Keep the tags in step with the current public route and language. Used by
 * PublicChrome, so it runs for every public page and only for those.
 */
export function usePublicPageMeta(): void {
  const { pathname } = useLocation();
  const { t, translationsLoaded } = useLanguage();

  useEffect(() => {
    const keys = PUBLIC_PAGE_META[pathname];
    // An unknown path (a typo, a removed page) keeps the defaults rather than
    // claiming a canonical URL that does not exist.
    if (!keys || !translationsLoaded) return undefined;
    const defaults = readPageMeta();
    applyPageMeta({
      title: t(keys.title),
      description: t(keys.description),
      canonicalUrl: `${SITE_ORIGIN}${pathname}`,
    });
    return () => applyPageMeta(defaults);
  }, [pathname, t, translationsLoaded]);
}
