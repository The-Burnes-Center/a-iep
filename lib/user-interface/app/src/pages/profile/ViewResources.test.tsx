/**
 * The four resource links all say "View resources", so each one carries its
 * resource's title in its accessible name. A screen reader user hears which
 * document a link opens, and each link opens in a new tab.
 */
import React from 'react';
import { describe, expect, test } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ViewResources from './ViewResources';
import { LanguageContext } from '../../common/language-context';
import type { SupportedLanguage } from '../../common/languages';

const languageValue = {
  language: 'en' as SupportedLanguage,
  setLanguage: () => {},
  t: (key: string) => key,
  translationsLoaded: true,
  enabledLanguages: ['en'] as SupportedLanguage[],
};

describe('ViewResources page', () => {
  test('each resource link has its own accessible name and opens in a new tab', () => {
    render(
      <MemoryRouter initialEntries={['/view-resources']}>
        <LanguageContext.Provider value={languageValue}>
          <ViewResources />
        </LanguageContext.Provider>
      </MemoryRouter>,
    );

    const links = screen.getAllByRole('link', { name: /resources\.buttonText/ });
    expect(links).toHaveLength(4);
    const names = links.map((link) => link.textContent);
    expect(new Set(names).size).toBe(4);
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  test('the page has one h1 and each resource is a card with a heading', () => {
    render(
      <MemoryRouter initialEntries={['/view-resources']}>
        <LanguageContext.Provider value={languageValue}>
          <ViewResources />
        </LanguageContext.Provider>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'resources.title' })).toBeInTheDocument();
    const cards = document.querySelectorAll('.resource-item');
    expect(cards).toHaveLength(4);
    cards.forEach((card) => expect(within(card as HTMLElement).getByRole('heading', { level: 2 })).toBeInTheDocument());
  });
});
