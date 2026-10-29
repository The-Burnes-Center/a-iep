/**
 * Renders each public page to static markup at build time, with the real
 * routes and components, so the copy a crawler reads is the copy the app
 * shows and cannot drift from it. scripts/prerender.mjs runs this after
 * `vite build` and writes the files; page-html.ts says where the markup goes
 * and why.
 *
 * The render is a signed-out visitor in English on production's feature set:
 * that is who a crawler of a-iep.org is. Effects do not run in a server
 * render, so nothing here signs in, fetches, or touches Amplify.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppContext } from '../common/app-context';
import { LanguageContext } from '../common/language-context';
import { AuthProvider } from '../common/auth-provider';
import { PUBLIC_PAGE_META } from '../common/page-meta';
import type { Feature } from '../common/features';
import type { AppConfig } from '../common/types';
import AppRoutes from '../components/AppRoutes';
import en from '../translations/en.json';
import {
  APP_SHELL_FILE,
  NOT_FOUND_FILE,
  buildPageHtml,
  canonicalUrlFor,
  prerenderedFile,
} from './page-html';

/** PROD_FEATURES in vite.config.ts; test/infra/enabled-features.test.ts
 * keeps the two equal. */
export const PRERENDER_FEATURES: Feature[] = ['referrals', 'studentNameGate', 'passwordlessAuth'];

const dictionary = en as Record<string, string>;
const t = (key: string) => dictionary[key] || key;

const CONFIG = { enabledLanguages: ['en'], enabledFeatures: PRERENDER_FEATURES } as unknown as AppConfig;

export function renderPage(publicPath: string): string {
  return renderToStaticMarkup(
    <AppContext.Provider value={CONFIG}>
      <LanguageContext.Provider
        value={{ language: 'en', setLanguage: () => {}, t, translationsLoaded: true, enabledLanguages: ['en'] }}
      >
        <AuthProvider>
          <QueryClientProvider client={new QueryClient()}>
            <MemoryRouter initialEntries={[publicPath]}>
              <AppRoutes />
            </MemoryRouter>
          </QueryClientProvider>
        </AuthProvider>
      </LanguageContext.Provider>
    </AppContext.Provider>,
  );
}

// For readers without JavaScript only: a browser running the app follows the
// router's catch-all to the home page, as it always has.
const NOT_FOUND_MARKUP = renderToStaticMarkup(
  <main>
    <h1>Page not found</h1>
    <p>There is no page at this address on A-IEP, the free tool that helps parents understand their child’s IEP.</p>
    <ul>
      <li><a href="/">Home</a></li>
      <li><a href="/faqs">Frequently asked questions</a></li>
      <li><a href="/sitemap.xml">Every public page</a></li>
    </ul>
  </main>,
);

// For readers without JavaScript on an app screen (sign-in, the account
// pages): there is nothing to show without the app, so point at what there is.
const APP_SHELL_MARKUP = renderToStaticMarkup(
  <main>
    <p>This part of A-IEP, the free tool that helps parents understand their child’s IEP, works only with JavaScript.</p>
    <ul>
      <li><a href="/">Home</a></li>
      <li><a href="/faqs">Frequently asked questions</a></li>
    </ul>
  </main>,
);

export interface PrerenderedFile {
  file: string;
  html: string;
}

/** Every file the build adds: one per public page, 404.html and app.html. */
export function buildPrerenderedFiles(template: string): PrerenderedFile[] {
  const pages = Object.entries(PUBLIC_PAGE_META).map(([publicPath, keys]) => ({
    file: prerenderedFile(publicPath),
    html: buildPageHtml(
      template,
      { title: t(keys.title), description: t(keys.description), canonicalUrl: canonicalUrlFor(publicPath) },
      renderPage(publicPath),
    ),
  }));
  const notFound = {
    file: NOT_FOUND_FILE,
    html: buildPageHtml(
      template,
      { title: 'Page not found | A-IEP', description: t('meta.home.description'), noindex: true },
      NOT_FOUND_MARKUP,
    ),
  };
  const appShell = {
    file: APP_SHELL_FILE,
    html: buildPageHtml(
      template,
      { title: t('meta.home.title'), description: t('meta.home.description'), noindex: true },
      APP_SHELL_MARKUP,
    ),
  };
  return [...pages, notFound, appShell];
}
