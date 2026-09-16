import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { oracleBundleDigest } from '../src/runner-setup.js';
import { assertIsolation, assertRunnerCredentialScope, containerEnvironment, executeAttempt, executionCommand, type ExecutionPlan, type Runner, type Settler } from '../src/runner-executor.js';

const image = `sha256:${'1'.repeat(64)}`;
const runAsUser = `${process.getuid!()}:${process.getgid!()}`;
async function boundary(run: (paths: { oracle: string; output: string; plan: ExecutionPlan }) => Promise<void>, files: Record<string, string> = { 'playwright.config.ts': 'export default {};', 'suite.spec.ts': 'approved assertion' }) {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-executor-'));
  const oracle = join(root, 'oracle'), output = join(root, 'output');
  await mkdir(oracle, { mode: 0o755 }); await mkdir(output, { mode: 0o700 });
  for (const [path, content] of Object.entries(files)) await writeFile(join(oracle, path), content);
  const bundle = await oracleBundleDigest(oracle);
  const plan: ExecutionPlan = { grant: { requestId: randomUUID(), attemptId: randomUUID(), epoch: 1, runner: { id: 'preview-runner', revision: 1 },
      bundleDigest: bundle.digest, runnerImageDigest: image, targetUrl: 'https://preview.example.test/', deadline: new Date(Date.now() + 600_000).toISOString() },
    imageRepository: 'ghcr.io/example/graphyard-runner', oraclePath: oracle, outputPath: output, network: 'gy-isolated', timeoutMs: 60_000, memoryMb: 2048, cpus: 2, pidsLimit: 256, runAsUser };
  try { await run({ oracle, output, plan }); } finally { await rm(root, { recursive: true, force: true }); }
}
const settledRunner: Runner = async () => ({ exitCode: 0, timedOut: false });
const absent: Settler = async () => 'absent';
const at = (start: number) => { let n = start; return () => new Date(n += 1000); };

test('bundle identity covers every regular file and refuses symlinks, generated trees and secrets', async () => boundary(async ({ oracle, plan }) => {
  const first = await oracleBundleDigest(oracle);
  assert.equal(first.digest, plan.grant.bundleDigest);
  assert.deepEqual(first.files.map(f => f.path), ['playwright.config.ts', 'suite.spec.ts']);
  await writeFile(join(oracle, 'suite.spec.ts'), 'weakened assertion');
  assert.notEqual((await oracleBundleDigest(oracle)).digest, first.digest);
  await writeFile(join(oracle, 'suite.spec.ts'), 'approved assertion');
  assert.equal((await oracleBundleDigest(oracle)).digest, first.digest);
  await symlink('/etc/passwd', join(oracle, 'link.ts'));
  await assert.rejects(oracleBundleDigest(oracle), /cannot contain symlinks/);
  await rm(join(oracle, 'link.ts'));
  await mkdir(join(oracle, 'node_modules')); await writeFile(join(oracle, 'node_modules', 'shadow.js'), 'redirected import');
  await assert.rejects(oracleBundleDigest(oracle), /ordinary relative source files/);
}));

