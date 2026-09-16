import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { SIGN_IN_HASH } from '../common/sign-in-location';

/**
 * /login, now that the sign-in form lives on the landing page.
 *
 * The route stays registered rather than falling through to the catch-all:
 * a-iep.org/login is printed in outreach material, sits in bookmarks and in
 * parents' browser history, and all of those have to keep working.
 *
 * Two things travel across the redirect because both mean something on the
 * way in:
 * - `search`, so a `?ref=` referral click still reaches ReferralTracker.
 * - `state.from`, the page a parent was trying to open before ProtectedRoute
 *   sent them here. CustomLogin reads it back after a successful sign-in to
 *   put them where they were going instead of on /preferred-language.
 *
 * `replace`, so Back from the landing page goes wherever the parent came
 * from rather than bouncing through this redirect again.
 */
const LoginRedirect: React.FC = () => {
  const location = useLocation();

  return (
    <Navigate
      to={{ pathname: '/', search: location.search, hash: SIGN_IN_HASH }}
      state={location.state}
      replace
    />
  );
};

export default LoginRedirect;
