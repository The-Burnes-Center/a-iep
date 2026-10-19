/**
 * The two referral calls whose wire shape the backend's attribution depends
 * on: the click beacon sends the client-minted click id, and attribution sends
 * that id and nothing resembling a client-side time. The server records when a
 * click arrived; a `capturedAt` on the wire would be a value it must ignore,
 * and no reason to send one.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ReferralClient } from "./referral-client";
import type { AppConfig } from "../types";

const authenticate = vi.hoisted(() => vi.fn());
vi.mock("../utils", () => ({ Utils: { authenticate } }));

const CLICK_ID = "c1ick-id-abcdefgh-0001";
const config = { httpEndpoint: "https://api.example.test/" } as AppConfig;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  authenticate.mockResolvedValue("token");
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ attributed: true }) }) as Response);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("logClick", () => {
  test("beacons the code and the click id, and nothing else", () => {
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { sendBeacon });

    new ReferralClient(config).logClick("launch", CLICK_ID);

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, payload] = sendBeacon.mock.calls[0] as unknown as [string, string];
    expect(url).toBe("https://api.example.test/referral/click");
    expect(JSON.parse(payload)).toEqual({ code: "launch", clickId: CLICK_ID });
  });

  test("falls back to fetch with the same payload when the beacon is refused", () => {
    vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => false) });

    new ReferralClient(config).logClick("launch", CLICK_ID);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.test/referral/click");
    expect(JSON.parse(String(init.body))).toEqual({ code: "launch", clickId: CLICK_ID });
  });
});

describe("attribute", () => {
  test("posts the code and click id, with no client-side time", async () => {
    const result = await new ReferralClient(config).attribute("launch", CLICK_ID);

    expect(result).toEqual({ attributed: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.test/referral/attribute");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ code: "launch", clickId: CLICK_ID });
    expect(body).not.toHaveProperty("capturedAt");
  });

  test("a server failure throws, so the capture stays pending for a retry", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) } as Response);
    await expect(new ReferralClient(config).attribute("launch", CLICK_ID)).rejects.toThrow();
  });
});