test('the execution command pins the image, mounts approved bytes read-only and carries no credentials', async () => boundary(async ({ plan }) => {
  const execute = executionCommand(plan, 'execute'), enumerate = executionCommand(plan, 'enumerate');
  const argv = execute.argv.join(' ');
  assert.ok(argv.includes(`${plan.imageRepository}@${image}`));
  assert.ok(argv.includes(`--mount=type=bind,source=${plan.oraclePath},target=/oracle,readonly`));
  assert.ok(argv.includes(`--mount=type=bind,source=${plan.outputPath},target=/output`));
  for (const flag of ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=2048m', '--memory-swap=2048m', '--cpus=2', '--pids-limit=256', '--tmpfs=/scratch:rw,noexec,nosuid,nodev,size=512m', `--user ${runAsUser}`, '--workdir /scratch']) assert.ok(argv.includes(flag), flag);
  assert.ok(enumerate.argv.join(' ').includes('--network none'), 'inventory enumeration runs offline');
  assert.ok(argv.includes('--network gy-isolated'));
  assert.equal(enumerate.env.GRAPHYARD_TARGET_URL, undefined);
  assert.equal(execute.env.GRAPHYARD_TARGET_URL, plan.grant.targetUrl);
  assert.equal(execute.env.GRAPHYARD_REPORT_FILE, '/output/report.json');
  assert.equal(enumerate.env.GRAPHYARD_REPORT_FILE, '/output/inventory.json');
  for (const variable of ['GRAPHYARD_TOKEN', 'NODE_OPTIONS', 'NODE_PATH', 'GITHUB_TOKEN', 'RAILWAY_TOKEN', 'DATABASE_URL', 'npm_config_registry']) assert.equal((execute.env as Record<string, string>)[variable], undefined, variable);
  assert.deepEqual(Object.keys(containerEnvironment(plan, 'enumerate')).sort(), ['CI', 'GRAPHYARD_PHASE', 'GRAPHYARD_REPORT_FILE', 'HOME', 'TMPDIR']);
}));

test('a runner credential may never carry evidence-producer scope', () => {
  assert.deepEqual(assertRunnerCredentialScope({ actor: { id: 'preview-runner', role: 'worker' } }), { id: 'preview-runner', role: 'worker' });
  for (const status of [null, {}, { actor: { id: 'x', role: 'producer' } }, { actor: { id: 'x', role: 'admin' } }, { actor: { id: 'x', role: 'worker', proofs: ['e2e:booking'] } }]) {
    assert.throws(() => assertRunnerCredentialScope(status), /worker-scoped runner credential/);
  }
});

test('isolation refuses overlapping, shared or pre-populated execution boundaries', async () => boundary(async ({ oracle, output, plan }) => {
  await assert.doesNotReject(assertIsolation(plan));
  await mkdir(join(oracle, 'nested'), { mode: 0o700 });
  await assert.rejects(assertIsolation({ ...plan, outputPath: join(oracle, 'nested') }), /must not overlap/);
  await assert.rejects(assertIsolation({ ...plan, outputPath: oracle }), /must not overlap/);
  await rm(join(oracle, 'nested'), { recursive: true });
  await writeFile(join(oracle, 'regular.txt'), 'not a directory');
  await assert.rejects(assertIsolation({ ...plan, outputPath: join(oracle, 'regular.txt') }), /must be a directory/);
  await rm(join(oracle, 'regular.txt'));
  await chmod(oracle, 0o777);
  await assert.rejects(assertIsolation(plan), /group- or world-writable/);
  await chmod(oracle, 0o755);
  await chmod(output, 0o755);
  await assert.rejects(assertIsolation(plan), /private to the collector/);
  await chmod(output, 0o700);
  await assert.rejects(assertIsolation({ ...plan, runAsUser: '65534:65534' }), /owned by the unprivileged container user/);
  await writeFile(join(output, 'planted.json'), '{}');
  await assert.rejects(assertIsolation(plan), /must be empty/);
  await rm(join(output, 'planted.json'));
  const shared = join(output, '..', 'accounts.env');
  await writeFile(shared, 'TEST_ACCOUNT=approved', { mode: 0o644 });
  await assert.rejects(assertIsolation({ ...plan, testAccountEnvFile: shared }), /private regular file/);
  await chmod(shared, 0o600);
  await assert.doesNotReject(assertIsolation({ ...plan, testAccountEnvFile: shared }));
  await rm(shared);
}));

test('an authorized attempt enumerates then executes, and verifies settlement before releasing', async () => boundary(async ({ plan }) => {
  const phases: string[] = [];
  const run: Runner = async command => { phases.push(command.argv.at(-1)!); return { exitCode: 0, timedOut: false }; };
  const record = await executeAttempt(plan, { run, settle: absent, now: at(Date.parse('2026-09-16T00:00:00.000Z')) });
  assert.deepEqual(phases, ['enumerate', 'execute']);
  assert.equal(record.outcome, 'completed');
  assert.deepEqual(record.refusals, []);
  assert.equal(record.bundleDigestAfter, plan.grant.bundleDigest);
  assert.equal(record.settlement.settled, true);
  assert.ok(Date.parse(record.finishedAt) > Date.parse(record.startedAt));
}));

test('pinned bytes are verified before and after execution, so late substitution cannot be accepted', async () => boundary(async ({ oracle, plan }) => {
  const stale = await executeAttempt({ ...plan, grant: { ...plan.grant, bundleDigest: `sha256:${'9'.repeat(64)}` } }, { run: settledRunner, settle: absent });
  assert.deepEqual(stale.phases, []);
  assert.ok(stale.refusals.some(r => /differ from the pinned digest/.test(r)));

  const substituting: Runner = async command => {
    // Model candidate-influenced code replacing an approved helper after preflight.
    if (command.argv.at(-1) === 'execute') await writeFile(join(oracle, 'suite.spec.ts'), 'expect(true).toBe(true)');
    return { exitCode: 0, timedOut: false };
  };
  const mutated = await executeAttempt(plan, { run: substituting, settle: absent });
  assert.notEqual(mutated.bundleDigestAfter, mutated.bundleDigestBefore);
  assert.equal(mutated.outcome, 'failed');
  assert.ok(mutated.refusals.some(r => /changed during the attempt/.test(r)));
}));

test('unverified settlement and timeouts keep the execution-resource barrier closed', async () => boundary(async ({ plan }) => {
  const unknown = await executeAttempt(plan, { run: settledRunner, settle: async () => 'unknown' });
  assert.equal(unknown.settlement.settled, false);
  assert.ok(unknown.refusals.some(r => /settlement is unverified/.test(r)));

  const stillRunning = await executeAttempt(plan, { run: settledRunner, settle: async () => 'present' });
  assert.equal(stillRunning.settlement.settled, false);

  const timeout: Runner = async command => command.argv.at(-1) === 'execute' ? { exitCode: 137, timedOut: true } : { exitCode: 0, timedOut: false };
  const timedOut = await executeAttempt(plan, { run: timeout, settle: absent });
  assert.equal(timedOut.outcome, 'timed_out');
  assert.deepEqual(timedOut.phases.map(p => p.phase), ['enumerate', 'execute']);
}));

test('failed enumeration stops the attempt, and a failing execution still reaches integrity checks', async () => boundary(async ({ plan }) => {
  const badInventory = await executeAttempt(plan, { run: async command => ({ exitCode: command.argv.at(-1) === 'enumerate' ? 2 : 0, timedOut: false }), settle: absent });
  assert.deepEqual(badInventory.phases.map(p => p.phase), ['enumerate']);
  assert.ok(badInventory.refusals.some(r => /inventory enumeration did not complete/.test(r)));

  const failingTests = await executeAttempt(plan, { run: async command => ({ exitCode: command.argv.at(-1) === 'execute' ? 1 : 0, timedOut: false }), settle: absent });
  assert.deepEqual(failingTests.refusals, []);
  assert.equal(failingTests.outcome, 'completed');
  assert.equal(failingTests.phases.at(-1)!.exitCode, 1);
}));

test('an elapsed attempt deadline refuses execution instead of running unauthorized', async () => boundary(async ({ plan }) => {
  const record = await executeAttempt({ ...plan, grant: { ...plan.grant, deadline: new Date(Date.now() - 1000).toISOString() } }, { run: settledRunner, settle: absent });
  assert.deepEqual(record.phases, []);
  assert.ok(record.refusals.some(r => /deadline elapsed/.test(r)));
}));
