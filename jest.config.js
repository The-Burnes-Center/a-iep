/**
 * Jest runs the Node lambda unit tests under test/lambdas/.
 *
 * Tests live outside lib/chatbot-api/functions/ on purpose: every function
 * directory is zipped verbatim by lambda.Code.fromAsset, so colocated tests
 * would ship to prod and churn the deploy asset cache (keyed on
 * hashFiles('lib/chatbot-api/functions/**')).
 *
 * test/gen-ai-mvp.test.ts is the commented-out CDK scaffold; keep roots
 * narrowed so its compiled .js twin doesn't register as an empty suite.
 */
/**
 * Run via `npm test` (which passes --experimental-vm-modules to node): the
 * knowledge-management handlers are ES modules, and jest can only load
 * .test.mjs suites with vm-modules enabled. The flag is harmless for the
 * CJS suites.
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test/lambdas'],
  testMatch: ['**/*.test.js', '**/*.test.mjs'],
  clearMocks: true,
};
