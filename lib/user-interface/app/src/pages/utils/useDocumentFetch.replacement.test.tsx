/**
 * useDocumentFetch while a parent's IEP is being replaced.
 *
 * Replacing an IEP no longer deletes the old one up front: the documents
 * endpoint keeps answering with the old, finished document until the new one
 * is ready, and reports the newer one as `replacement`. Three things follow
 * for this hook, and each is pinned here against the real PollingManager and
 * the real API client (only `fetch` and Amplify's Auth are mocked):
 *
 *  - it keeps polling while the replacement is running, even though the
 *    document on screen says PROCESSED, so the new IEP appears by itself;
 *  - it stops when the replacement has failed, because nothing is left to
 *    wait for and the old IEP stays on screen;
 *  - when the endpoint switches to the new document the old document's
 *    sections are dropped, not merged in underneath it.
 */
import React, { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useDocumentFetch } from "./useDocumentFetch";
import { AppContext } from "../../common/app-context";
import type { AppConfig, IEPDocument } from "../../common/types";

const Auth = vi.hoisted(() => ({ getCurrentUser: vi.fn(),
  fetchAuthSession: vi.fn(), signOut: vi.fn() }));
vi.mock("aws-amplify/auth", () => Auth);

const API_BASE = "https://api.example.test/api";
const CHILD_ID = "child-abc";
const DOCUMENTS_URL = `${API_BASE}/profile/children/${CHILD_ID}/documents`;
const POLL_INTERVAL_MS = 5000;
const SLOW_POLL_INTERVAL_MS = 15000;

const appConfig = {
  httpEndpoint: `${API_BASE}/`,
  enabledFeatures: [],
  enabledLanguages: ["en"],
} as unknown as AppConfig;

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const section = (title: string, content: string) => ({ title, content, page_numbers: [1] });

const oldDocument = (replacement?: Record<string, unknown>) => ({
  documentId: "iep-old",
  iepId: "iep-old",
  status: "PROCESSED",
  createdAt: 1000,
  summaries: { en: "Old summary", es: "Resumen antiguo" },
  document_index: { en: "", es: "" },
  sections: { en: [section("Goals", "old goals")], es: [section("Metas", "metas antiguas")] },
  ...(replacement ? { replacement } : {}),
});

const newDocument = () => ({
  documentId: "iep-new",
  iepId: "iep-new",
  status: "PROCESSED",
  createdAt: 2000,
  summaries: { en: "New summary" },
  document_index: { en: "" },
  // English only: the new document has no Spanish yet.
  sections: { en: [section("Goals", "new goals")] },
});

const EMPTY_DOCUMENT = {
  documentId: undefined,
  status: undefined,
  summaries: { en: "", es: "", vi: "", zh: "", ar: "" },
  document_index: { en: "", es: "", vi: "", zh: "", ar: "" },
  sections: { en: [], es: [], vi: [], zh: [], ar: [] },
} as unknown as IEPDocument;

let documentPayload: Record<string, unknown>;
let documentReads: number;

const Harness = () => {
  const [document, setDocument] = useState<IEPDocument>(EMPTY_DOCUMENT);
  useDocumentFetch({
    translationsLoaded: true,
    document,
    initialLoading: false,
    setDocument,
    setError: vi.fn(),
    setInitialLoading: vi.fn(),
    // The page normalizes sections here; for this hook what matters is what
    // reaches state, so the raw sections are left exactly as merged.
    processDocumentSections: vi.fn(),
    loadErrorMessage: "load failed",
  });
  return (
    <pre data-testid="state">
      {JSON.stringify({
        id: document.documentId,
        summary: document.summaries?.en,
        sections: document.sections,
      })}
    </pre>
  );
};

const shown = () => JSON.parse(screen.getByTestId("state").textContent as string);

const mount = () => render(
  <AppContext.Provider value={appConfig}>
    <Harness />
  </AppContext.Provider>,
);

