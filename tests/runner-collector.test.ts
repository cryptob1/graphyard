import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { assembleResult, attributeExecution, collectArtifacts, selfReportedObservation, type TargetObservation } from '../src/runner-collector.js';
import type { AttemptGrant, ExecutionRecord } from '../src/runner-executor.js';

const run = promisify(execFile);
const bundle = `sha256:${'a'.repeat(64)}`, image = `sha256:${'b'.repeat(64)}`;
const grant: AttemptGrant = { requestId: randomUUID(), attemptId: randomUUID(), epoch: 1, runner: { id: 'preview-runner', revision: 1 },
  bundleDigest: bundle, runnerImageDigest: image, targetUrl: 'https://preview.example.test/', deadline: '2026-09-16T01:00:00.000Z' };
const startedAt = '2026-09-16T00:00:00.000Z', finishedAt = '2026-09-16T00:01:00.000Z';
const expected = { instance: 'preview-7f3a', artifacts: [{ service: 'api', digest: `sha256:${'c'.repeat(64)}` }] };
const seen = (at: string, over: Partial<TargetObservation> = {}): TargetObservation => ({ at, measurement: 'provider', ...expected, ...over });
const covering = [seen(startedAt), seen('2026-09-16T00:00:30.000Z'), seen(finishedAt)];
const record = (over: Partial<ExecutionRecord> = {}): ExecutionRecord => ({
  grant, startedAt, finishedAt,
  phases: [{ phase: 'enumerate', exitCode: 0, timedOut: false, durationMs: 10 }, { phase: 'execute', exitCode: 0, timedOut: false, durationMs: 100 }],
  bundleDigestBefore: bundle, bundleDigestAfter: bundle, runnerImageDigest: image,
  outcome: 'completed', refusals: [], outputPath: '/nonexistent', settlement: { settled: true, containers: [] }, ...over });

const id = (n: string) => createHash('sha256').update(n).digest('hex');
const declaration = (n: string) => ({ id: id(n), expected: 'passed', location: { file: 'suite.spec.ts', line: 1, column: 1 } });
const inventoryOf = (names: string[]) => ({ format: 'graphyard-playwright-v1', declared: names.map(declaration).sort((a, b) => a.id.localeCompare(b.id)), executions: [], steps: [], errors: 0, overflow: false, status: 'passed' });
const executionOf = (names: string[], status = 'passed') => ({ ...inventoryOf(names), executions: names.map(n => ({ id: id(n), status, retry: 0 })), status: status === 'passed' ? 'passed' : 'failed' });
const collectedOf = (inventory: unknown, execution: unknown, reasons: string[] = []) =>
  ({ artifacts: [{ name: 'inventory', digest: `sha256:${'1'.repeat(64)}`, document: inventory }, { name: 'report', digest: `sha256:${'2'.repeat(64)}`, document: execution }], reasons });
const uploadedOf = (collected: ReturnType<typeof collectedOf>) => collected.artifacts.map(a => ({ name: a.name, digest: a.digest, url: `graphyard-artifact://owner/repo/${grant.requestId}/${a.name}` }));
const required = ['inventory', 'report'];
function assemble(over: Partial<Parameters<typeof assembleResult>[0]> = {}) {
  const collected = collectedOf(inventoryOf(['books']), executionOf(['books']));
  return assembleResult({ grant, execution: record(), expected, observations: covering, maxGapMs: 30_000, collected, uploaded: uploadedOf(collected), requiredArtifacts: required, ...over });
}

