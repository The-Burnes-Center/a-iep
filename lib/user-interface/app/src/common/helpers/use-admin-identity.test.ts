import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { getCachedIdToken, renewIdToken, fetchAuthSession } = vi.hoisted(() => ({
  getCachedIdToken: vi.fn(),
  renewIdToken: vi.fn(),
  fetchAuthSession: vi.fn(),
}));

vi.mock('../auth/passwordless-auth', () => ({ getCachedIdToken, renewIdToken }));
vi.mock('aws-amplify/auth', () => ({ fetchAuthSession }));

import { useAdminIdentity, decodeJwtPayload } from './use-admin-identity';

const b64url = (value: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (claims: Record<string, unknown>) =>
  `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(claims))}.sig`;

describe('useAdminIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    renewIdToken.mockResolvedValue(null);
    // Passwordless sign-in leaves Amplify with no session at all.
    fetchAuthSession.mockResolvedValue({ tokens: undefined });
  });

  it('reads the admin group from the passwordless ID token', async () => {
    getCachedIdToken.mockReturnValue(
      jwt({ sub: 'abc', 'cognito:username': 'abc', 'cognito:groups': ['admin'] }),
    );
    const { result } = renderHook(() => useAdminIdentity());
    await waitFor(() => expect(result.current.isAdmin).toBe(true));
    expect(result.current.sub).toBe('abc');
    expect(fetchAuthSession).not.toHaveBeenCalled();
  });

  it('accepts the bracketed string form of the groups claim', async () => {
    getCachedIdToken.mockReturnValue(jwt({ sub: 'abc', 'cognito:groups': '[staff admin]' }));
    const { result } = renderHook(() => useAdminIdentity());
    await waitFor(() => expect(result.current.isAdmin).toBe(true));
  });

  it('is false for a signed-in parent outside the admin group', async () => {
    getCachedIdToken.mockReturnValue(jwt({ sub: 'abc' }));
    const { result } = renderHook(() => useAdminIdentity());
    await waitFor(() => expect(result.current.isAdmin).toBe(false));
  });

  it('is false when there is no session anywhere', async () => {
    getCachedIdToken.mockReturnValue(null);
    const { result } = renderHook(() => useAdminIdentity());
    await waitFor(() => expect(result.current.isAdmin).toBe(false));
  });
});

describe('decodeJwtPayload', () => {
  it('decodes non-ASCII claims', () => {
    expect(decodeJwtPayload(jwt({ name: 'José' }))).toEqual({ name: 'José' });
  });

  it('returns null for garbage', () => {
    expect(decodeJwtPayload('not-a-jwt')).toBeNull();
    expect(decodeJwtPayload('a.%%%.c')).toBeNull();
  });
});
