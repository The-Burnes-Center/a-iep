/**
 * Which landing-page images load eagerly.
 *
 * The hero illustration is the only image in the first viewport, so it is the
 * only one that may load eagerly. Everything below it (the banners, the
 * how-to cards, the parent-rights slides, the resources stripe) is
 * loading="lazy", so the first paint does not wait on about 2.8 MB of images
 * the parent may never scroll to.
 */
import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LandingPage from './LandingPage';
import { LanguageContext } from '../common/language-context';
import type { SupportedLanguage } from '../common/languages';

// The sign-in form drags in Amplify and Turnstile. It is not what is under
// test here, only the images around it.
vi.mock('../components/CustomLogin', () => ({
  default: () => <div>sign in form</div>,
}));

const authState = vi.hoisted(() => ({ current: { authenticated: false, loading: false } }));
vi.mock('../common/auth-provider', () => ({
  useAuth: () => authState.current,
}));

const languageValue = {
  language: 'en' as SupportedLanguage,
  setLanguage: vi.fn(),
  t: (key: string) => key,
  translationsLoaded: true,
  enabledLanguages: ['en'] as SupportedLanguage[],
};

const HERO_IMAGE = '/images/hero-section-image.png';

describe('landing page image loading', () => {
  test('only the hero illustration loads eagerly', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <LanguageContext.Provider value={languageValue}>
          <LandingPage />
        </LanguageContext.Provider>
      </MemoryRouter>,
    );

    const images = Array.from(container.querySelectorAll('img'));
    expect(images.length).toBeGreaterThan(5);

    const eager = images.filter((img) => img.getAttribute('loading') !== 'lazy');
    expect(eager.map((img) => img.getAttribute('src'))).toEqual([HERO_IMAGE]);
  });

  test('every below-the-fold image is lazy and decodes off the main thread', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <LanguageContext.Provider value={languageValue}>
          <LandingPage />
        </LanguageContext.Provider>
      </MemoryRouter>,
    );

    const belowFold = Array.from(container.querySelectorAll('img')).filter(
      (img) => img.getAttribute('src') !== HERO_IMAGE,
    );
    expect(belowFold.length).toBeGreaterThan(0);
    for (const img of belowFold) {
      expect(img).toHaveAttribute('loading', 'lazy');
      expect(img).toHaveAttribute('decoding', 'async');
    }
  });
});
