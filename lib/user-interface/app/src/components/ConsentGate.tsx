import React, { useContext, useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { StatusIndicator } from '@cloudscape-design/components';
import { AppContext } from '../common/app-context';
import { ApiClient } from '../common/api-client/api-client';

/**
 * Layout route that blocks the IEP data pages until the profile has
 * consentGiven === true. Consent is normally the last onboarding step, but
 * profiles created by fallback paths (e.g. after a failed PostConfirmation
 * write) reached the app without ever seeing the consent form; this gate
 * redirects them there instead of letting them through silently.
 */
export function ConsentGate() {
  const appContext = useContext(AppContext);
  const location = useLocation();
  const [consented, setConsented] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const apiClient = new ApiClient(appContext);
    apiClient.profile.getProfile()
      .then((profile) => {
        if (!cancelled) setConsented(profile?.consentGiven === true);
      })
      .catch(() => {
        // Fail closed: without a readable profile, require the consent form
        // (it has its own retry UI for service errors)
        if (!cancelled) setConsented(false);
      });
    return () => { cancelled = true; };
  }, [appContext, location.pathname]);

  if (consented === null) {
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
        <StatusIndicator type="loading">Loading...</StatusIndicator>
      </div>
    );
  }

  if (!consented) {
    return <Navigate to="/consent-form" replace />;
  }

  return <Outlet />;
}
