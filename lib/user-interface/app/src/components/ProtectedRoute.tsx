import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import PageLoading from './PageLoading';
import AppShell from './AppShell';
import { InAppChrome } from './RouteChrome';
import { useAuth } from '../common/auth-provider';
import { useLanguage } from '../common/language-context';
import { SIGN_IN_ROUTE } from '../common/sign-in-location';

/**
 * The guard on every in-app route, and the thing that decides those routes
 * get in-app chrome. Both, because they are the same question: the bar offers
 * Summary, Support, Rights and Account, none of which a visitor can open.
 */
export function ProtectedRoute() {
  const { authenticated, loading } = useAuth();
  const location = useLocation();
  const { t } = useLanguage();

  // Show loading spinner while checking authentication
  if (loading) {
    // The frame but not the bar: this is the one moment where the answer to
    // "is this parent in the app" is genuinely unknown, and the next line may
    // send them to the sign-in card instead.
    //
    // The label is the spinner's accessible name, so it has to be there and it
    // has to be translated: this guard fronts every protected route, in
    // whatever language the parent picked.
    return (
      <AppShell>
        <PageLoading label={t('common.loading')} />
      </AppShell>
    );
  }

  // Send them to the sign-in card on the landing page, carrying the page they
  // were trying to open: CustomLogin reads `from` back after a successful
  // sign-in and finishes the journey they started, instead of dropping them on
  // /preferred-language. The hash is what puts them on the form rather than at
  // the top of the marketing page — see common/sign-in-location.ts.
  if (!authenticated) {
    return <Navigate to={SIGN_IN_ROUTE} state={{ from: location }} replace />;
  }

  // Authenticated: the shell, the in-app bar, and the protected routes inside
  // it. InAppChrome renders the <Outlet/> this layout route stands for.
  return <InAppChrome />;
}

