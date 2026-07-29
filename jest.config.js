/**
 * Jest runs two projects:
 *
 *  - lambdas: the Node lambda unit tests under test/lambdas/. Tests live
 *    outside lib/chatbot-api/functions/ on purpose: every function directory
 *    is zipped verbatim by lambda.Code.fromAsset, so colocated tests would
 *    ship to prod and churn the deploy asset cache (keyed on
 *    hashFiles('lib/chatbot-api/functions/**')).
 *
 *  - infra: the CDK assertion suite under test/infra/ (TypeScript via
 *    ts-jest). It synthesizes the staging stack once and pins the
 *    security-critical wiring (API authorizer, Cognito triggers, bucket
 *    public-access blocks, ...).
 *
 * The root tsc build compiles .ts files into gitignored .js twins next to
 * their sources, so both projects are scoped tightly: lambdas only looks
 * under test/lambdas, and infra only matches *.test.ts — a compiled twin of
 * an infra test can never register as a duplicate suite.
 */
/**
 * Run via `npm test` (which passes --experimental-vm-modules to node): the
 * knowledge-management handlers are ES modules, and jest can only load
 * .test.mjs suites with vm-modules enabled. The flag is harmless for the
 * CJS and ts-jest suites.
 */
module.exports = {
  projects: [
    {
      displayName: 'lambdas',
      testEnvironment: 'node',
      roots: ['<rootDir>/test/lambdas'],
      testMatch: ['**/*.test.js', '**/*.test.mjs'],
      clearMocks: true,
    },
    {
      displayName: 'infra',
      testEnvironment: 'node',
      roots: ['<rootDir>/test/infra'],
      testMatch: ['**/*.test.ts'],
      transform: {
        '^.+\\.ts$': 'ts-jest',
      },
      // 'ts' first so lib/ modules resolve to their .ts sources, never to
      // stale compiled .js twins from a previous `npm run build`.
      moduleFileExtensions: ['ts', 'js', 'json', 'node'],
      clearMocks: true,
    },
  ],
};
