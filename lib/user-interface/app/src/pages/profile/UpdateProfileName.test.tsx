/**
 * The parent-name form's accessibility: the field has a programmatic label,
 * and the disabled Save button says why it is disabled, through its
 * accessible description, until a name is typed.
 *
 * The mocked boundary is the API client; the page, the router and the field
 * are real.
 */
import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import UpdateProfileName from './UpdateProfileName';
import { AppContext } from '../../common/app-context';
import { LanguageContext } from '../../common/language-context';
import type { SupportedLanguage } from '../../common/languages';
import type { AppConfig } from '../../common/types';

const Api = vi.hoisted(() => ({
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  addChild: vi.fn(),
}));
vi.mock('../../common/api-client/api-client', () => ({
  ApiClient: class {
    profile = Api;
  },
}));

const languageValue = {
  language: 'en' as SupportedLanguage,
  setLanguage: vi.fn(),
  t: (key: string) => key,
  translationsLoaded: true,
  enabledLanguages: ['en'] as SupportedLanguage[],
};

const renderPage = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/account-center/profile']}>
      <QueryClientProvider client={queryClient}>
        <AppContext.Provider value={{ httpEndpoint: 'https://api.example.test/' } as AppConfig}>
          <LanguageContext.Provider value={languageValue}>
            <UpdateProfileName />
          </LanguageContext.Provider>
        </AppContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
};

beforeEach(() => {
  Api.getProfile.mockResolvedValue({ parentName: '', children: [{ childId: 'c1', name: 'Maya' }] });
});

describe('UpdateProfileName form', () => {
  test('the name field has a visible label as its accessible name', async () => {
    renderPage();
    expect(await screen.findByRole('textbox', { name: 'parent.name.label' })).toBeInTheDocument();
  });

  test('while the name is empty, Save is disabled and its description says why', async () => {
    renderPage();
    const save = await screen.findByRole('button', { name: 'updateProfile.button.update' });

    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription('updateProfile.reason.nameMissing');
  });

  test('typing a name enables Save and removes the reason', async () => {
    renderPage();
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox', { name: 'parent.name.label' }), 'Ana');

    const save = screen.getByRole('button', { name: 'updateProfile.button.update' });
    expect(save).toBeEnabled();
    expect(save).not.toHaveAccessibleDescription('updateProfile.reason.nameMissing');
    expect(screen.queryByText('updateProfile.reason.nameMissing')).not.toBeInTheDocument();
  });
});
