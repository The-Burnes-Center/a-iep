/**
 * The bootstrap stylesheet is declared in index.html (LTR), and the JS only
 * changes its href for RTL languages. These tests load the module the way the
 * app does: once, at import, against whatever <head> the page already has.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const LTR_HREF = '/vendor/bootstrap.min.css';
const RTL_HREF = '/vendor/bootstrap.rtl.min.css';
const ICONS_HREF = '/vendor/bootstrap-icons.min.css';

const loadDirection = async () => {
  vi.resetModules();
  return import('./direction');
};

const bootstrapLinks = () => document.querySelectorAll<HTMLLinkElement>('#bootstrap-css');

beforeEach(() => {
  // The prefetch of the other build waits on an idle callback or a timer.
  // Fake timers keep that from running after the test ends.
  vi.useFakeTimers();
  document.head.innerHTML = '';
  document.documentElement.removeAttribute('dir');
  document.documentElement.removeAttribute('lang');
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('bootstrap stylesheet from index.html', () => {
  test('reuses the LTR link the page declares instead of adding a second one', async () => {
    document.head.innerHTML = `<link id="bootstrap-css" rel="stylesheet" href="${LTR_HREF}">
      <link rel="stylesheet" href="${ICONS_HREF}">`;

    await loadDirection();

    expect(bootstrapLinks()).toHaveLength(1);
    expect(bootstrapLinks()[0].getAttribute('href')).toBe(LTR_HREF);
    expect(document.documentElement.dir).toBe('ltr');
  });

  test('swaps the declared link to the RTL build for Arabic, and back for English', async () => {
    localStorage.setItem('aiep-language-preference', 'ar');
    document.head.innerHTML = `<link id="bootstrap-css" rel="stylesheet" href="${LTR_HREF}">`;

    const direction = await loadDirection();

    expect(bootstrapLinks()[0].getAttribute('href')).toBe(RTL_HREF);
    expect(document.documentElement.dir).toBe('rtl');

    direction.applyDirection('en');

    expect(bootstrapLinks()[0].getAttribute('href')).toBe(LTR_HREF);
    expect(document.documentElement.dir).toBe('ltr');
  });

  test('creates the link ahead of the other stylesheets when the page has none', async () => {
    document.head.innerHTML = `<link rel="stylesheet" href="${ICONS_HREF}">`;

    await loadDirection();

    const link = bootstrapLinks()[0];
    const icons = document.querySelector<HTMLLinkElement>(`link[href="${ICONS_HREF}"]`);
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe(LTR_HREF);
    // DOCUMENT_POSITION_FOLLOWING: the icons sheet comes after bootstrap, so
    // the app's own CSS still wins the cascade.
    expect(link.compareDocumentPosition(icons!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
