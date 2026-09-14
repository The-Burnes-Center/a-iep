import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import AIEPSpinner from './AIEPSpinner';
import { useAuth } from '../common/auth-provider';
import { useLanguage } from '../common/language-context';
import { SIGN_IN_ROUTE } from '../common/sign-in-location';

export function ProtectedRoute() {
  const { authenticated, loading } = useAuth();
  const location = useLocation();
  const { t } = useLanguage();

  // Show loading spinner while checking authentication
  if (loading) {
    // The label is the spinner's accessible name, so it has to be there and it
    // has to be translated: this guard fronts every protected route, in
    // whatever language the parent picked.
    return <AIEPSpinner size="lg" fullPage label={t('common.loading')} />;
  }

  // Send them to the sign-in card on the landing page, carrying the page they
  // were trying to open: CustomLogin reads `from` back after a successful
  // sign-in and finishes the journey they started, instead of dropping them on
  // /preferred-language. The hash is what puts them on the form rather than at
  // the top of the marketing page — see common/sign-in-location.ts.
  if (!authenticated) {
    return <Navigate to={SIGN_IN_ROUTE} state={{ from: location }} replace />;
  }

  // User is authenticated, render the protected routes
  return <Outlet />;
}

