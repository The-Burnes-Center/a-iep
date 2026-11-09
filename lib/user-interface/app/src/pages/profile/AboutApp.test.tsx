/**
 * The privacy policy row on the About page is a real link, reachable by
 * keyboard and announced as a link, not a click-only div.
 */
import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AboutApp from './AboutApp';
import { AppContext } from '../../common/app-context';
import { LanguageContext } from '../../common/language-context';
import type { SupportedLanguage } from '../../common/languages';
import type { AppConfig } from '../../common/types';

vi.mock('../../common/api-client/api-client', () => ({
  ApiClient: class {
    team = { getTeamMembersInfo: vi.fn().mockResolvedValue({ team: [] }) };
  },
}));
// The landing sections are their own screens; only the privacy row is under test.
vi.mock('../../components/LandingHeroSection', () => ({ default: () => null }));
vi.mock('../../components/GreenSection', () => ({ default: () => null }));
vi.mock('../../components/LandingContainer', () => ({ default: () => null }));
vi.mock('../../components/LandingContainerBottom', () => ({ default: () => null }));
vi.mock('../../components/TransparentHeader', () => ({ default: () => null }));

const languageValue = {
  language: 'en' as SupportedLanguage,
  setLanguage: () => {},
  t: (key: string) => key,
  translationsLoaded: true,
  enabledLanguages: ['en'] as SupportedLanguage[],
};

const renderAbout = (showBreadcrumbs: boolean) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AppContext.Provider value={{ httpEndpoint: 'https://api.example.test/' } as AppConfig}>
          <LanguageContext.Provider value={languageValue}>
            <AboutApp showBreadcrumbs={showBreadcrumbs} />
          </LanguageContext.Provider>
        </AppContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
};

describe('AboutApp privacy policy row', () => {
  test('is a link to the signed-in privacy policy', () => {
    renderAbout(true);
    expect(screen.getByRole('link', { name: 'about.privacyPolicy' })).toHaveAttribute('href', '/privacy-policy');
  });

  test('is a link to the public privacy policy on the public copy of the page', () => {
    renderAbout(false);
    expect(screen.getByRole('link', { name: 'about.privacyPolicy' })).toHaveAttribute('href', '/public-privacy-policy');
  });
});
