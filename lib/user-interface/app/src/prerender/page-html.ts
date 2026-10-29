/**
 * Turns the built index.html into one HTML file per public page, for readers
 * that never run the bundle: search crawlers, AI assistants, link previews
 * and the rare parent with JavaScript off. Before this every page was the
 * same empty <div id="root">, so they saw a title and nothing else.
 *
 * The page's own markup goes inside <noscript>. A browser running scripts
 * never parses it, so a parent sees exactly what they saw before: no flash
 * of a static copy, and no English snapshot showing for a moment before the
 * app switches to their language. Each file also gets its page's own title,
 * description and canonical link, which page-meta.ts sets once the app runs.
 *
 * File names mirror lib/user-interface/edge-routing.ts, the CloudFront
 * Function that sends each path to its file. Declared twice because CDK's
 * container build copies only app/, so nothing built may import from above
 * it; prerender.test.tsx pins the two equal.
 */
import { SITE_ORIGIN } from '../common/page-meta';

export const NOT_FOUND_FILE = '404.html';

/** Every signed-in or redirect-only route (edge-routing.ts APP_ROUTES). The
 * app's shell with noindex: /login, /profile and the rest are screens of the
 * app, not pages, and answering them with the home page's file made each one
 * an indexable duplicate of the home page. */
export const APP_SHELL_FILE = 'app.html';

export function prerenderedFile(publicPath: string): string {
  return publicPath === '/' ? 'index.html' : `${publicPath.slice(1)}.html`;
}

export interface PageHead {
  title: string;
  description: string;
  /** Omitted for the 404 page, which is not anywhere a link should point. */
  canonicalUrl?: string;
  noindex?: boolean;
}

export const NO_SCRIPT_NOTICE =
  'A-IEP needs JavaScript to sign in and read your child’s IEP. Turn JavaScript on in your browser to use it. The rest of this page is below.';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Replace exactly one match, or fail the build: a template that changed
 * shape must not ship pages with the home page's tags. */
function replaceOnce(html: string, pattern: RegExp, replacement: string, what: string): string {
  const matches = html.match(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`)) ?? [];
  if (matches.length !== 1) {
    throw new Error(`prerender: expected exactly one ${what} in index.html, found ${matches.length}`);
  }
  return html.replace(pattern, replacement);
}

function metaTag(attribute: 'name' | 'property', key: string): RegExp {
  return new RegExp(`<meta\\s+${attribute}="${key.replace(':', '\\:')}"\\s+content="[^"]*"\\s*/?>`);
}

export function buildPageHtml(template: string, head: PageHead, bodyMarkup: string): string {
  const title = escapeHtml(head.title);
  const description = escapeHtml(head.description);
  let html = template;
  html = replaceOnce(html, /<title>[^<]*<\/title>/, `<title>${title}</title>`, '<title>');
  html = replaceOnce(html, metaTag('name', 'description'), `<meta name="description" content="${description}" />`, 'description');
  html = replaceOnce(html, metaTag('property', 'og:title'), `<meta property="og:title" content="${title}" />`, 'og:title');
  html = replaceOnce(html, metaTag('property', 'og:description'), `<meta property="og:description" content="${description}" />`, 'og:description');
  const canonical = head.canonicalUrl ? escapeHtml(head.canonicalUrl) : undefined;
  html = replaceOnce(html, metaTag('property', 'og:url'),
    canonical ? `<meta property="og:url" content="${canonical}" />` : '', 'og:url');
  html = replaceOnce(html, /<link\s+rel="canonical"\s+href="[^"]*"\s*\/?>/,
    canonical ? `<link rel="canonical" href="${canonical}" />` : '', 'canonical link');
  if (head.noindex) {
    html = replaceOnce(html, /<\/title>/, '</title>\n    <meta name="robots" content="noindex" />', '</title>');
  }
  const noscript = `<noscript><p>${escapeHtml(NO_SCRIPT_NOTICE)}</p>${bodyMarkup}</noscript>`;
  return replaceOnce(html, /<div id="root"><\/div>/, `${noscript}\n    <div id="root"></div>`, '<div id="root">');
}

export function canonicalUrlFor(publicPath: string): string {
  return `${SITE_ORIGIN}${publicPath}`;
}
