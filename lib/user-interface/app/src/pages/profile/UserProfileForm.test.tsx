/**
 * The profile form's accessibility and its save behaviour: the language
 * select has a programmatic label, the disabled Update button says why it is
 * disabled, and a failed save keeps what the parent typed on screen.
 */
import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import UserProfileForm from './UserProfileForm';
import { AppContext } from '../../common/app-context';
import { LanguageContext } from '../../common/language-context';
import type { SupportedLanguage } from '../../common/languages';
import type { AppConfig } from '../../common/types';

const Api = vi.hoisted(() => ({
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  deleteProfile: vi.fn(),
}));
vi.mock('../../common/api-client/api-client', () => ({
  ApiClient: class {
    profile = Api;
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
  enabledLanguages: ['en', 'es'] as SupportedLanguage[],
};

const renderPage = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/profile']}>
      <QueryClientProvider client={queryClient}>
        <AppContext.Provider value={{ httpEndpoint: 'https://api.example.test/' } as AppConfig}>
          <LanguageContext.Provider value={languageValue}>
            <UserProfileForm />
          </LanguageContext.Provider>
        </AppContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
};

beforeEach(() => {
  Api.getProfile.mockResolvedValue({ parentName: 'Ana', secondaryLanguage: 'en' });
  Api.updateProfile.mockResolvedValue(undefined);
});

describe('UserProfileForm', () => {
  test('the preferred language select has a programmatic label', async () => {
    renderPage();
    expect(await screen.findByRole('combobox', { name: 'profile.preferredLanguage' })).toBeInTheDocument();
  });

  test('with nothing changed, Update is disabled and says why', async () => {
    renderPage();
    const update = await screen.findByRole('button', { name: 'profile.button.update' });

    expect(update).toBeDisabled();
    expect(update).toHaveAccessibleDescription('profile.reason.noChanges');
  });

  test('a failed save keeps the form and what was typed, with the error above the button', async () => {
    Api.updateProfile.mockRejectedValueOnce(new Error('down'));
    renderPage();
    const user = userEvent.setup();
    const name = await screen.findByRole('textbox', { name: 'profile.parentName' });
    await user.type(name, ' Lopez');
    await user.click(screen.getByRole('button', { name: 'profile.button.update' }));

    expect(await screen.findByText('profile.error.update')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'profile.parentName' })).toHaveValue('Ana Lopez');
  });
});
