/**
 * Wiring tests for IEPDocumentClient.requestTranslation — the browser half of
 * the translate-on-demand feature.
 *
 * The decision logic that consumes this call is covered by
 * test/lambdas/summary-page/translation-flow.test.mjs; what is pinned here is
 * the request itself (child-scoped URL, bearer token, body) and the
 * status-code contract the page depends on: a 2xx carries `httpStatus`
 * through, and a non-2xx throws a TranslationRequestError that carries the
 * code WITHOUT the server's own body — those strings are generic by design and
 * must never reach a parent.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { IEPDocumentClient, TranslationRequestError } from "./iep-document-client";
import type { AppConfig } from "../types";

const Auth = vi.hoisted(() => ({ currentAuthenticatedUser: vi.fn() }));
vi.mock("aws-amplify", () => ({ Auth }));

const CHILD_ID = "child-abc";
const IEP_ID = "iep-789";
const TOKEN = "id-token-value";
const API_BASE = "https://api.example.test/api";

const appConfig = { httpEndpoint: `${API_BASE}/` } as AppConfig;

interface StubResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

const jsonResponse = (status: number, body: unknown): StubResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const unreadableResponse = (status: number): StubResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    throw new SyntaxError("Unexpected end of JSON input");
  },
});

/** The translations answer the next request gets. Set per test. */
let translationsAnswer: StubResponse;
let fetchMock: ReturnType<typeof vi.fn>;

const translationsUrl = () =>
  `${API_BASE}/profile/children/${CHILD_ID}/documents/${IEP_ID}/translations`;

const translationsCall = () =>
  fetchMock.mock.calls.find(([url]) => String(url).endsWith("/translations"));

beforeEach(() => {
  Auth.currentAuthenticatedUser.mockResolvedValue({
    signInUserSession: { idToken: { jwtToken: TOKEN } },
  });
  translationsAnswer = jsonResponse(202, {
    status: "PROCESSING_TRANSLATIONS",
    language: "es",
    iepId: IEP_ID,
    alreadyExists: false,
  });

  fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/profile")) {
      return jsonResponse(200, {
        profile: { children: [{ childId: CHILD_ID }] },
      });
    }
    if (url.endsWith("/translations")) return translationsAnswer;
    throw new Error(`unexpected fetch to ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

describe("requestTranslation request", () => {
  test("posts the language to the child-scoped translations route with a bearer token", async () => {
    const client = new IEPDocumentClient(appConfig);

    await client.requestTranslation(IEP_ID, "es");

    const call = translationsCall();
    expect(call?.[0]).toBe(translationsUrl());
    expect(call?.[1]).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
    });
    expect(JSON.parse(call?.[1].body as string)).toEqual({ language: "es" });
  });

  test("resolves the child from the profile rather than trusting the caller", async () => {
    const client = new IEPDocumentClient(appConfig);

    await client.requestTranslation(IEP_ID, "vi");

    // The route is child-scoped and the page never passes a childId, so a
    // profile read has to happen first — and its result has to be the one in
    // the URL, not a hardcoded or cached value.
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${API_BASE}/profile`,
      translationsUrl(),
    ]);
  });
});

describe("requestTranslation success answers", () => {
  test("carries a 202 through as the httpStatus the page maps on", async () => {
    const client = new IEPDocumentClient(appConfig);

    const result = await client.requestTranslation(IEP_ID, "es");

    expect(result).toEqual({
      status: "PROCESSING_TRANSLATIONS",
      language: "es",
      iepId: IEP_ID,
      alreadyExists: false,
      httpStatus: 202,
    });
  });

  test("reports a 200 as already existing without losing the status code", async () => {
    translationsAnswer = jsonResponse(200, {
      status: "PROCESSED",
      language: "zh",
      iepId: IEP_ID,
      alreadyExists: true,
    });
    const client = new IEPDocumentClient(appConfig);

    const result = await client.requestTranslation(IEP_ID, "zh");

    expect(result.alreadyExists).toBe(true);
    expect(result.httpStatus).toBe(200);
  });

  test("falls back to the requested language and id when a 2xx body is unreadable", async () => {
    translationsAnswer = unreadableResponse(202);
    const client = new IEPDocumentClient(appConfig);

    // A started translation must not be reported as a failure just because the
    // body did not parse: the poller, not this call, delivers the content.
    const result = await client.requestTranslation(IEP_ID, "vi");

    expect(result).toEqual({
      status: "",
      language: "vi",
      iepId: IEP_ID,
      alreadyExists: false,
      httpStatus: 202,
    });
  });
});

describe("requestTranslation failure answers", () => {
  test.each([
    [400, "the language is not translatable"],
    [403, "Forbidden"],
    [404, "Not found"],
    [409, "Translation already in flight"],
    [429, "Attempt budget exhausted"],
    [500, "Internal server error"],
  ])("throws TranslationRequestError carrying the %i", async (status, serverMessage) => {
    translationsAnswer = jsonResponse(status, { message: serverMessage });
    const client = new IEPDocumentClient(appConfig);

    const error = await client
      .requestTranslation(IEP_ID, "es")
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(TranslationRequestError);
    expect((error as TranslationRequestError).httpStatus).toBe(status);
  });

  test("never surfaces the server's own message to the caller", async () => {
    translationsAnswer = jsonResponse(403, {
      message: "User 4f2a is not the owner of document iep-789 in table AIEPDocuments",
    });
    const client = new IEPDocumentClient(appConfig);

    const error = (await client
      .requestTranslation(IEP_ID, "es")
      .catch((err: unknown) => err)) as TranslationRequestError;

    // The endpoint's bodies are generic by design and the repo does not leak
    // causes to callers; the UI translates the code itself.
    expect(error.message).toBe("Translation request failed with status 403");
    expect(error.message).not.toContain("AIEPDocuments");
    expect(error.message).not.toContain("owner");
  });

  test("does not read the error body at all on a non-2xx", async () => {
    const readBody = vi.fn(async () => ({ message: "nope" }));
    translationsAnswer = { ok: false, status: 409, json: readBody };
    const client = new IEPDocumentClient(appConfig);

    await client.requestTranslation(IEP_ID, "es").catch(() => undefined);

    expect(readBody).not.toHaveBeenCalled();
  });
});
