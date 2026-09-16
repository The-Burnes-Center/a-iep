import { defineConfig } from "vitest/config";

// Frontend unit tests run on Vitest, not on the repo's root jest config.
//
// jest.config.js at the repo root has only the node-env `lambdas` and `infra`
// projects: no jsdom, and no TypeScript/JSX transform for this app, so it
// cannot execute a React component test at all. Vitest reuses the Vite and
// tsconfig setup that already builds this app (esbuild picks up
// `"jsx": "react-jsx"` from tsconfig.json, so no extra plugin is needed), and
// living inside lib/user-interface/app keeps the two suites disjoint — root
// `npm test` never sees these files and this config never sees the lambdas.
export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // Every test declares the Auth/fetch answers it needs. Carrying an
    // implementation over from the previous test is how a suite starts
    // passing for the wrong reason.
    mockReset: true,
    unstubGlobals: true,
    server: {
      deps: {
        // @cantoo/pdf-lib's ESM entry imports its bundled font metrics as
        // plain `.json`, which Node's own ESM loader rejects without an
        // `import ... with { type: "json" }` attribute. Vitest externalises
        // node_modules by default, so that entry is loaded by Node and the
        // import throws; inlining it routes the package through Vite
        // instead, which inlines JSON exactly as the production build does.
        // Without this the module simply fails to import and pdf-decrypt.ts
        // silently falls back to rasterizing every file -- which still
        // "passes" any test that only asserts a file comes back, so the
        // lossless tests assert on the PDF's bytes rather than on that.
        inline: ["@cantoo/pdf-lib"],
      },
    },
  },
});
