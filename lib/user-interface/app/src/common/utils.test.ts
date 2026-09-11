/**
 * Utils.authenticate(): every api-client's single source of the bearer token
 * (see common/api-client/*.ts). Covers only the branch this change touched —
 * preferring a cached passwordlessAuth token over Amplify — because the
 * Amplify path itself is unchanged and already exercised through the
 * api-client suites (e.g. iep-document-client.test.ts).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Utils } from "./utils";
import { clearCachedTokens, setCachedTokens } from "./auth/passwordless-auth";

const Auth = vi.hoisted(() => ({ fetchAuthSession: vi.fn() }));
vi.mock("aws-amplify/auth", () => Auth);

beforeEach(() => {
  clearCachedTokens();
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
