/**
 * Where the guided tour puts its card. The cases here are the ones that are
 * hard to reach in a browser: a 320px phone, right-to-left, and a target
 * taller than the screen.
 */
import { describe, expect, test } from "vitest";
import {
  Box,
  CARD_GAP,
  CARD_MAX_WIDTH,
  EDGE_MARGIN,
  HIGHLIGHT_PADDING,
  placeCard,
  unionBox,
} from "./guided-tour-layout";

const PHONE = { width: 320, height: 640 };
const CARD_HEIGHT = 200;

const overlaps = (a: Box, b: Box) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

const cardBox = (placed: { top: number; left: number; width: number }, height: number): Box => ({
  top: placed.top,
  left: placed.left,
  right: placed.left + placed.width,
  bottom: placed.top + height,
});

const target = (top: number, height: number, left = 24, width = 200): Box => ({
  top,
  left,
  right: left + width,
  bottom: top + height,
});

describe("placing the card", () => {
  test("goes below a target with room under it", () => {
    const placed = placeCard({ target: target(100, 80), cardHeight: CARD_HEIGHT, viewport: PHONE, rtl: false });

    expect(placed.top).toBe(180 + HIGHLIGHT_PADDING + CARD_GAP);
    expect(placed.highlight).not.toBeNull();
  });

  test("goes above a target near the bottom of the screen", () => {
    const placed = placeCard({ target: target(500, 80), cardHeight: CARD_HEIGHT, viewport: PHONE, rtl: false });

    expect(placed.top + CARD_HEIGHT).toBe(500 - HIGHLIGHT_PADDING - CARD_GAP);
  });

  test("never covers the highlight, wherever the target is", () => {
    for (let top = -50; top <= 600; top += 25) {
      for (const height of [40, 160, 380, 900]) {
        const placed = placeCard({ target: target(top, height), cardHeight: CARD_HEIGHT, viewport: PHONE, rtl: false });
        if (!placed.highlight) continue;
        expect(overlaps(cardBox(placed, CARD_HEIGHT), placed.highlight), `top ${top}, height ${height}`).toBe(false);
      }
    }
  });

  test("stays inside the screen at 320px wide", () => {
    for (const rtl of [false, true]) {
      const placed = placeCard({ target: target(100, 80, 200, 110), cardHeight: CARD_HEIGHT, viewport: PHONE, rtl });

      expect(placed.width).toBe(PHONE.width - 2 * EDGE_MARGIN);
      expect(placed.left).toBeGreaterThanOrEqual(EDGE_MARGIN);
      expect(placed.left + placed.width).toBeLessThanOrEqual(PHONE.width - EDGE_MARGIN);
    }
  });

  test("is no wider than its maximum on a wide screen", () => {
    const placed = placeCard({ target: target(100, 80), cardHeight: CARD_HEIGHT, viewport: { width: 1280, height: 800 }, rtl: false });

    expect(placed.width).toBe(CARD_MAX_WIDTH);
  });
});

describe("reading direction", () => {
  const wide = { width: 1280, height: 800 };

  test("lines up with the target's left edge left-to-right", () => {
    const placed = placeCard({ target: target(100, 80, 300, 200), cardHeight: CARD_HEIGHT, viewport: wide, rtl: false });

    expect(placed.left).toBe(300 - HIGHLIGHT_PADDING);
  });

  test("hangs from the target's right edge right-to-left", () => {
    const placed = placeCard({ target: target(100, 80, 300, 200), cardHeight: CARD_HEIGHT, viewport: wide, rtl: true });

    expect(placed.left + placed.width).toBe(500 + HIGHLIGHT_PADDING);
  });

  test("is clamped on screen when the target is at the far edge", () => {
    const ltr = placeCard({ target: target(100, 80, 1100, 160), cardHeight: CARD_HEIGHT, viewport: wide, rtl: false });
    const rtl = placeCard({ target: target(100, 80, 20, 160), cardHeight: CARD_HEIGHT, viewport: wide, rtl: true });

    expect(ltr.left + ltr.width).toBeLessThanOrEqual(wide.width - EDGE_MARGIN);
    expect(rtl.left).toBeGreaterThanOrEqual(EDGE_MARGIN);
  });
});

describe("a target taller than the screen", () => {
  test("docks the card and trims the highlight to what is left", () => {
    const placed = placeCard({ target: target(60, 1500), cardHeight: CARD_HEIGHT, viewport: PHONE, rtl: false });

    expect(placed.top + CARD_HEIGHT).toBe(PHONE.height - EDGE_MARGIN);
    expect(placed.highlight).not.toBeNull();
    expect(placed.highlight?.bottom).toBe(placed.top - CARD_GAP);
  });

  test("shows no highlight when none of the target is on screen", () => {
    const placed = placeCard({ target: target(-400, 100), cardHeight: CARD_HEIGHT, viewport: PHONE, rtl: false });

    expect(placed.highlight).toBeNull();
    expect(placed.top + CARD_HEIGHT).toBeLessThanOrEqual(PHONE.height - EDGE_MARGIN);
  });

  test("keeps a card taller than the screen inside it", () => {
    const placed = placeCard({ target: target(100, 80), cardHeight: 2000, viewport: PHONE, rtl: false });

    expect(placed.top).toBeGreaterThanOrEqual(EDGE_MARGIN);
  });
});

describe("a target made of several elements", () => {
  test("is the box around all of them", () => {
    expect(unionBox([target(10, 20), target(100, 50, 10, 300)])).toEqual({
      top: 10,
      left: 10,
      right: 310,
      bottom: 150,
    });
  });

  test("is nothing when there are none", () => {
    expect(unionBox([])).toBeNull();
  });
});
