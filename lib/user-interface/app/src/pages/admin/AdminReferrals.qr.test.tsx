/**
 * The admin QR modal: the same branded, scannable code parents get, and
 * downloads that are still that code.
 *
 * The drawn code and the exported SVG are both decoded with jsQR (via the
 * invite page's test util) and must read back as the exact link the Copy
 * button sends, so a print run cannot carry a code that goes somewhere else.
 */
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { saveAs } from "file-saver";
import AdminReferrals from "./AdminReferrals";
import { serializeQrSvg } from "./qr-export";
import { decodeQrSvg } from "../profile/invite-qr-decode.testutil";
import { LanguageContext } from "../../common/language-context";
import type { SupportedLanguage } from "../../common/languages";
import type { ReferralLink } from "../../common/types";

const LINKS: ReferralLink[] = [
  {
    code: "cec-booth",
    type: "campaign",
    name: "CEC Conference Booth",
    channel: "conference",
    active: true,
    clicks: 12,
    signups: 4,
    createdAt: "2026-10-01T12:00:00.000Z",
  },
];

const EXPECTED_URL = `${window.location.origin}/r/cec-booth`;

vi.mock("file-saver", () => ({ saveAs: vi.fn() }));

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

async function openQrModal() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <LanguageContext.Provider value={languageValue}>
        <MemoryRouter>
          <AdminReferrals />
        </MemoryRouter>
      </LanguageContext.Provider>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByTitle("QR code"));
  return screen.findByRole("dialog");
}

const drawnCode = (dialog: HTMLElement) =>
  dialog.querySelector("svg.invite-qr-code") as SVGSVGElement;

describe("AdminReferrals QR modal", () => {
  beforeEach(() => vi.mocked(saveAs).mockClear());

  test("draws the branded code, which scans to the exact link", async () => {
    const dialog = await openQrModal();

    expect(within(dialog).getByText("CEC Conference Booth")).toBeInTheDocument();
    expect(dialog.querySelectorAll("canvas")).toHaveLength(0);
    expect(decodeQrSvg(drawnCode(dialog))).toBe(EXPECTED_URL);
    expect(within(dialog).getByText(EXPECTED_URL)).toBeInTheDocument();
  });

  test("the SVG download is a standalone file that still scans to the link", async () => {
    const dialog = await openQrModal();
    fireEvent.click(within(dialog).getByRole("button", { name: /SVG for print/ }));

    await waitFor(() => expect(saveAs).toHaveBeenCalledTimes(1));
    const [blob, filename] = vi.mocked(saveAs).mock.calls[0] as [Blob, string];
    expect(filename).toBe("aiep-qr-cec-booth.svg");
    expect(blob.type).toBe("image/svg+xml");

    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(blob);
    });
    const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
    expect(parsed.querySelector("parsererror")).toBeNull();
    const svg = parsed.documentElement as unknown as SVGSVGElement;
    expect(svg.getAttribute("xmlns")).toBe("http://www.w3.org/2000/svg");
    expect(decodeQrSvg(svg)).toBe(EXPECTED_URL);
  });

  test("full screen swaps the modal for the parent overlay with the same link", async () => {
    const dialog = await openQrModal();
    fireEvent.click(within(dialog).getByRole("button", { name: /Full screen/ }));

    const overlay = await screen.findByRole("dialog", { name: "invite.qr.title" });
    expect(decodeQrSvg(drawnCode(overlay))).toBe(EXPECTED_URL);

    fireEvent.click(within(overlay).getByRole("button", { name: "invite.qr.close" }));
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByText("CEC Conference Booth")).toBeInTheDocument();
  });
});

describe("serializeQrSvg", () => {
  test("carries resolved paint inline and drops the on-screen animation", () => {
    document.head.insertAdjacentHTML(
      "beforeend",
      '<style id="qr-paint">.ground{fill:#ffffff}.stop{stop-color:#014620}</style>',
    );
    const host = document.createElement("div");
    host.innerHTML =
      '<svg class="invite-qr-code" viewBox="0 0 10 10">' +
      '<linearGradient id="g"><stop class="stop" offset="0"/></linearGradient>' +
      '<rect class="ground" width="10" height="10"/>' +
      '<path class="m" d="M0 0H1V1H0Z" fill="url(#g)" style="animation-delay: 120ms"/>' +
      "</svg>";
    document.body.appendChild(host);

    const out = new DOMParser().parseFromString(
      serializeQrSvg(host.querySelector("svg") as SVGSVGElement, 600),
      "image/svg+xml",
    ).documentElement;

    expect(out.getAttribute("width")).toBe("600");
    expect(out.getAttribute("class")).toBeNull();
    expect(out.querySelector(".ground")?.getAttribute("style")).toMatch(/fill:\s*(#ffffff|rgb\(255, 255, 255\))/);
    expect(out.querySelector(".stop")?.getAttribute("style")).toMatch(/stop-color/);
    expect(out.querySelector(".m")?.getAttribute("style") ?? "").not.toMatch(/animation/);

    host.remove();
    document.getElementById("qr-paint")?.remove();
  });
});
