import { useEffect, useState } from 'react';
import { Auth } from 'aws-amplify';

export interface AdminIdentity {
  // null while the session is still being checked
  isAdmin: boolean | null;
  sub?: string;
  username?: string;
}

/**
 * Whether the signed-in user is in the Cognito 'admin' group, read from the
 * ID token. Purely a UI convenience: every /referral/admin route re-checks
 * the same claim server-side. The HTTP API serializes the groups claim as an
 * array or a bracketed string depending on shape, so both are handled.
 */
export function useAdminIdentity(): AdminIdentity {
  const [identity, setIdentity] = useState<AdminIdentity>({ isAdmin: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await Auth.currentSession();
        const payload = session.getIdToken().decodePayload();
        const groups = payload['cognito:groups'] || [];
        const list = Array.isArray(groups)
          ? groups
          : String(groups).replace(/^\[|\]$/g, '').split(/[,\s]+/);
        if (!cancelled) {
          setIdentity({
            isAdmin: list.includes('admin'),
            sub: payload['sub'],
            username: payload['cognito:username'],
          });
        }
      } catch {
        if (!cancelled) setIdentity({ isAdmin: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return identity;
}
