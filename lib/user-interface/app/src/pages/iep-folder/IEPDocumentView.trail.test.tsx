/**
 * The upload screen's trail says where the parent is, not where a summary
 * would be. It used to read "Summary > Upload IEP" for every parent, so a
 * parent uploading their first IEP was offered a link back to a summary that
 * did not exist yet (UI audit, 2026-11-09).
 *
 * Only the network boundary is mocked, as in the summary page's suites.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import IEPDocumentView from "./IEPDocumentView";
import { AppContext } from "../../common/app-context";
import { LanguageContext } from "../../common/language-context";
import type { AppConfig } from "../../common/types";
import type { SupportedLanguage } from "../../common/languages";

const Auth = vi.hoisted(() => ({ getCurrentUser: vi.fn(), fetchAuthSession: vi.fn() }));
vi.mock("aws-amplify/auth", () => Auth);

const API = "https://api.example.test/api";
const CHILD = { childId: "c-1", name: "Maya Lopez", schoolCity: "Lakeview" };
let documentAnswer: unknown;

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const renderUpload = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/iep-documents"]}>
        <AppContext.Provider value={{ httpEndpoint: `${API}/`, enabledFeatures: [], enabledLanguages: ["en"] } as unknown as AppConfig}>
          <LanguageContext.Provider
            value={{
              language: "en" as SupportedLanguage,
              setLanguage: vi.fn(),
              t: (key: string) => key,
              translationsLoaded: true,
              enabledLanguages: ["en"] as SupportedLanguage[],
            }}
          >
            <IEPDocumentView />
          </LanguageContext.Provider>
        </AppContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

const trail = () => screen.getByRole("navigation", { name: /./ });

beforeEach(() => {
  Auth.getCurrentUser.mockResolvedValue({ username: "u", userId: "u" });
  Auth.fetchAuthSession.mockResolvedValue({ tokens: { idToken: { toString: () => "tok", payload: {} } } });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === `${API}/profile`) return json(200, { profile: { userId: "u", children: [CHILD] } });
    if (url === `${API}/profile/children/${CHILD.childId}/documents`) return json(200, documentAnswer);
    throw new Error(`unexpected fetch ${url}`);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the upload screen's trail", () => {
  test("a parent with no IEP yet is not pointed at a summary that does not exist", async () => {
    documentAnswer = { message: "No document found for this child" };
    renderUpload();

    await waitFor(() => expect(screen.getByTestId("current-document-absent")).toBeInTheDocument());
    expect(trail()).toHaveTextContent("breadcrumb.uploadIep");
    expect(trail()).not.toHaveTextContent("breadcrumb.summary");
    expect(screen.queryByRole("link", { name: "breadcrumb.summary" })).not.toBeInTheDocument();
  });

  test("once an IEP is on file, the trail leads back to its summary", async () => {
    documentAnswer = { documentId: "d-1", status: "PROCESSED", documentUrl: "s3://b/u/c-1/d-1/iep.pdf" };
    renderUpload();

    await waitFor(() => expect(screen.getByTestId("current-document-present")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "breadcrumb.summary" })).toHaveAttribute("href", "/summary-and-translations");
  });

  test("the screen has exactly one h1, and it says what the screen is", async () => {
    // The old screen had exactly one h1 too: an empty one.
    documentAnswer = { message: "No document found for this child" };
    renderUpload();

    await waitFor(() => expect(screen.getByTestId("current-document-absent")).toBeInTheDocument());
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("upload.title");
  });
});
