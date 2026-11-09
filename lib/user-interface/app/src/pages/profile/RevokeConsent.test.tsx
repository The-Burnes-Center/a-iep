/**
 * Revoke consent is the page's own confirmation: one h1, the consequences on
 * the page, the danger button as the decision and "Take me back" as the way
 * out.
 */
import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RevokeConsent from './RevokeConsent';
import { AppContext } from '../../common/app-context';
import { LanguageContext } from '../../common/language-context';
import type { SupportedLanguage } from '../../common/languages';
import type { AppConfig } from '../../common/types';

vi.mock('../../common/api-client/api-client', () => ({
  ApiClient: class {
    profile = { updateProfile: vi.fn() };
  },
}));
vi.mock('../../common/auth-provider', () => ({
  useAuth: () => ({ logout: vi.fn(), setAuthenticated: vi.fn() }),
}));

const languageValue = {
  language: 'en' as SupportedLanguage,
  setLanguage: vi.fn(),
  t: (key: string) => key,
  translationsLoaded: true,
  enabledLanguages: ['en'] as SupportedLanguage[],
};

describe('RevokeConsent page', () => {
  test('has one h1, and the revoke button is the danger action with a secondary way out', () => {
    render(
      <MemoryRouter initialEntries={['/revoke-consent']}>
        <AppContext.Provider value={{ httpEndpoint: 'https://api.example.test/' } as AppConfig}>
          <LanguageContext.Provider value={languageValue}>
            <RevokeConsent />
          </LanguageContext.Provider>
        </AppContext.Provider>
      </MemoryRouter>,
    );

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'revoke.title' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'revoke.button.revoke' })).toHaveClass('ui-button--danger');
    expect(screen.getByRole('button', { name: 'revoke.button.back' })).toHaveClass('ui-button--secondary');
  });
});
