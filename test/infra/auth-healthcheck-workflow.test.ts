/**
 * Runs the auth healthcheck's "checks" step for real, under the same
 * `bash -e` GitHub Actions uses, against fake smoke scripts.
 *
 * Two regressions this pins, both seen on 2026-09-28:
 *
 *  - Scheduled workflows run from main, so a single checkout checked staging
 *    with main's smoke script. Once staging deployed a contract change that
 *    main's script did not know about, every run failed against staging
 *    until the next promotion. Each environment must be checked by the
 *    script from the branch that deployed it.
 *
 *  - `out=$(smoke-test.sh)` under `bash -e` aborted the step on the first
 *    failing environment, before the report or the failed list were written,
 *    so the alert said nothing about which check failed, and any environment
 *    after it was never checked.
 */
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const WORKFLOW = path.join(__dirname, '..', '..', '.github', 'workflows', 'auth_healthcheck.yml');

/** The `run: |` body of the step with `id: checks`, dedented. */
function checksStepScript(): string {
  const lines = fs.readFileSync(WORKFLOW, 'utf8').split('\n');
  const idLine = lines.findIndex((l) => /^\s+id: checks\s*$/.test(l));
  expect(idLine).toBeGreaterThan(-1);
  const runLine = lines.findIndex((l, i) => i > idLine && /^\s+run: \|\s*$/.test(l));
  expect(runLine).toBeGreaterThan(idLine);
  const runIndent = lines[runLine].search(/\S/);
  const body: string[] = [];
  for (const line of lines.slice(runLine + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= runIndent) break;
    body.push(line);
  }
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(indent)).join('\n');
}

/** The checkout `path:` for a given `ref:` in the workflow's checkout steps. */
function checkoutPathFor(ref: string): string | undefined {
  const text = fs.readFileSync(WORKFLOW, 'utf8');
  const steps = text.split(/\n\s+- name: /);
  const step = steps.find((s) => s.includes('actions/checkout') && new RegExp(`\\bref: ${ref}\\b`).test(s));
  return step?.match(/\bpath: (\S+)/)?.[1];
}

function fakeSmokeScript(dir: string, body: string) {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'smoke-test.sh'), `#!/bin/bash\n${body}\n`);
}

describe('auth healthcheck workflow', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-healthcheck-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('checks out main and staging separately', () => {
    expect(checkoutPathFor('main')).toBeDefined();
    expect(checkoutPathFor('staging')).toBeDefined();
    expect(checkoutPathFor('main')).not.toEqual(checkoutPathFor('staging'));
  });

  it("checks each environment with its own branch's script, and reports a failure instead of aborting", () => {
    const prodDir = path.join(tmp, checkoutPathFor('main') ?? 'missing-main-checkout');
    const stagingDir = path.join(tmp, checkoutPathFor('staging') ?? 'missing-staging-checkout');

    // Prod passes with main's script. Staging fails with staging's script.
    // A script at the workspace root must never be the one used.
    fakeSmokeScript(prodDir, 'echo "PASS: fake"; echo "All smoke checks passed for $1"');
    fakeSmokeScript(stagingDir, 'echo "PASS: fake"; echo "FAIL: staging-branch-script-failed"; exit 1');
    fakeSmokeScript(tmp, 'echo "FAIL: root-checkout-script-was-used"; exit 1');

    const outputFile = path.join(tmp, 'github_output');
    fs.writeFileSync(outputFile, '');
    const result = spawnSync('bash', ['-e', '-c', checksStepScript()], {
      cwd: tmp,
      env: { ...process.env, GITHUB_OUTPUT: outputFile },
      encoding: 'utf8',
    });

    const stdout = result.stdout;
    const outputs = fs.readFileSync(outputFile, 'utf8');

    // The step fails, because staging failed...
    expect(result.status).toBe(1);
    // ...but only after checking both environments and writing its outputs.
    expect(stdout).toContain('All smoke checks passed for AIEPStack');
    expect(outputs).toMatch(/^failed=staging\s*$/m);
    expect(outputs).toContain('FAIL: staging-branch-script-failed');
    expect(`${stdout}${outputs}`).not.toContain('root-checkout-script-was-used');
  });

  it('is valid bash', () => {
    expect(() => execFileSync('bash', ['-n', '-c', checksStepScript()])).not.toThrow();
  });
});
