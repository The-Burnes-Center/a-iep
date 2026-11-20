import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SAVES_WAIT_MAX_MS, queueSurveySave, surveySavesSettled } from "./survey-saves";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("survey saves", () => {
  test("run one at a time, in the order they were made, even when one fails", async () => {
    const order: string[] = [];
    const later = (label: string, ms: number, fails = false) => () =>
      new Promise<string>((resolve, reject) => setTimeout(() => {
        order.push(label);
        if (fails) reject(new Error(label)); else resolve(label);
      }, ms));
    const first = queueSurveySave("order", later("slow", 300, true));
    const second = queueSurveySave("order", later("fast", 10));
    await vi.advanceTimersByTimeAsync(400);
    await expect(first).rejects.toThrow("slow");
    await expect(second).resolves.toBe("fast");
    expect(order).toEqual(["slow", "fast"]);
  });

  test("a read waits for the saves ahead of it", async () => {
    let landed = false;
    void queueSurveySave("wait", () => new Promise<void>((resolve) => setTimeout(() => { landed = true; resolve(); }, 200)));
    let read = false;
    void surveySavesSettled("wait").then(() => { read = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toBe(false);
    await vi.advanceTimersByTimeAsync(150);
    expect(landed && read).toBe(true);
  });

  test("but not for longer than the cap, when a save never answers", async () => {
    void queueSurveySave("stuck", () => new Promise<void>(() => undefined));
    let read = false;
    void surveySavesSettled("stuck").then(() => { read = true; });
    await vi.advanceTimersByTimeAsync(SAVES_WAIT_MAX_MS - 1);
    expect(read).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toBe(true);
  });

  test("a child with no saves is read at once", async () => {
    await expect(surveySavesSettled("none")).resolves.toBeUndefined();
  });
});
