import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Spinner } from 'react-bootstrap';
import { useAuth } from '../common/auth-provider';
import { useLanguage } from '../common/language-context';
import { SIGN_IN_ROUTE } from '../common/sign-in-location';

export function ProtectedRoute() {
  const { authenticated, loading } = useAuth();
  const location = useLocation();
  const { t } = useLanguage();

  // Show loading spinner while checking authentication
  if (loading) {
    return (
      <div
        style={{
          width: '100%',
          height: '100vh',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        {/* The label is the spinner's accessible name, so it has to be there
            and it has to be translated: this guard fronts every protected
            route, in whatever language the parent picked. */}
        <Spinner animation="border" role="status">
          <span className="visually-hidden">{t('common.loading')}</span>
        </Spinner>
      </div>
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

  // User is authenticated, render the protected routes
  return <Outlet />;
}

