import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyRunnerReport } from '../src/runner-report.js';
const run = promisify(execFile), id = 'a'.repeat(64);
const inventory = { format: 'graphyard-playwright-v1', declared: [{ id, expected: 'passed', location: { file: 'fixture.spec.ts', line: 1, column: 1 } }], executions: [], steps: [], errors: 0, overflow: false, status: 'passed' };
const execution = { ...inventory, executions: [{ id, status: 'passed', retry: 0 }] };
test('report verifier refuses empty, skipped, missing, inconsistent, expected-failing and retry reports', () => {
  assert.equal(verifyRunnerReport(inventory, execution).passed, true);
  for (const changed of [{ declared: [] }, { executions: [] }, { executions: [{ id, status: 'skipped', retry: 0 }] }, { executions: [{ id, status: 'passed', retry: 1 }] }, { overflow: true }, { errors: 1 }, { status: 'failed' }, { steps: [{ test: 'b'.repeat(64), sequence: 1, durationMs: 1, failed: false }] }]) assert.equal(verifyRunnerReport(inventory, { ...execution, ...changed }).passed, false);
  assert.equal(verifyRunnerReport({ ...inventory, declared: [{ ...inventory.declared[0], expected: 'failed' }] }, execution).passed, false);
  assert.throws(() => verifyRunnerReport(inventory, { ...execution, untrusted: 'extra' }));
});
test('real Playwright enumeration/execution produces attributable inventory and excludes seeded secrets', async () => {
  // These are locally authored trusted fixtures; no untrusted repository code is executed here.
  const root = await mkdtemp(resolve('.graphyard-reporter-test-'));
  try {
    const config = join(root, 'playwright.config.ts'), spec = join(root, 'fixture.spec.ts');
    await writeFile(config, `export default { testDir: '.', retries: 0, workers: 1, reporter: [[${JSON.stringify(resolve('src/playwright-reporter.ts'))}]] };`);
    await writeFile(spec, `import { test, expect } from '@playwright/test'; test('private-title-marker', async () => { console.log('private-stdout-marker'); await test.step('private-step-marker', async () => { expect(1).toBe(1); }); });`);
    async function capture(name: string, list: boolean) {
      const path = join(root, name);
      let failed = false;
      try { await run(process.execPath, [fileURLToPath(import.meta.resolve('@playwright/test/cli')), 'test', '--config', config, ...(list ? ['--list'] : [])], { env: { ...process.env, GRAPHYARD_REPORT_FILE: path }, timeout: 30_000 }); } catch { failed = true; }
      return { report: JSON.parse(await readFile(path, 'utf8')), failed };
    }
    const listed = await capture('list.json', true), passed = await capture('pass.json', false);
    assert.equal(passed.report.declared[0].location.file, 'fixture.spec.ts');
    assert.equal(passed.failed, false); assert.equal(verifyRunnerReport(listed.report, passed.report).passed, true);
    const serialized = JSON.stringify(passed.report);
    for (const marker of ['private-title-marker', 'private-stdout-marker', 'private-step-marker']) assert.ok(!serialized.includes(marker));
    await writeFile(spec, `import { test, expect } from '@playwright/test'; test('private-title-marker', async () => { expect('private-error-marker').toBe('broken'); });`);
    const broken = await capture('broken.json', false);
    assert.equal(broken.failed, true); assert.equal(verifyRunnerReport(listed.report, broken.report).passed, false);
    assert.ok(broken.report.steps.some((s: any) => s.failed)); assert.ok(!JSON.stringify(broken.report).includes('private-error-marker'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