const settle = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  Auth.getCurrentUser.mockResolvedValue({ username: "test-user", userId: "test-user" });
  Auth.fetchAuthSession.mockResolvedValue({
    tokens: { idToken: { toString: () => "id-token", payload: {} } },
  });
  documentReads = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === `${API_BASE}/profile`) {
      return jsonResponse(200, { profile: { userId: "user-1", children: [{ childId: CHILD_ID }] } });
    }
    if (url === DOCUMENTS_URL) {
      documentReads += 1;
      return jsonResponse(200, documentPayload);
    }
    throw new Error(`unexpected fetch to ${url}`);
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("while a replacement is being processed", () => {
  test("keeps polling although the document on screen is finished", async () => {
    documentPayload = oldDocument({ iepId: "iep-new", status: "PROCESSING" });
    mount();
    await settle();
    expect(shown().id).toBe("iep-old");
    const readsAfterFirstLoad = documentReads;

    await settle(POLL_INTERVAL_MS);
    await settle(POLL_INTERVAL_MS);

    expect(documentReads).toBeGreaterThan(readsAfterFirstLoad);
    expect(shown().id).toBe("iep-old");
  });

  test("shows the new document by itself once it is ready", async () => {
    documentPayload = oldDocument({ iepId: "iep-new", status: "PROCESSING" });
    mount();
    await settle();
    expect(shown().summary).toBe("Old summary");

    documentPayload = newDocument();
    await settle(POLL_INTERVAL_MS);

    expect(shown().id).toBe("iep-new");
    expect(shown().summary).toBe("New summary");
  });

  test("the old document's sections do not survive underneath the new one", async () => {
    documentPayload = oldDocument({ iepId: "iep-new", status: "PROCESSING" });
    mount();
    await settle();
    expect(shown().sections.es).toHaveLength(1);

    documentPayload = newDocument();
    await settle(POLL_INTERVAL_MS);

    expect(shown().sections.en[0].content).toBe("new goals");
    // The new document has no Spanish: nothing of the old one's may be left.
    expect(shown().sections.es).toEqual([]);
  });

  test("sections already received for the same document are still kept between polls", async () => {
    documentPayload = oldDocument({ iepId: "iep-new", status: "PROCESSING" });
    mount();
    await settle();

    // Same document, a later read that carries only English.
    documentPayload = {
      ...oldDocument({ iepId: "iep-new", status: "PROCESSING" }),
      createdAt: 1001,
      sections: { en: [section("Goals", "old goals, revised")] },
    };
    await settle(POLL_INTERVAL_MS);

    expect(shown().sections.en[0].content).toBe("old goals, revised");
    expect(shown().sections.es).toHaveLength(1);
  });

  test("a page mounted mid-replacement shows the old document and keeps polling", async () => {
    // The bottom nav unmounts the page; nothing about the replacement lives in
    // component state, so a fresh mount rebuilds it all from the payload.
    documentPayload = oldDocument({ iepId: "iep-new", status: "PROCESSING" });
    const first = mount();
    await settle();
    first.unmount();

    mount();
    await settle();
    expect(shown().id).toBe("iep-old");
    const reads = documentReads;

    await settle(POLL_INTERVAL_MS);
    expect(documentReads).toBeGreaterThan(reads);
  });
});

describe("when the replacement has failed", () => {
  test("the old document stays on screen and polling stops", async () => {
    documentPayload = oldDocument({ iepId: "iep-new", status: "FAILED" });
    mount();
    await settle();
    expect(shown().id).toBe("iep-old");
    const reads = documentReads;

    await settle(SLOW_POLL_INTERVAL_MS * 4);

    expect(documentReads).toBe(reads);
    expect(shown().id).toBe("iep-old");
    expect(shown().summary).toBe("Old summary");
  });
});

describe("without a replacement", () => {
  test("a finished document is not polled", async () => {
    documentPayload = oldDocument();
    mount();
    await settle();
    const reads = documentReads;

    await settle(SLOW_POLL_INTERVAL_MS * 4);

    expect(documentReads).toBe(reads);
  });
});
