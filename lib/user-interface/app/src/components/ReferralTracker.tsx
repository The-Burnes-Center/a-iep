import { useContext, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { AppContext } from '../common/app-context';
import { ApiClient } from '../common/api-client/api-client';
import { useAuth } from '../common/auth-provider';
import {
  clearPendingReferral,
  getPendingReferralCapture,
  normalizeReferralCode,
  storePendingReferral,
} from '../common/helpers/referral-capture';

/**
 * Invisible glue for the referral flow, mounted once next to the routes:
 * 1. captures ?ref=<code> from any URL (shared /r/<code> links have their
 *    own route; this covers hand-written links and campaign UTMs)
 * 2. once the visitor is signed in, reports the pending code so the backend
 *    can attribute the signup, then clears it
 */
export default function ReferralTracker() {
  const appContext = useContext(AppContext);
  const location = useLocation();
  const { authenticated } = useAuth();
  const attributing = useRef(false);

  useEffect(() => {
    const code = normalizeReferralCode(new URLSearchParams(location.search).get('ref'));
    // storePendingReferral is true only on first capture, so a ?ref= that
    // sticks around across navigations is counted as one click
    if (code && appContext && storePendingReferral(code)) {
      new ApiClient(appContext).referral.logClick(code);
    }
  }, [location.search, appContext]);

  useEffect(() => {
    if (!authenticated || !appContext || attributing.current) return;
    const pending = getPendingReferralCapture();
    if (!pending) return;
    attributing.current = true;
    new ApiClient(appContext).referral
      .attribute(pending.code, pending.capturedAt)
      // A 200 means the server decided (attributed or rejected): done either
      // way. Only a network/server failure leaves the code pending for a
      // retry on the next visit.
      .then(() => clearPendingReferral())
      .catch(() => {
        attributing.current = false;
      });
  }, [authenticated, appContext]);

  return null;
}
