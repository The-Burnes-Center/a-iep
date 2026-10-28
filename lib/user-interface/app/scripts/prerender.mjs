// Writes the prerendered public pages and 404.html into dist/ (see
// src/prerender/page-html.ts for why and where the markup goes).
//
// Runs after `vite build` and `vite build --ssr src/prerender/render-page.tsx`,
// which bundles the page renderer into dist-ssr/. A few modules touch the
// document when they load (common/direction.ts picks the Bootstrap build), so
// the render runs against a jsdom window, the same one the vitest suite uses.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(appDir, "dist");

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
  url: "https://a-iep.org/",
});
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (!(key in globalThis)) {
    try {
      globalThis[key] = dom.window[key];
    } catch {
      // A few window properties are getters that throw outside a browsing
      // context. Nothing the render reads is among them.
    }
  }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;

// React warns that useLayoutEffect does nothing on the server, once per
// component. True and expected: nothing here is hydrated.
const warn = console.error;
console.error = (message, ...rest) => {
  if (typeof message === "string" && message.includes("useLayoutEffect does nothing on the server")) return;
  warn(message, ...rest);
};

const { buildPrerenderedFiles } = await import(path.join(appDir, "dist-ssr", "render-page.js"));
const template = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
for (const { file, html } of buildPrerenderedFiles(template)) {
  fs.writeFileSync(path.join(distDir, file), html, "utf8");
  console.log(`prerender: ${file} (${html.length} bytes)`);
}

// jsdom and the app's modules leave timers behind; the files are written.
process.exit(0);
