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
  },
});
