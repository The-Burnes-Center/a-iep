/**
 * Per-page title, description and canonical link for the public pages
 * (common/page-meta.ts). Search results used to show every public page as
 * "AIEP" with the same one-line description.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import * as fs from "fs";
import * as path from "path";
import { LanguageContext } from "./language-context";
import type { SupportedLanguage } from "./languages";
import { PUBLIC_PAGE_META, SITE_ORIGIN, applyPageMeta, readPageMeta, usePublicPageMeta } from "./page-meta";
import { PUBLIC_PATHS } from "../../../site-files";
import en from "../translations/en.json";

const INDEX_HTML = fs.readFileSync(path.join(__dirname, "..", "..", "index.html"), "utf8");
const DEFAULTS = {
  title: "A-IEP: understand your child's IEP in plain language",
  description: "Default description",
  canonicalUrl: `${SITE_ORIGIN}/`,
};

const translated = (key: string) => `[${key}]`;
const languageValue = {
  language: "en" as SupportedLanguage,
  setLanguage: vi.fn(),
  t: translated,
  translationsLoaded: true,
  enabledLanguages: ["en"] as SupportedLanguage[],
};

const head = () => ({
  title: document.title,
  description: document.head.querySelector<HTMLMetaElement>('meta[name="description"]')?.content,
  ogTitle: document.head.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content,
  ogUrl: document.head.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content,
  canonical: document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href,
});

function Public() {
  usePublicPageMeta();
  return null;
}

let goTo: (to: string) => void = () => {};
function Navigator() {
  const navigate = useNavigate();
  useEffect(() => {
    goTo = navigate;
  }, [navigate]);
  return null;
}

function renderAt(initialPath: string, loaded = true) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <LanguageContext.Provider value={{ ...languageValue, translationsLoaded: loaded }}>
        <Navigator />
        <Routes>
          {Object.keys(PUBLIC_PAGE_META).map((p) => (
            <Route key={p} path={p} element={<Public />} />
          ))}
          <Route path="/not-a-page" element={<Public />} />
          <Route path="/iep-documents" element={null} />
        </Routes>
      </LanguageContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  document.head.innerHTML = "";
  applyPageMeta(DEFAULTS);
});

afterEach(cleanup);

describe("the public page list", () => {
  test("matches the sitemap, so every indexed page has its own title", () => {
    expect(Object.keys(PUBLIC_PAGE_META).sort()).toEqual([...PUBLIC_PATHS].sort());
  });

  test("every key has English copy", () => {
    const dictionary = en as Record<string, string>;
    for (const { title, description } of Object.values(PUBLIC_PAGE_META)) {
      expect(dictionary[title], title).toBeTruthy();
      expect(dictionary[description], description).toBeTruthy();
    }
  });

  test("index.html carries the home page's English copy for crawlers that run no JS", () => {
    const decode = (s: string) => s.replace(/&#39;/g, "'");
    const dictionary = en as Record<string, string>;
    expect(decode(INDEX_HTML)).toContain(`<title>${dictionary["meta.home.title"]}</title>`);
    expect(decode(INDEX_HTML)).toContain(`name="description" content="${dictionary["meta.home.description"]}"`);
    expect(INDEX_HTML).toContain('<link rel="canonical" href="https://a-iep.org/" />');
  });
});

describe("usePublicPageMeta", () => {
  test.each(Object.entries(PUBLIC_PAGE_META))("%s gets its own title, description and canonical", (p, keys) => {
    renderAt(p);
    expect(head()).toEqual({
      title: translated(keys.title),
      description: translated(keys.description),
      ogTitle: translated(keys.title),
      ogUrl: `${SITE_ORIGIN}${p}`,
      canonical: `${SITE_ORIGIN}${p}`,
    });
  });

  test("moving between public pages follows the route", async () => {
    renderAt("/");
    goTo("/faqs");
    await vi.waitFor(() => expect(head().canonical).toBe(`${SITE_ORIGIN}/faqs`));
    expect(head().title).toBe(translated("meta.faqs.title"));
  });

  test("leaving the public pages puts the home page's tags back", async () => {
    // The home page's, in the parent's language: index.html carries those
    // same tags in English, and they are what a signed-in page shows.
    renderAt("/faqs");
    goTo("/iep-documents");
    await vi.waitFor(() => expect(head().title).toBe(translated("meta.home.title")));
    expect(head().canonical).toBe(`${SITE_ORIGIN}/`);
    expect(head().description).toBe(translated("meta.home.description"));
  });

  test("a prerendered page's own head does not follow the parent into the app", async () => {
    // faqs.html ships with the FAQ page's tags already in <head>
    // (src/prerender/page-html.ts). Restoring "whatever was there before"
    // would put them back on every signed-in screen after the parent left.
    applyPageMeta({ title: "FAQ tags", description: "FAQ description", canonicalUrl: `${SITE_ORIGIN}/faqs` });
    renderAt("/faqs");
    goTo("/iep-documents");
    await vi.waitFor(() => expect(head().title).toBe(translated("meta.home.title")));
    expect(head().canonical).toBe(`${SITE_ORIGIN}/`);
  });

  test("an unknown path keeps the defaults rather than claiming a canonical", () => {
    renderAt("/not-a-page");
    expect(head().title).toBe(DEFAULTS.title);
    expect(head().canonical).toBe(DEFAULTS.canonicalUrl);
  });

  test("waits for the translations instead of writing raw keys", () => {
    renderAt("/faqs", false);
    expect(head().title).toBe(DEFAULTS.title);
  });
});

describe("applyPageMeta / readPageMeta", () => {
  test("creates the tags when the document has none, and reads them back", () => {
    document.head.innerHTML = "";
    const meta = { title: "T", description: "D", canonicalUrl: `${SITE_ORIGIN}/faqs` };
    applyPageMeta(meta);
    expect(readPageMeta()).toEqual(meta);
    expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
    applyPageMeta(meta);
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
  });
});
