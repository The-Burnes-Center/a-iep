/**
 * The viewer-request CloudFront Function (lib/user-interface/edge-routing.ts).
 *
 * The function's source is a string CloudFront runs in its own runtime, so
 * these tests run that exact string: they build it, evaluate it, and call
 * handler() with events shaped like the ones CloudFront sends
 * (https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-event-structure.html).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  APP_ROUTES,
  APP_ROUTE_PREFIXES,
  NOT_FOUND_MARKDOWN,
  REDIRECTS,
  buildViewerRequestFunction,
  prerenderedFile,
} from '../../lib/user-interface/edge-routing';
import { PUBLIC_PATHS } from '../../lib/user-interface/site-files';

type Handler = (event: unknown) => any;
const source = buildViewerRequestFunction();
// eslint-disable-next-line @typescript-eslint/no-implied-eval -- running the shipped string is the point
const handler = new Function(`${source}\nreturn handler;`)() as Handler;

function request(uri: string, opts: { accept?: string; querystring?: Record<string, unknown> } = {}) {
  return handler({
    version: '1.0',
    context: { eventType: 'viewer-request' },
    viewer: { ip: '192.0.2.1' },
    request: {
      method: 'GET',
      uri,
      querystring: opts.querystring ?? {},
      headers: opts.accept ? { accept: { value: opts.accept } } : {},
      cookies: {},
    },
  });
}

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

describe('public pages get their prerendered file', () => {
  test.each(PUBLIC_PATHS.map((p) => [p, `/${prerenderedFile(p)}`]))('%s -> %s', (p, file) => {
    expect(request(p, { accept: BROWSER_ACCEPT }).uri).toBe(file);
  });

  test('matches the way the router does: any case, trailing slash or not', () => {
    expect(request('/FAQs/').uri).toBe('/faqs.html');
    expect(request('/About-The-Project').uri).toBe('/about-the-project.html');
  });
});

describe('the app routes still get the app', () => {
  test.each([...APP_ROUTES])('%s -> /index.html', (route) => {
    expect(request(route).uri).toBe('/index.html');
  });

  test('a referral link, whatever its code, gets the app', () => {
    expect(request('/r/AbC123').uri).toBe('/index.html');
  });

  test('every route in AppRoutes.tsx is covered, so none of them 404s', () => {
    // The drift this guards: a route added to the router and not here still
    // works for parents (404.html is the app) but answers with a 404 status.
    const routes = fs.readFileSync(
      path.join(__dirname, '../../lib/user-interface/app/src/components/AppRoutes.tsx'), 'utf8');
    const paths = [...routes.matchAll(/path="([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== '*');
    expect(paths.length).toBeGreaterThan(30);
    for (const p of paths) {
      const prefix = APP_ROUTE_PREFIXES.find((pre) => p.startsWith(pre));
      const probe = prefix ? `${prefix}example` : p;
      const routed = request(probe).uri;
      expect([probe, routed]).toEqual([probe, expect.stringMatching(/^\/[a-z-]+\.html$/)]);
    }
  });
});

describe('files and unknown paths go to S3 untouched', () => {
  test.each(['/assets/index-abc123.js', '/aws-exports.json', '/llms.txt', '/.well-known/security.txt', '/images/Logo.png'])(
    '%s is passed through as asked', (uri) => {
      expect(request(uri, { accept: BROWSER_ACCEPT }).uri).toBe(uri);
    });

  test('an unknown page goes to S3 as asked, which 404s', () => {
    // Not rewritten to index.html: that rewrite was the soft 404.
    expect(request('/pricing', { accept: BROWSER_ACCEPT }).uri).toBe('/pricing');
    expect(request('/welcome-page').uri).toBe('/welcome-page');
  });

  test('an unknown page asked for as Markdown gets a Markdown 404', () => {
    const response = request('/pricing', { accept: 'text/markdown' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type'].value).toBe('text/markdown; charset=utf-8');
    expect(response.headers.vary.value).toBe('Accept');
    expect(response.body).toEqual({ encoding: 'text', data: NOT_FOUND_MARKDOWN });
    expect(NOT_FOUND_MARKDOWN).toMatch(/^# Page not found\n/);
    expect(NOT_FOUND_MARKDOWN).toContain('(/llms.txt)');
    expect(NOT_FOUND_MARKDOWN).toContain('(/sitemap.xml)');
  });

  test('a real page asked for as Markdown is still the page, not a 404', () => {
    expect(request('/', { accept: 'text/markdown' }).uri).toBe('/index.html');
    expect(request('/summary-and-translations', { accept: 'text/markdown' }).uri).toBe('/index.html');
  });
});

describe('trust-page redirects', () => {
  test.each(Object.entries(REDIRECTS))('%s -> 301 %s', (from, to) => {
    const response = request(from);
    expect(response.statusCode).toBe(301);
    expect(response.headers.location.value).toBe(to);
  });

  test('every redirect lands on a public page', () => {
    for (const to of Object.values(REDIRECTS)) {
      expect(PUBLIC_PATHS).toContain(to.split('#')[0]);
    }
  });

  test('the query string survives, and goes before the fragment', () => {
    const qs = { ref: { value: 'ABC' }, utm: { value: 'x', multiValue: [{ value: 'x' }, { value: 'y' }] } };
    expect(request('/about', { querystring: qs }).headers.location.value)
      .toBe('/about-the-project?ref=ABC&utm=x&utm=y');
    expect(request('/contact', { querystring: { ref: { value: 'ABC' } } }).headers.location.value)
      .toBe('/public-privacy-policy?ref=ABC#contact');
  });
});

test('fits the CloudFront Functions code-size limit with room to spare', () => {
  // The hard limit is 10 KB; staying under half leaves room for routes.
  expect(Buffer.byteLength(source, 'utf8')).toBeLessThan(5 * 1024);
});
