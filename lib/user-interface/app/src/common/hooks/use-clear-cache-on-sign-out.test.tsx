/**
 * The staging failure this guards: a parent deleted their account, signed up
 * again within five minutes in the same tab, and the upload failed. The query
 * cache still held the deleted account's profile, so the upload screen sent a
 * child id the new profile does not have, and the upload was refused before
 * it asked for an upload link.
 *
 * These replay that sequence through the real useActiveChild and a QueryClient
 * with the app's own five-minute staleTime, and assert which child the screen
 * would upload for.
 */
import { describe, expect, test, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useClearCacheOnSignOut } from "./use-clear-cache-on-sign-out";
import { useActiveChild } from "./use-active-child";
import { PROFILE_QUERY_KEY } from "./use-language-preference";

const authState = { current: { authenticated: true } };
vi.mock("../auth-provider", () => ({ useAuth: () => authState.current }));

const getProfile = vi.fn();
vi.mock("../api-client/api-client", () => ({
  ApiClient: class {
    profile = { getProfile };
  },
}));

const OLD_ACCOUNT = { userId: "u-old", children: [{ childId: "c-deleted", name: "Sam" }] };
const NEW_ACCOUNT = { userId: "u-new", children: [{ childId: "c-new", name: "Sam" }] };
/** The app's own staleTime (components/app-configured.tsx). */
const FIVE_MINUTES = 5 * 60 * 1000;

/** Mounted above the router for the page's whole life, as in app-configured.tsx. */
function Reset() {
  useClearCacheOnSignOut();
  return null;
}
function ActiveChildId() {
  const { childId, isLoading } = useActiveChild();
  return <p>{isLoading ? "loading" : `uploads for ${childId}`}</p>;
}

function mount(withReset: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: FIVE_MINUTES, retry: false } } });
  // Signed out shows the sign-in card, which reads no profile.
  const tree = (signedIn: boolean) => (
    <QueryClientProvider client={client}>
      {withReset && <Reset />}
      <MemoryRouter>{signedIn ? <ActiveChildId /> : null}</MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree(true));
  return { client, view, tree };
}

beforeEach(() => {
  authState.current = { authenticated: true };
  getProfile.mockReset();
});

/** Signed in as the old account, then out, then in again as a new one. */
async function deleteAndSignUpAgain(withReset: boolean) {
  getProfile.mockResolvedValue(OLD_ACCOUNT);
  const { client, view, tree } = mount(withReset);
  await screen.findByText("uploads for c-deleted");

  authState.current = { authenticated: false };
  view.rerender(tree(false));

  getProfile.mockResolvedValue(NEW_ACCOUNT);
  authState.current = { authenticated: true };
  view.rerender(tree(true));
  return client;
}

describe("useClearCacheOnSignOut", () => {
  test("after a delete and a fresh sign-up, the upload is for the new account's child", async () => {
    await deleteAndSignUpAgain(true);
    await waitFor(() => expect(screen.getByText("uploads for c-new")).toBeTruthy());
    expect(screen.queryByText("uploads for c-deleted")).toBeNull();
  });

  test("without it, the same sequence uploads for the deleted child (the bug)", async () => {
    // Pins why the reset exists: the five-minute cache alone serves the old
    // profile to the new account and never asks the server again.
    await deleteAndSignUpAgain(false);
    await act(async () => {});
    expect(screen.getByText("uploads for c-deleted")).toBeTruthy();
    expect(getProfile).toHaveBeenCalledTimes(1);
  });

  test("signing out empties the whole cache, not only the profile", async () => {
    getProfile.mockResolvedValue(OLD_ACCOUNT);
    const { client, view, tree } = mount(true);
    await screen.findByText("uploads for c-deleted");
    client.setQueryData(["summaryTourSeenThisSession"], true);

    authState.current = { authenticated: false };
    view.rerender(tree(false));

    expect(client.getQueryData(PROFILE_QUERY_KEY)).toBeUndefined();
    expect(client.getQueryData(["summaryTourSeenThisSession"])).toBeUndefined();
  });

  test("a signed-in re-render leaves the cache alone", async () => {
    getProfile.mockResolvedValue(OLD_ACCOUNT);
    const { client, view, tree } = mount(true);
    await screen.findByText("uploads for c-deleted");

    view.rerender(tree(true));

    expect(client.getQueryData(PROFILE_QUERY_KEY)).toEqual(OLD_ACCOUNT);
    expect(getProfile).toHaveBeenCalledTimes(1);
  });
});
