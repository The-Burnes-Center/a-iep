import { useContext, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AppContext } from '../common/app-context';
import { ApiClient } from '../common/api-client/api-client';
import { normalizeReferralCode, storePendingReferral } from '../common/helpers/referral-capture';

/**
 * Landing target for shared links (a-iep.org/r/<code>): remember the code
 * for signup attribution, count the visit server-side, and continue to the
 * landing page. Path-based on purpose; Safari's link-tracking protection
 * strips known query click-IDs but never touches paths.
 */
export default function ReferralRedirect() {
  const { code } = useParams();
  const appContext = useContext(AppContext);
  const navigate = useNavigate();

  useEffect(() => {
    const normalized = normalizeReferralCode(code);
    if (normalized && appContext) {
      storePendingReferral(normalized);
      // Every arrival on /r/<code> is a click, first-touch or not
      new ApiClient(appContext).referral.logClick(normalized);
    }
    navigate('/', { replace: true });
  }, [code, appContext, navigate]);

  return null;
}