test('whole-run attribution refuses A -> B -> A rollouts and uncovered intervals', () => {
  const other = { instance: 'preview-7f3a', artifacts: [{ service: 'api', digest: `sha256:${'d'.repeat(64)}` }] };
  assert.equal(attributeExecution({ expected, observations: covering, startedAt, finishedAt, maxGapMs: 30_000 }).attribution, 'matched');

  // Identical boundary probes hide a mid-run rollout; only continuous coverage decides.
  const boundaryOnly = attributeExecution({ expected, observations: [seen(startedAt), seen(finishedAt)], startedAt, finishedAt, maxGapMs: 30_000 });
  assert.equal(boundaryOnly.attribution, 'unknown');
  assert.equal(boundaryOnly.coversEntireRun, false);
  assert.ok(boundaryOnly.reasons.some(r => /not continuously covered/.test(r)));

  const rollout = attributeExecution({ expected, observations: [seen(startedAt), seen('2026-09-16T00:00:30.000Z', other), seen(finishedAt)], startedAt, finishedAt, maxGapMs: 30_000 });
  assert.equal(rollout.attribution, 'changed');
  assert.ok(rollout.reasons.some(r => /different artifacts during the execution interval/.test(r)));

  assert.equal(attributeExecution({ expected, observations: [seen(startedAt), seen('2026-09-16T00:00:30.000Z'), seen(finishedAt, other)], startedAt, finishedAt, maxGapMs: 30_000 }).attribution, 'mismatched');
  assert.equal(attributeExecution({ expected, observations: covering.slice(1), startedAt, finishedAt, maxGapMs: 30_000 }).attribution, 'unknown');
  assert.equal(attributeExecution({ expected, observations: covering.slice(0, 2), startedAt, finishedAt, maxGapMs: 30_000 }).attribution, 'unknown');
  assert.equal(attributeExecution({ expected, observations: [], startedAt, finishedAt, maxGapMs: 30_000 }).attribution, 'unknown');

  // An application-served version string is a diagnostic, never runtime identity.
  const selfReported = attributeExecution({ expected, observations: [seen(startedAt), selfReportedObservation('2026-09-16T00:00:30.000Z', expected.instance), seen(finishedAt)], startedAt, finishedAt, maxGapMs: 30_000 });
  assert.equal(selfReported.attribution, 'unknown');
  assert.equal(selfReported.measurement, 'unknown');
  assert.ok(selfReported.reasons.some(r => /application self-reports do not count/.test(r)));
  assert.equal(attributeExecution({ expected, observations: covering.map(o => ({ ...o, measurement: 'host-attestation' as const })), startedAt, finishedAt, maxGapMs: 30_000 }).measurement, 'host-attestation');
});

test('a mismatched authority binding produces no publishable result at all', () => {
  assert.equal(assemble({ execution: record({ grant: { ...grant, attemptId: randomUUID() } }) }).report, null);
  assert.equal(assemble({ execution: record({ grant: { ...grant, epoch: 2 } }) }).report, null);
  assert.equal(assemble({ execution: record({ grant: { ...grant, runner: { id: 'other-runner', revision: 1 } } }) }).report, null);
  assert.ok(assemble().report);
  // A record is data, not authority: a malformed one refuses rather than being trusted.
  for (const malformed of [{ ...record(), refusals: undefined }, { ...record(), settlement: undefined }, { ...record(), outcome: 'partly' }, { ...record(), bundleDigestAfter: 'not-a-digest' }, { ...record(), extra: true }]) {
    assert.throws(() => assemble({ execution: malformed as never }));
  }
});

