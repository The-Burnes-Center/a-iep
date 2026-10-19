/**
 * Route-level code splitting.
 *
 * The protected pages are lazy chunks: a signed-in parent gets the shared
 * loading mark while the page downloads, then the page. The landing page is
 * still eager, so the logged-out path never waits on a chunk.
 */
import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AppRoutes from './AppRoutes';

vi.mock('./CustomLogin', () => ({
  default: () => <div>sign in form</div>,
}));

// A stand-in page. Resolving through a dynamic import is what makes the route
// lazy, so the fallback has to show first and the page after it.
vi.mock('../pages/profile/UserProfileForm', () => ({
  default: () => <div>profile form page</div>,
}));

const authState = vi.hoisted(() => ({ current: { authenticated: true, loading: false } }));
vi.mock('../common/auth-provider', () => ({
  useAuth: () => authState.current,
}));

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );

describe('protected routes are lazy', () => {
  test('shows the loading mark, then the page, for a signed-in parent', async () => {
    authState.current = { authenticated: true, loading: false };
    renderAt('/profile');

    // The fallback is the shared PageLoading: its accessible name is the
    // translated "loading" key (t() returns the key when no provider is mounted).
    expect(screen.getByText('common.loading')).toBeInTheDocument();

    expect(await screen.findByText('profile form page')).toBeInTheDocument();
    expect(screen.queryByText('common.loading')).not.toBeInTheDocument();
  });
});

describe('public routes stay eager', () => {
  test('the landing page renders at once, with no loading fallback', () => {
    authState.current = { authenticated: false, loading: false };
    renderAt('/');

    expect(screen.queryByText('common.loading')).not.toBeInTheDocument();
    expect(document.querySelector('.landing-page-container')).not.toBeNull();
  });
});
