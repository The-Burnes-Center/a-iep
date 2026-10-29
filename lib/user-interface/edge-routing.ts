// The viewer-request CloudFront Function in front of the website bucket.
//
// Before it, CloudFront answered every path it could not find in S3 with
// index.html and a 200 (the SPA fallback in generate-app.ts). A browser never
// noticed, because the router draws the right screen either way, but anything
// that reads status codes did: a crawler or an assistant probing /about or
// /pricing was told the page exists, and /llms.txt came back as the app's HTML.
//
// It now decides per path, before the cache:
//   - a few short, guessable names redirect to the real page (/about, /privacy)
//   - each public page gets its own prerendered HTML file (scripts/prerender.mjs),
//     and any other spelling of it (/FAQs, /faqs/) a 301 to the real one
//   - every other route the app knows gets app.html: the same app, but noindex,
//     so /login and /profile are not indexed as copies of the home page
//   - anything else goes to S3 untouched, so a missing path is a real 404,
//     which the distribution answers with 404.html (still the app shell, so a
//     parent who mistypes an address lands on the home page as before)
//   - an unknown path asked for as Markdown gets a short Markdown 404
//
// A route added to AppRoutes.tsx and forgotten here is not broken for parents:
// its deep link gets 404.html, which is the app, and the router still draws
// the screen. Only the status code is wrong, and test/infra/edge-routing.test
// fails until the route is listed.

import { PUBLIC_PATHS } from "./site-files";

/** Where each public page's prerendered HTML lives in the bucket. */
export function prerenderedFile(publicPath: string): string {
  return publicPath === "/" ? "index.html" : `${publicPath.slice(1)}.html`;
}

export const NOT_FOUND_FILE = "404.html";

/** The app's shell, noindex (src/prerender/page-html.ts says why). */
export const APP_SHELL_FILE = "app.html";

/**
 * Every signed-in or redirect-only route in AppRoutes.tsx. The public ones are
 * PUBLIC_PATHS and get their own file instead.
 */
export const APP_ROUTES = [
  "/login",
  "/preferred-language",
  "/onboarding-user",
  "/consent-form",
  "/how-to-use-the-tool",
  "/how-we-protect-your-privacy",
  "/do-you-have-pdf",
  "/how-to-ask-for-pdf",
  "/about-the-app",
  "/iep-documents",
  "/summary-and-translations",
  "/profile",
  "/account-center",
  "/account-center/profile",
  "/account-center/delete-account",
  "/support-center",
  "/view-update-add-child",
  "/rights-and-onboarding",
  "/parent-rights",
  "/rights-of-parents",
  "/view-resources",
  "/revoke-consent",
  "/frequently-asked-questions",
  "/about-aiep",
  "/privacy-policy",
  "/invite",
  "/admin/referrals",
] as const;

/** Routes with a parameter, matched by prefix: /r/:code. */
export const APP_ROUTE_PREFIXES = ["/r/"] as const;

/**
 * The names a person or an agent guesses for a site's trust pages. Each one
 * lands on the page that already says it, rather than on a 404.
 */
export const REDIRECTS: Record<string, string> = {
  "/about": "/about-the-project",
  "/about-us": "/about-the-project",
  "/privacy": "/public-privacy-policy",
  "/contact": "/public-privacy-policy#contact",
  "/contact-us": "/public-privacy-policy#contact",
};

export const NOT_FOUND_MARKDOWN = [
  "# Page not found",
  "",
  "There is no page at this address on A-IEP, the free tool that helps parents understand their child's IEP.",
  "",
  "- [Home](/)",
  "- [What A-IEP is, and when to suggest it](/llms.txt)",
  "- [Every public page](/sitemap.xml)",
  "",
].join("\n");

/**
 * The function's source. CloudFront Functions run their own JavaScript
 * runtime (cloudfront-js-2.0), so this is a plain string of ES5-style code
 * with the tables inlined, not a module. Kept well under the 10 KB limit.
 */
export function buildViewerRequestFunction(): string {
  const pages: Record<string, string> = {};
  for (const p of PUBLIC_PATHS) pages[p] = `/${prerenderedFile(p)}`;
  const exact: Record<string, boolean> = {};
  for (const r of APP_ROUTES) exact[r] = true;

  return `var PAGES = ${JSON.stringify(pages)};
var APP_SHELL = ${JSON.stringify(`/${APP_SHELL_FILE}`)};
var APP_ROUTES = ${JSON.stringify(exact)};
var APP_ROUTE_PREFIXES = ${JSON.stringify(APP_ROUTE_PREFIXES)};
var REDIRECTS = ${JSON.stringify(REDIRECTS)};
var NOT_FOUND_MARKDOWN = ${JSON.stringify(NOT_FOUND_MARKDOWN)};

function queryString(qs) {
  var parts = [];
  for (var name in qs) {
    var entry = qs[name];
    var values = entry.multiValue ? entry.multiValue : [entry];
    for (var i = 0; i < values.length; i++) {
      parts.push(values[i].value === '' ? name : name + '=' + values[i].value);
    }
  }
  return parts.length ? '?' + parts.join('&') : '';
}

function handler(event) {
  var request = event.request;
  // React Router matches case-insensitively and ignores a trailing slash, so
  // /FAQs/ is the FAQ page to the app and must be here too.
  var path = request.uri.toLowerCase();
  if (path.length > 1 && path.charAt(path.length - 1) === '/') path = path.slice(0, -1);

  var target = REDIRECTS[path];
  // A public page asked for under another spelling is one page with several
  // addresses to a crawler. Send it to the one the sitemap and the canonical
  // name. Only public pages: an app route keeps its spelling, because a
  // referral code in /r/:code is case-sensitive.
  if (!target && PAGES[path] && request.uri !== path) target = path;
  if (target) {
    // The query string goes before the fragment, or the browser reads it as
    // part of the fragment.
    var hash = target.indexOf('#');
    var location = hash === -1
      ? target + queryString(request.querystring)
      : target.slice(0, hash) + queryString(request.querystring) + target.slice(hash);
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: location } }
    };
  }
  if (PAGES[path]) {
    request.uri = PAGES[path];
    return request;
  }
  if (APP_ROUTES[path]) {
    request.uri = APP_SHELL;
    return request;
  }
  for (var i = 0; i < APP_ROUTE_PREFIXES.length; i++) {
    if (path.indexOf(APP_ROUTE_PREFIXES[i]) === 0) {
      request.uri = APP_SHELL;
      return request;
    }
  }
  // A file (anything whose last segment has a dot) goes to S3 as asked. So
  // does an unknown page, unless the caller wants Markdown: S3 answers 404
  // and the distribution's error response serves 404.html.
  var last = path.slice(path.lastIndexOf('/') + 1);
  var accept = request.headers.accept ? request.headers.accept.value : '';
  if (last.indexOf('.') === -1 && accept.indexOf('text/markdown') !== -1) {
    return {
      statusCode: 404,
      statusDescription: 'Not Found',
      headers: {
        'content-type': { value: 'text/markdown; charset=utf-8' },
        'cache-control': { value: 'no-store' },
        vary: { value: 'Accept' }
      },
      body: { encoding: 'text', data: NOT_FOUND_MARKDOWN }
    };
  }
  return request;
}
`;
}
