/**
 * The admin referral table, for parent invite links whose owner name the
 * server could not provide (its KMS decrypt failed, so ownerName is null).
 *
 * The server sends null in that field when it withholds the name. This suite
 * checks that the page renders a readable fallback for null and leaves
 * resolved names alone.
 */
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import AdminReferrals from "./AdminReferrals";
import { LanguageContext } from "../../common/language-context";
import type { SupportedLanguage } from "../../common/languages";
import type { ReferralLink } from "../../common/types";

const LINKS: ReferralLink[] = [
  {
    code: "k7q2m9ab",
    type: "user",
    active: true,
    clicks: 3,
    signups: 1,
    createdAt: "2026-10-01T12:00:00.000Z",
    ownerUserId: "user-withheld",
    // The server sends null here when it withholds the name.
    ownerName: null as unknown as string,
  },
  {
    code: "jane-p",
    type: "user",
    active: true,
    clicks: 1,
    signups: 0,
    createdAt: "2026-10-02T12:00:00.000Z",
    ownerUserId: "user-jane",
    ownerName: "Jane P.",
  },
];

vi.mock("../../common/helpers/use-admin-identity", () => ({
  useAdminIdentity: () => ({ isAdmin: true, sub: "admin-sub", username: "admin" }),
}));

vi.mock("../../common/api-client/api-client", () => ({
  ApiClient: class {
    referral = {
      adminListLinks: async () => LINKS,
      adminListAdmins: async () => [],
    };
  },
}));

const languageValue = {
  language: "en" as SupportedLanguage,
  setLanguage: vi.fn(),
  t: (key: string) => key,
} as unknown as React.ContextType<typeof LanguageContext>;

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LanguageContext.Provider value={languageValue}>
        <MemoryRouter>
          <AdminReferrals />
        </MemoryRouter>
      </LanguageContext.Provider>
    </QueryClientProvider>,
  );
}

describe("AdminReferrals owner names", () => {
  test("a withheld owner name shows the readable fallback", async () => {
    renderPage();

    expect(await screen.findByText("name not on profile")).toBeInTheDocument();
    expect(screen.getByText("Jane P.")).toBeInTheDocument();
  });

  test("only the withheld link gets the fallback; resolved names are unchanged", async () => {
    renderPage();

    await screen.findByText("Jane P.");
    expect(screen.getAllByText("name not on profile")).toHaveLength(1);
  });
});
