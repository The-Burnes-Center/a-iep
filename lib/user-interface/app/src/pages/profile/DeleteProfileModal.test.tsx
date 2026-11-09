/**
 * The account-deletion modal: the close control has a translated name, the
 * irreversible button is the danger one and Cancel is secondary, and the
 * warning icon is inline SVG rather than a web font (the iOS failure the
 * invite page already fixed).
 */
import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import DeleteProfileModal from './DeleteProfileModal';
import { AppContext } from '../../common/app-context';
import { LanguageContext } from '../../common/language-context';
import type { SupportedLanguage } from '../../common/languages';
import type { AppConfig } from '../../common/types';

vi.mock('../../common/api-client/api-client', () => ({
  ApiClient: class {
    profile = { deleteProfile: vi.fn() };
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

const renderModal = () =>
  render(
    <AppContext.Provider value={{ httpEndpoint: 'https://api.example.test/' } as AppConfig}>
      <LanguageContext.Provider value={languageValue}>
        <DeleteProfileModal show onHide={vi.fn()} />
      </LanguageContext.Provider>
    </AppContext.Provider>,
  );

describe('DeleteProfileModal', () => {
  test('the close control is named in the app language, not the library default', () => {
    renderModal();
    const dialog = screen.getByRole('dialog');

    expect(within(dialog).getByRole('button', { name: 'common.close' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  test('the irreversible button is danger and Cancel is secondary', () => {
    renderModal();
    const dialog = screen.getByRole('dialog');

    expect(within(dialog).getByRole('button', { name: 'delete.button.delete' })).toHaveClass('ui-button--danger');
    expect(within(dialog).getByRole('button', { name: 'delete.button.back' })).toHaveClass('ui-button--secondary');
  });

  test('the warning icon is inline SVG, not a web-font glyph', () => {
    const { container } = renderModal();

    expect(container.querySelector('[class*="bi-"]')).toBeNull();
    expect(screen.getByRole('dialog').querySelector('svg.delete-profile-icon')).not.toBeNull();
  });
});
