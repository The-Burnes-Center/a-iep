/**
 * The pending referral capture: what the browser remembers between the first
 * visit on a shared link and the parent's signup.
 *
 * What matters here is the click id. The backend stamps its own time on a click
 * and attribution presents only that id, so the capture must always carry a
 * well-formed one, must never carry a client-side time to send, and must drop a
 * capture that predates click ids rather than strand it.
 */
import { beforeEach, describe, expect, test } from "vitest";
import {
  clearPendingReferral,
  getPendingReferral,
  getPendingReferralCapture,
  newClickId,
  storePendingReferral,
} from "./referral-capture";

const PENDING_KEY = "aiep-pending-ref";
// The backend's CLICK_ID_PATTERN, restated so a drift in either shows up here.
const BACKEND_CLICK_ID = /^[A-Za-z0-9_-]{16,64}$/;

beforeEach(() => {
  window.localStorage.clear();
});

describe("newClickId", () => {
  test("is accepted by the backend's click id pattern and is not repeated", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newClickId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(BACKEND_CLICK_ID);
  });
});

describe("storePendingReferral", () => {
  test("stores the code with a click id and returns the capture, once", () => {
    const first = storePendingReferral("Launch");

    expect(first).not.toBeNull();
    expect(first?.code).toBe("launch");
    expect(first?.clickId).toMatch(BACKEND_CLICK_ID);
    expect(getPendingReferralCapture()).toEqual(first);
    expect(getPendingReferral()).toBe("launch");

    // First touch wins: a second code while one is pending does nothing, so
    // the caller counts one click per capture.
    expect(storePendingReferral("other")).toBeNull();
    expect(getPendingReferralCapture()).toEqual(first);
  });

  test("rejects a value that is not a code", () => {
    expect(storePendingReferral("NO SPACES")).toBeNull();
    expect(window.localStorage.getItem(PENDING_KEY)).toBeNull();
  });

  test("the capture handed to attribution carries no client timestamp", () => {
    storePendingReferral("launch");
    expect(Object.keys(getPendingReferralCapture() ?? {}).sort()).toEqual(["clickId", "code"]);
  });
});

describe("a capture written before click ids existed", () => {
  test("is dropped, so the next visit to a shared link can capture afresh", () => {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify({ code: "launch", at: Date.now() }));

    expect(getPendingReferralCapture()).toBeNull();
    expect(window.localStorage.getItem(PENDING_KEY)).toBeNull();
    expect(storePendingReferral("launch")?.clickId).toMatch(BACKEND_CLICK_ID);
  });

  test.each([42, "short", "has spaces in it, and more", null])("a malformed click id (%s) is dropped too", (clickId) => {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify({ code: "launch", at: Date.now(), clickId }));
    expect(getPendingReferralCapture()).toBeNull();
  });
});

describe("expiry and clearing", () => {
  test("a capture older than 30 days is discarded", () => {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    window.localStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ code: "launch", at: old, clickId: newClickId() }),
    );
    expect(getPendingReferralCapture()).toBeNull();
  });

  test("clearPendingReferral removes it", () => {
    storePendingReferral("launch");
    clearPendingReferral();
    expect(getPendingReferralCapture()).toBeNull();
  });
});
