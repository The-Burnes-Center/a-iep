/**
 * The parent-rights page: one h1, and each right is a real accordion button
 * that starts collapsed.
 */
import React from 'react';
import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ParentRights from './ParentRights';
import { LanguageContext } from '../common/language-context';
import type { SupportedLanguage } from '../common/languages';

const languageValue = {
  language: 'en' as SupportedLanguage,
  setLanguage: () => {},
  t: (key: string) => key,
  translationsLoaded: true,
  enabledLanguages: ['en'] as SupportedLanguage[],
};

describe('ParentRights page', () => {
  test('has one h1, and each right is a collapsed accordion button', () => {
    render(
      <MemoryRouter initialEntries={['/parent-rights']}>
        <LanguageContext.Provider value={languageValue}>
          <ParentRights />
        </LanguageContext.Provider>
      </MemoryRouter>,
    );

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'rights.title' })).toBeInTheDocument();
    const rights = screen.getAllByRole('button', { name: /rights\.slide\d\.title/ });
    expect(rights).toHaveLength(6);
    rights.forEach((right) => expect(right).toHaveAttribute('aria-expanded', 'false'));
  });
});
