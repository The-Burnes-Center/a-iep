/**
 * Utils.authenticate(): every api-client's single source of the bearer token
 * (see common/api-client/*.ts). Covers only the branch this change touched —
 * preferring a cached passwordlessAuth token over Amplify — because the
 * Amplify path itself is unchanged and already exercised through the
 * api-client suites (e.g. iep-document-client.test.ts).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Utils } from "./utils";
import {
  clearCachedTokens,
  clearPersistedSessionHandle,
  configureSessionRefresh,
  persistSessionHandle,
  setCachedTokens,
} from "./auth/passwordless-auth";

const Auth = vi.hoisted(() => ({ fetchAuthSession: vi.fn() }));
vi.mock("aws-amplify/auth", () => Auth);

const HTTP_ENDPOINT = "https://api.example.test/";

beforeEach(() => {
  clearCachedTokens();
  clearPersistedSessionHandle();
  configureSessionRefresh(null);
});

afterEach(() => {
  clearCachedTokens();
});

describe("Utils.authenticate", () => {
  test("returns the passwordlessAuth cached token without calling Amplify at all", async () => {
    setCachedTokens({ accessToken: "a1", idToken: "cached-id-token", expiresIn: 3600 });

    const token = await Utils.authenticate();

    expect(token).toBe("cached-id-token");
    expect(Auth.fetchAuthSession).not.toHaveBeenCalled();
  });

  test("falls back to Amplify's session when there is no cached passwordlessAuth token", async () => {
    Auth.fetchAuthSession.mockResolvedValue({ tokens: { idToken: { toString: () => "amplify-id-token" } } });

    const token = await Utils.authenticate();

    expect(token).toBe("amplify-id-token");
    expect(Auth.fetchAuthSession).toHaveBeenCalledTimes(1);
  });

  test("still throws the same generic error when neither source has a token", async () => {
    Auth.fetchAuthSession.mockResolvedValue({ tokens: {} });

    await expect(Utils.authenticate()).rejects.toThrow("Authentication failed");
  });
});

/**
 * The idle-tab fix, at the seam every api client goes through.
 *
 * The tokens last an hour and live in memory. Before this, a tab left open
 * past that threw here: the Amplify fall-through cannot help a parent who
 * signed in through the passwordless flow, because that flow deliberately
 * keeps the real Cognito tokens server-side and leaves Amplify with no
 * session at all. A tester who left the name step and came back got
 * "Service unavailable" and a Try Again that re-ran the same failing path.
 */
describe("Utils.authenticate, when the cached token has gone cold", () => {
  const jsonResponse = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  test("renews from the persisted handle instead of failing", async () => {
    persistSessionHandle("sess-1");
    configureSessionRefresh(HTTP_ENDPOINT);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse(200, { ok: true, accessToken: "a2", idToken: "id-2", expiresIn: 3600 }),
    ));

    // Amplify has nothing, which is the situation for every parent who signed
    // in this way: the renewal is the only thing that can answer.
    Auth.fetchAuthSession.mockResolvedValue({ tokens: undefined });

    expect(await Utils.authenticate()).toBe("id-2");
  });

  test("does not touch the network when the token still has life in it", async () => {
    persistSessionHandle("sess-1");
    configureSessionRefresh(HTTP_ENDPOINT);
    setCachedTokens({ accessToken: "a", idToken: "id-1", expiresIn: 3600 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await Utils.authenticate()).toBe("id-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("still throws when the handle is dead, so callers behave as before", async () => {
    // AuthProvider is what turns this into a redirect, off the event
    // renewIdToken fires; authenticate's own contract is unchanged.
    persistSessionHandle("sess-1");
    configureSessionRefresh(HTTP_ENDPOINT);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse(401, { ok: false, code: "session_invalid", message: "gone" }),
    ));
    Auth.fetchAuthSession.mockResolvedValue({ tokens: undefined });

    await expect(Utils.authenticate()).rejects.toThrow("Authentication failed");
  });

  test("falls through to Amplify for a parent who signed in that way", async () => {
    // No handle to renew from, and the legacy path must keep working.
    Auth.fetchAuthSession.mockResolvedValue({
      tokens: { idToken: { toString: () => "amplify-token" } },
    });

    expect(await Utils.authenticate()).toBe("amplify-token");
  });
});