test('collected facts become an independently computed result, and refusals never become a pass', () => {
  const clean = assemble();
  assert.deepEqual(clean.refusals, []);
  assert.deepEqual(clean.report, { requestId: grant.requestId, attemptId: grant.attemptId, epoch: 1, execution: 'completed', behavior: 'passed',
    executed: 1, skipped: 0, inventoryComplete: true,
    target: { instance: expected.instance, artifacts: expected.artifacts, measurement: 'provider', coversEntireRun: true, attribution: 'matched' },
    bundleDigest: bundle, runnerImageDigest: image,
    artifacts: [{ name: 'inventory', digest: `sha256:${'1'.repeat(64)}`, url: `graphyard-artifact://owner/repo/${grant.requestId}/inventory` }, { name: 'report', digest: `sha256:${'2'.repeat(64)}`, url: `graphyard-artifact://owner/repo/${grant.requestId}/report` }],
    artifactState: 'verified', executionSettled: true });

  // A product failure and an infrastructure block are different states; neither passes.
  const failing = assemble({ collected: collectedOf(inventoryOf(['books']), executionOf(['books'], 'failed')) });
  assert.equal(failing.report!.behavior, 'failed');
  const blocked = assemble({ execution: record({ refusals: ['Approved oracle bundle changed during the attempt'], outcome: 'failed' }) });
  assert.equal(blocked.report!.behavior, 'blocked');
  assert.ok(blocked.refusals.includes('Approved oracle bundle changed during the attempt'));
  const timedOut = assemble({ execution: record({ outcome: 'timed_out' }) });
  assert.equal(timedOut.report!.execution, 'timed_out');
  assert.equal(timedOut.report!.behavior, 'blocked');
  assert.equal(assemble({ cancelled: true }).report!.execution, 'cancelled');

  // The collector re-derives boundary facts from the grant rather than trusting the record.
  for (const tampered of [{ bundleDigestAfter: `sha256:${'e'.repeat(64)}` }, { bundleDigestBefore: `sha256:${'e'.repeat(64)}` }, { runnerImageDigest: `sha256:${'e'.repeat(64)}` }, { phases: [{ phase: 'execute' as const, exitCode: 0, timedOut: false, durationMs: 1 }] }]) {
    const claimed = assemble({ execution: record({ ...tampered, refusals: [], outcome: 'completed' }) });
    assert.equal(claimed.report!.behavior, 'blocked');
    assert.ok(claimed.refusals.length);
  }

  // Unsettled execution keeps the resource barrier closed rather than releasing a retry.
  assert.equal(assemble({ execution: record({ settlement: { settled: false, containers: [{ name: 'graphyard-execute-1', state: 'unknown' }] } }) }).report!.executionSettled, false);
});

test('missing, skipped, inconsistent and unstored artifacts never produce success', () => {
  const missing = assemble({ collected: { artifacts: [], reasons: ['Required artifact report is missing or unreadable at the execution boundary'] }, uploaded: [] });
  assert.equal(missing.report!.artifactState, 'missing');
  assert.equal(missing.report!.behavior, 'blocked');
  assert.equal(missing.report!.inventoryComplete, false);

  const collected = collectedOf(inventoryOf(['books']), executionOf(['books']));
  const badUpload = assemble({ collected, uploaded: uploadedOf(collected).map(a => a.name === 'report' ? { ...a, digest: `sha256:${'f'.repeat(64)}` } : a) });
  assert.equal(badUpload.report!.artifactState, 'upload-failed');
  assert.ok(badUpload.refusals.some(r => /not durably stored/.test(r)));

  const skipped = assemble({ collected: collectedOf(inventoryOf(['books']), executionOf(['books'], 'skipped')) });
  assert.equal(skipped.report!.skipped, 1);
  assert.notEqual(skipped.report!.behavior, 'passed');

  const partial = assemble({ collected: collectedOf(inventoryOf(['books', 'checkout']), executionOf(['books'])) });
  assert.equal(partial.report!.inventoryComplete, false);
  assert.equal(partial.report!.behavior, 'failed');

  const unparseable = assemble({ collected: collectedOf(inventoryOf(['books']), { not: 'a report' }) });
  assert.equal(unparseable.report!.behavior, 'unmeasured');
  assert.ok(unparseable.refusals.some(r => /could not be verified against the enumerated inventory/.test(r)));
});

