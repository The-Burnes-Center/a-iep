import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Spinner } from 'react-bootstrap';
import { useAuth } from '../common/auth-provider';
import { useLanguage } from '../common/language-context';

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

  // Redirect to login if not authenticated
  // Save the location they were trying to access
  if (!authenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // User is authenticated, render the protected routes
  return <Outlet />;
}

