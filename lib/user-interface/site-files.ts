// The small well-known files a crawler or security researcher asks every site
// for. Built at synth rather than kept in app/public/, because two of them
// differ per environment and a static copy would ship production's answers to
// staging (or the reverse).
//
// Without them the SPA fallback answered /robots.txt, /sitemap.xml and
// /.well-known/security.txt with index.html and a 200, so a crawler read the
// app's HTML as a robots file, and staging had nothing asking to stay out of
// search results.

const REPO_URL = "https://github.com/The-Burnes-Center/a-iep";

// The pages a parent can reach without signing in, which is all a search
// engine can usefully index. Mirrors the public routes in
// app/src/components/AppRoutes.tsx.
export const PUBLIC_PATHS = [
  "/",
  "/faqs",
  "/about-the-project",
  "/public-privacy-policy",
  "/aiep-hub",
] as const;

// RFC 9116 asks for an Expires under a year away. Twelve months from the start
// of the current month keeps that true and keeps the synth stable within a
// month, so the file is not rewritten by every deploy.
const SECURITY_TXT_VALID_MONTHS = 12;

export interface SiteFilesOptions {
  /** Bare host the site is served on, e.g. "a-iep.org". */
  readonly host: string;
  /** Production is indexed; everything else asks to be left out. */
  readonly isProduction: boolean;
  /** Clock for security.txt's Expires; injectable so tests are stable. */
  readonly now?: Date;
}

export function buildRobotsTxt({ host, isProduction }: SiteFilesOptions): string {
  if (!isProduction) {
    // Staging also sends X-Robots-Tag: noindex (generate-app.ts), which is
    // what removes a page that was already indexed; this keeps polite
    // crawlers from fetching it in the first place.
    return ["# Staging. Not for search engines.", "User-agent: *", "Disallow: /", ""].join("\n");
  }
  return [
    "User-agent: *",
    "Allow: /",
    // Referral links redirect; indexing them only duplicates the landing page.
    "Disallow: /r/",
    "",
    `Sitemap: https://${host}/sitemap.xml`,
    "",
  ].join("\n");
}

export function buildSitemapXml({ host }: SiteFilesOptions): string {
  const urls = PUBLIC_PATHS.map((path) => `  <url><loc>https://${host}${path}</loc></url>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}

export function buildSecurityTxt({ host, now = new Date() }: SiteFilesOptions): string {
  const expires = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + SECURITY_TXT_VALID_MONTHS, 1));
  return [
    `Contact: ${REPO_URL}/security/advisories/new`,
    `Expires: ${expires.toISOString()}`,
    "Preferred-Languages: en",
    `Canonical: https://${host}/.well-known/security.txt`,
    `Policy: ${REPO_URL}/blob/main/SECURITY.md`,
    "",
  ].join("\n");
}