test('collection accepts only approved reporter output from the attempt boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-collect-'));
  try {
    const output = join(root, 'output'); await mkdir(output, { mode: 0o700 });
    await writeFile(join(output, 'inventory.json'), JSON.stringify(inventoryOf(['books'])));
    await writeFile(join(output, 'report.json'), JSON.stringify(executionOf(['books'])));
    const collected = await collectArtifacts(output, required);
    assert.equal(collected.complete, true);
    assert.deepEqual(collected.artifacts.map(a => a.name), ['inventory', 'report']);
    assert.ok(collected.artifacts.every(a => a.mediaType === 'application/json' && /^sha256:[a-f0-9]{64}$/.test(a.digest)));

    // Rich captures that cannot yet meet the protection policy are refused, not uploaded.
    const unprotected = await collectArtifacts(output, [...required, 'trace']);
    assert.equal(unprotected.complete, false);
    assert.ok(unprotected.reasons.some(r => /no collector implementation meeting the capture policy/.test(r)));
    assert.ok(!unprotected.artifacts.some(a => a.name === 'trace'));

    await writeFile(join(output, 'stray.json'), '{}');
    assert.ok((await collectArtifacts(output, required)).reasons.some(r => /the approved reporter did not write/.test(r)));
    await rm(join(output, 'stray.json'));

    await rm(join(output, 'report.json'));
    await writeFile(join(root, 'elsewhere.json'), JSON.stringify(executionOf(['books'])));
    await symlink(join(root, 'elsewhere.json'), join(output, 'report.json'));
    assert.ok((await collectArtifacts(output, required)).reasons.some(r => /missing or unreadable/.test(r)));
    await rm(join(output, 'report.json'));

    await writeFile(join(output, 'report.json'), JSON.stringify({ passed: true, note: 'candidate-authored proof' }));
    assert.ok((await collectArtifacts(output, required)).reasons.some(r => /not an approved data-minimised report/.test(r)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a real Playwright attempt is collected end to end, and a broken assertion fails acceptance', async () => {
  // Locally authored trusted fixtures stand in for an approved oracle bundle; no
  // untrusted repository code executes here.
  const root = await mkdtemp(resolve('.graphyard-collector-test-'));
  try {
    const config = join(root, 'playwright.config.ts'), spec = join(root, 'suite.spec.ts');
    await writeFile(config, `export default { testDir: '.', retries: 0, workers: 1, reporter: [[${JSON.stringify(resolve('src/playwright-reporter.ts'))}]] };`);
    const output = join(root, 'output'); await mkdir(output, { mode: 0o700 });
    async function phase(file: string, list: boolean) {
      try { await run(process.execPath, [resolve('node_modules/playwright/cli.js'), 'test', '--config', config, ...(list ? ['--list'] : [])], { env: { ...process.env, GRAPHYARD_REPORT_FILE: join(output, file) }, timeout: 60_000 }); } catch { /* behaviour is read from the report, not the exit code */ }
    }
    await writeFile(spec, `import { test, expect } from '@playwright/test'; test('books are listed', async () => { await test.step('private-step-marker', async () => { expect(1).toBe(1); }); });`);
    await phase('inventory.json', true);
    await phase('report.json', false);
    const collected = await collectArtifacts(output, required);
    assert.equal(collected.complete, true);
    const passed = assembleResult({ grant, execution: record(), expected, observations: covering, maxGapMs: 30_000, collected, uploaded: uploadedOf(collected as never), requiredArtifacts: required });
    assert.deepEqual(passed.refusals, []);
    assert.equal(passed.report!.behavior, 'passed');
    assert.equal(passed.report!.executed, 1);
    assert.equal(passed.report!.target.attribution, 'matched');
    assert.ok(!JSON.stringify(passed.report).includes('private-step-marker'));

    await rm(join(output, 'report.json'));
    await writeFile(spec, `import { test, expect } from '@playwright/test'; test('books are listed', async () => { await test.step('assert listing', async () => { expect('private-error-marker').toBe('listed'); }); });`);
    await phase('report.json', false);
    const brokenCollected = await collectArtifacts(output, required);
    const broken = assembleResult({ grant, execution: record(), expected, observations: covering, maxGapMs: 30_000, collected: brokenCollected, uploaded: uploadedOf(brokenCollected as never), requiredArtifacts: required });
    assert.equal(broken.report!.behavior, 'failed');
    assert.ok(broken.refusals.length);
    // The trace locates the failing test and step without echoing candidate strings.
    const trace = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
    assert.ok(trace.steps.some((s: { failed: boolean }) => s.failed));
    assert.ok(!JSON.stringify(broken.report).includes('private-error-marker'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
