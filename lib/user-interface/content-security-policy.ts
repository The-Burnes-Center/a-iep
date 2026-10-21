// The web app's Content-Security-Policy, sent report-only for now.
//
// A wrong policy here does not fail a build; it stops a parent signing in or
// uploading. So it ships as Content-Security-Policy-Report-Only first: the
// browser enforces nothing and logs every request the policy would have
// blocked, and the E2E suite fails on any such log (e2e/helpers/fixtures.ts).
// Switch the header name to enforce once staging and production have run
// clean.
//
// Every origin below is here because the app loads from it today:
//   challenges.cloudflare.com   the Turnstile script and its challenge frame
//   use.typekit.net, p.typekit.net   the Typekit stylesheet and its fonts
//   directus.theburnescenter.org   the About page's team list and photos
//   the HTTP API                 every app request (from aws-exports.json)
//   cognito-idp                  Amplify refreshing a session
//   S3 (regional and global)     presigned upload PUTs and audio playback
//   Google Analytics             production only (analytics-helper.ts)
//   Cloudflare Web Analytics     a beacon script Cloudflare's proxy injects
//                                into the HTML it serves to browsers, in both
//                                environments. It is not in index.html, and
//                                E2E reaches the site through CloudFront and
//                                never sees it (e2e/tests/csp-public.spec.ts
//                                covers it through the public hostname).

import * as fs from "node:fs";
import * as crypto from "node:crypto";

export interface CspOptions {
  /** The HTTP API base URL, e.g. https://abc.execute-api.us-east-1.amazonaws.com/ (may be a CDK token). */
  readonly apiUrl: string;
  /** AWS region, for the Cognito and S3 hosts (may be a CDK token). */
  readonly region: string;
  /** Google Analytics loads only in production. */
  readonly isProduction: boolean;
  /** 'sha256-...' sources for the inline scripts in index.html. */
  readonly inlineScriptHashes: readonly string[];
}

const TURNSTILE = "https://challenges.cloudflare.com";
const TYPEKIT = ["https://use.typekit.net", "https://p.typekit.net"];
const DIRECTUS = "https://directus.theburnescenter.org";
// Cloudflare's published CSP for Web Analytics: the script, and its beacon.
const CLOUDFLARE_INSIGHTS = {
  script: "https://static.cloudflareinsights.com",
  connect: "https://cloudflareinsights.com",
};
// Google's published CSP for GA4 with gtag.js.
const GOOGLE_ANALYTICS = {
  script: ["https://*.googletagmanager.com"],
  img: ["https://*.google-analytics.com", "https://*.googletagmanager.com"],
  connect: [
    "https://*.google-analytics.com",
    "https://*.analytics.google.com",
    "https://*.googletagmanager.com",
  ],
};

// Inline blocks the browser treats as data and never runs, so script-src does
// not apply to them. Only exact types: anything else (no type, a JavaScript
// type, "module") is a script and gets hashed.
const DATA_BLOCK_TYPES = new Set(["application/ld+json"]);

/**
 * sha256 sources for every inline <script> in an HTML file that the browser
 * would run. Read from the source index.html at synth, so editing the script
 * can never leave a stale hash behind; Vite copies inline scripts through
 * byte for byte. Data blocks such as the JSON-LD structured data are skipped.
 */
export function inlineScriptHashes(htmlPath: string): string[] {
  const html = fs.readFileSync(htmlPath, "utf8");
  const inline = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
  return [...html.matchAll(inline)]
    .filter(([, attributes]) => {
      const type = /\btype\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1].trim().toLowerCase();
      return !(type && DATA_BLOCK_TYPES.has(type));
    })
    .map(
      ([, , body]) => `'sha256-${crypto.createHash("sha256").update(body, "utf8").digest("base64")}'`,
    );
}

export function buildContentSecurityPolicy(options: CspOptions): string {
  const { apiUrl, region, isProduction } = options;
  const ga = isProduction ? GOOGLE_ANALYTICS : { script: [], img: [], connect: [] };
  const s3 = [`https://*.s3.${region}.amazonaws.com`, "https://*.s3.amazonaws.com"];

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      ...options.inlineScriptHashes,
      TURNSTILE,
      CLOUDFLARE_INSIGHTS.script,
      ...ga.script,
    ],
    // 'unsafe-inline' for styles only: libraries (Turnstile among them) inject
    // <style> elements, and inline style cannot run code.
    "style-src": ["'self'", "'unsafe-inline'", ...TYPEKIT],
    "font-src": ["'self'", "data:", ...TYPEKIT],
    "img-src": ["'self'", "data:", "blob:", DIRECTUS, ...ga.img],
    "connect-src": [
      "'self'",
      apiUrl,
      `https://cognito-idp.${region}.amazonaws.com`,
      DIRECTUS,
      CLOUDFLARE_INSIGHTS.connect,
      ...s3,
      ...ga.connect,
    ],
    "media-src": ["'self'", "blob:", ...s3],
    "frame-src": [TURNSTILE],
    "worker-src": ["'self'", "blob:"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'self'"],
  };

  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}
