import { useEffect, useState } from 'react';
import { Utils } from '../utils';

export interface AdminIdentity {
  // null while the session is still being checked
  isAdmin: boolean | null;
  sub?: string;
  username?: string;
}

/** Claims of a JWT, without verifying it. Null when it does not decode. */
export const decodeJwtPayload = (token: string): Record<string, unknown> | null => {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const json = decodeURIComponent(
      Array.from(atob(padded), (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''),
    );
    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
};

/**
 * Whether the signed-in user is in the Cognito 'admin' group, read from the
 * ID token. Purely a UI convenience: every /referral/admin route re-checks
 * the same claim server-side. The HTTP API serializes the groups claim as an
 * array or a bracketed string depending on shape, so both are handled.
 *
 * The token comes from Utils.authenticate(), the same source every API call
 * uses. Reading Amplify's fetchAuthSession() directly hid the console from
 * every admin once passwordlessAuth shipped, because that flow leaves Amplify
 * with no session at all.
 */
export function useAdminIdentity(): AdminIdentity {
  const [identity, setIdentity] = useState<AdminIdentity>({ isAdmin: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const payload = decodeJwtPayload(await Utils.authenticate());
        if (!payload) throw new Error('undecodable ID token');
        const claim = (name: string) => {
          const value = payload[name];
          return typeof value === 'string' ? value : undefined;
        };
        const groups = payload['cognito:groups'] || [];
        const list = Array.isArray(groups)
          ? groups
          : String(groups).replace(/^\[|\]$/g, '').split(/[,\s]+/);
        if (!cancelled) {
          setIdentity({
            isAdmin: list.includes('admin'),
            sub: claim('sub'),
            username: claim('cognito:username'),
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
