import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, symlink, realpath, rm, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { oracleBundleDigest } from '../src/runner-setup.js';
import { assertAncestryFixed, assertIsolation, assertRunnerCredentialScope, attemptBoundaryPath, boundaryIdentity, containerEnvironment, containerNames, executeAttempt, executionCommand, executionPlanSchema, observeContainers, preflightAttempt, type ExecutionPlan, type Runner, type Settler } from '../src/runner-executor.js';

const image = `sha256:${'1'.repeat(64)}`;
const runAsUser = `${process.getuid!()}:${process.getgid!()}`;
// Execution happens inside the host attestor, and the approved bundle must belong to that
// identity so no other account on the host — the runner's above all — can rewrite it
// mid-attempt. These fixtures own the oracle tree, so they stand in for the attestor;
// `nobody` stands in for any other identity, whose ownership must be refused.
const foreignUid = 65534;
async function boundary(run: (paths: { oracle: string; collection: string; output: string; plan: ExecutionPlan }) => Promise<void>, files: Record<string, string> = { 'playwright.config.ts': 'export default {};', 'suite.spec.ts': 'approved assertion' }) {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-executor-'));
  const oracle = join(root, 'oracle'), collection = join(root, 'output');
  await mkdir(oracle, { mode: 0o755 }); await mkdir(collection, { mode: 0o755 });
  for (const [path, content] of Object.entries(files)) await writeFile(join(oracle, path), content);
  const bundle = await oracleBundleDigest(oracle);
  const plan: ExecutionPlan = { grant: { requestId: randomUUID(), attemptId: randomUUID(), epoch: 1, runner: { id: 'preview-runner', revision: 1 },
      executionHost: 'unix:///var/run/docker.sock', attestationPublicKey: 'test-public-key-material-at-least-32-bytes',
      executionNetwork: 'gy-isolated',
      bundleDigest: bundle.digest, runnerImageDigest: image, targetUrl: 'https://preview.example.test/', deadline: new Date(Date.now() + 600_000).toISOString() },
    imageRepository: 'ghcr.io/example/graphyard-runner', oraclePath: oracle, outputPath: collection, timeoutMs: 60_000, memoryMb: 2048, cpus: 2, pidsLimit: 256, runAsUser };
  // Preflight provisions one boundary per attempt beneath the collection root. The fixture
  // creates the same directory so the structural checks can also be exercised directly.
  const output = attemptBoundaryPath(plan);
  await mkdir(output); await chmod(output, 0o2770);
  try { await run({ oracle, collection, output, plan }); } finally { await rm(root, { recursive: true, force: true }); }
}
const attestorUid = process.getuid!();
/** `assertIsolation` against the boundary this attempt was provisioned, as preflight does. */
const isolation = (plan: ExecutionPlan, options: { uid?: number; gids?: number[] } = {}, boundaryPath?: string) =>
  assertIsolation(plan, { ...options, boundaryPath: boundaryPath ?? attemptBoundaryPath(plan) });
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
  // Every runtime command is addressed to the endpoint the registration pinned, including
  // the `run` that starts the container the collector will later look for.
  assert.deepEqual(execute.argv.slice(0, 3), ['--host', plan.grant.executionHost, 'run']);
  assert.deepEqual(enumerate.argv.slice(0, 3), ['--host', plan.grant.executionHost, 'run']);
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

test('isolation refuses overlapping, shared or pre-populated execution boundaries', async () => boundary(async ({ oracle, collection, output, plan }) => {
  await assert.doesNotReject(isolation(plan, { uid: attestorUid }));
  await mkdir(join(oracle, 'nested')); await chmod(join(oracle, 'nested'), 0o2770);
  await assert.rejects(isolation(plan, { uid: attestorUid }, join(oracle, 'nested')), /must not overlap/);
  await assert.rejects(isolation(plan, { uid: attestorUid }, oracle), /must not overlap/);
  await rm(join(oracle, 'nested'), { recursive: true });
  await writeFile(join(oracle, 'regular.txt'), 'not a directory');
  await assert.rejects(isolation(plan, { uid: attestorUid }, join(oracle, 'regular.txt')), /must be a directory/);
  await rm(join(oracle, 'regular.txt'));
  await chmod(oracle, 0o777);
  await assert.rejects(isolation(plan, { uid: attestorUid }), /group- or world-writable/);
  await chmod(oracle, 0o755);
  // The boundary is shared by three accounts that must not be the same: the attestor owns
  // it, the container writes through the group named in `runAsUser`, and no identity
  // outside that group may traverse it at all.
  await chmod(output, 0o2777);
  await assert.rejects(isolation(plan, { uid: attestorUid }), /closed to every identity outside the trusted boundary group/);
  await chmod(output, 0o2700);
  await assert.rejects(isolation(plan, { uid: attestorUid }), /group read, write and traverse access/);
  await chmod(output, 0o2770);
  await assert.rejects(isolation({ ...plan, runAsUser: `${attestorUid}:65534` }, { uid: attestorUid }), /group-owned by the container's group/);
  // Without membership of that group the attestor could not read the report the container
  // writes, so it refuses now rather than as an EACCES once the target has been exercised.
  await assert.rejects(isolation(plan, { uid: attestorUid, gids: [65534] }), /must belong to the boundary group/);
  await writeFile(join(output, 'planted.json'), '{}');
  await assert.rejects(isolation(plan, { uid: attestorUid }), /must be empty/);
  await rm(join(output, 'planted.json'));
  const shared = join(collection, 'accounts.env');
  await writeFile(shared, 'TEST_ACCOUNT=approved', { mode: 0o644 });
  await assert.rejects(isolation({ ...plan, testAccountEnvFile: shared }, { uid: attestorUid }), /private regular file/);
  await chmod(shared, 0o600);
  await assert.doesNotReject(isolation({ ...plan, testAccountEnvFile: shared }, { uid: attestorUid }));
  await writeFile(shared, 'NODE_OPTIONS=--require=/tmp/forge.js', { mode: 0o600 });
  await assert.rejects(isolation({ ...plan, testAccountEnvFile: shared }, { uid: attestorUid }), /only TEST_ACCOUNT/);
  await rm(shared);
}));

test('the container identity is never root, whatever the runner configures', async () => boundary(async ({ plan }) => {
  // `0:0` with a root-owned boundary would otherwise pass every structural check and run
  // both browser phases as root against a hostile deployment.
  for (const runAsUser of ['0:0', '0:10001', '10001:0']) {
    assert.throws(() => executionPlanSchema.parse({ ...plan, runAsUser }), /non-root UID and GID/, runAsUser);
  }
  assert.equal(executionPlanSchema.parse({ ...plan, runAsUser: '10001:10002' }).runAsUser, '10001:10002');
  // The default is this attestor's own unprivileged identity, and never root either.
  const { runAsUser: fallback, ...withoutUser } = plan;
  assert.ok(!executionPlanSchema.parse(withoutUser).runAsUser.split(':').includes('0'));
}));

test('a sticky ancestor is exempt from the mode rule only, never from ownership', async () => {
  // POSIX sticky rules stop other writers from renaming an entry, which is why a shared
  // `/tmp` is tolerated. They leave the directory's own owner able to rename any child,
  // so a runner-owned mode-1777 parent could still swap the oracle tree or the boundary
  // aside during execution and restore it before the closing inode and digest checks.
  const root = await mkdtemp(join(tmpdir(), 'graphyard-sticky-'));
  const sticky = join(root, 'sticky'), child = join(sticky, 'boundary');
  await mkdir(sticky); await chmod(sticky, 0o1777);
  await mkdir(child, { mode: 0o700 });
  try {
    await assert.doesNotReject(assertAncestryFixed(child, attestorUid, 'collection boundary'));
    await assert.rejects(assertAncestryFixed(child, foreignUid, 'collection boundary'),
      /leading to the collection boundary must be owned by the supervising attestor identity or by root/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an oracle tree any other account can rewrite is refused before any container starts', async () => boundary(async ({ oracle, plan }) => {
  // A read-only container mount does not stop host-side writes. Whoever owns the approved
  // bytes can weaken them after the preflight digest and restore them before the closing
  // one. "Not owned by the account that runs the container" is not enough either, because
  // the runner asking for supervision is a third account again: the bytes must belong to
  // the supervising attestor itself, so no one else on the host can touch them.
  await assert.rejects(isolation(plan, { uid: foreignUid }), /owned by the supervising attestor identity or by root/);
  // Preflight provisions the boundary first, so a collection root belonging to another
  // account is refused before any directory is created beneath it.
  await assert.rejects(preflightAttempt(plan, { uid: foreignUid }), /owned by the supervising attestor identity/);
  // Every entry counts, not just the root: one writable approved file is enough.
  await chmod(join(oracle, 'suite.spec.ts'), 0o666);
  await assert.rejects(isolation(plan, { uid: attestorUid }), /must not be (?:group|world)-writable throughout execution/);
  await chmod(join(oracle, 'suite.spec.ts'), 0o644);
  await mkdir(join(oracle, 'helpers')); await chmod(join(oracle, 'helpers'), 0o775);
  await assert.rejects(isolation(plan, { uid: attestorUid }), /must not be group-writable throughout execution/);
  await rm(join(oracle, 'helpers'), { recursive: true });
  // A directory someone else could rename redirects the mount, so the path leading to the
  // approved bytes is held to the same rule. Sticky shared parents such as `/tmp` are the
  // documented exception, since only an entry's owner can rename it there.
  assert.ok((await stat(tmpdir())).mode & 0o1000, 'the fixture root is a sticky shared directory');
  await assert.doesNotReject(isolation(plan, { uid: attestorUid }));
}));

test('a collection boundary whose pathname another account controls is refused, and a replaced one is recorded', async () => boundary(async ({ collection, output, plan }) => {
  // Checking the output directory's own ownership, mode and emptiness says nothing about
  // who may rename it. An account that can write a parent can move the checked directory
  // aside and leave an earlier attempt's passing output at the same pathname, which both
  // the container mount and the attestor's measurement would follow.
  const shared = join(collection, 'shared');
  await mkdir(shared); await chmod(shared, 0o777);
  const exposed = join(shared, 'attempt');
  await mkdir(exposed); await chmod(exposed, 0o2770);
  await assert.rejects(isolation(plan, { uid: attestorUid }, exposed), /leading to the collection boundary must not be group- or world-writable/);
  await chmod(shared, 0o755);
  await assert.doesNotReject(isolation(plan, { uid: attestorUid }, exposed));
  await rm(shared, { recursive: true });

  // And if the pathname is redirected anyway, the attempt says so rather than reporting
  // whatever directory now answers to the recorded path.
  const swapping: Runner = async command => {
    if (command.argv.at(-1) === 'execute') {
      await rename(output, join(collection, 'displaced'));
      await mkdir(output); await chmod(output, 0o2770);
      await writeFile(join(output, 'report.json'), JSON.stringify({ passed: 'an older attempt' }));
    }
    return { exitCode: 0, timedOut: false };
  };
  const swapped = await executeAttempt(plan, { uid: attestorUid, run: swapping, settle: absent });
  assert.ok(swapped.refusals.some(r => /collection boundary was replaced during the attempt/.test(r)));
  assert.equal(swapped.outcome, 'failed');
}));

test('approved test-account variables are passed by value, never by reopened pathname', async () => boundary(async ({ collection, plan }) => {
  const shared = join(collection, 'accounts.env');
  await writeFile(shared, '# approved\nTEST_ACCOUNT_USER=booking-bot\nTEST_ACCOUNT_PASSWORD=approved secret\n', { mode: 0o600 });
  const withAccounts = { ...plan, testAccountEnvFile: shared };
  const preflight = await preflightAttempt(withAccounts, { uid: attestorUid });
  assert.deepEqual(preflight.testAccountEnv, { TEST_ACCOUNT_USER: 'booking-bot', TEST_ACCOUNT_PASSWORD: 'approved secret' });

  // Docker reopens `--env-file` when the container starts. Nothing in the command refers
  // to the path, so rewriting the file after preflight changes nothing that executes.
  const argv = executionCommand(withAccounts, 'execute', preflight.testAccountEnv).argv;
  assert.ok(!argv.includes('--env-file') && !argv.some(a => a.includes(shared)));
  assert.ok(argv.includes('TEST_ACCOUNT_USER=booking-bot'));
  await writeFile(shared, 'NODE_OPTIONS=--require=/tmp/forge.js\n', { mode: 0o600 });
  assert.deepEqual(executionCommand(withAccounts, 'execute', preflight.testAccountEnv).argv, argv);
  assert.equal(containerEnvironment(withAccounts, 'execute', preflight.testAccountEnv).NODE_OPTIONS, undefined);

  // Approved material is for the target-facing phase only, and never reaches enumeration.
  assert.equal(containerEnvironment(withAccounts, 'enumerate', preflight.testAccountEnv).TEST_ACCOUNT_USER, undefined);
  // Entries that were never validated cannot be handed to the container instead.
  assert.throws(() => executionCommand(withAccounts, 'execute'), /must be read and validated in preflight/);
  assert.throws(() => executionCommand(withAccounts, 'execute', { NODE_OPTIONS: '--require=/tmp/forge.js' }), /Only validated TEST_ACCOUNT/);
  assert.throws(() => executionCommand(withAccounts, 'execute', { TEST_ACCOUNT_USER: 'a\nTEST_ACCOUNT_OTHER=b' }));
  await rm(shared);
}));

test('the execution network is operator-versioned authority, not runner configuration', async () => boundary(async ({ plan }) => {
  // Docker resolves a network name against every network the daemon already has, so a
  // runner-chosen one could attach the browser to databases and other internal services.
  // The name lives in the dispatch grant, which comes from the runner registration.
  assert.ok(executionCommand(plan, 'execute').argv.includes(plan.grant.executionNetwork));
  assert.ok(!Object.keys(executionPlanSchema.shape).includes('network'), 'a runner cannot configure the execution network at all');
  for (const executionNetwork of ['host', 'bridge', 'default', 'none', 'not a network', '']) {
    assert.throws(() => executionCommand({ ...plan, grant: { ...plan.grant, executionNetwork } }, 'execute'));
  }
}));

test('an authorized attempt enumerates then executes, and verifies settlement before releasing', async () => boundary(async ({ plan }) => {
  const phases: string[] = [];
  const run: Runner = async command => { phases.push(command.argv.at(-1)!); return { exitCode: 0, timedOut: false }; };
  const record = await executeAttempt(plan, { uid: attestorUid, run, settle: absent, now: at(Date.parse('2026-09-16T00:00:00.000Z')) });
  assert.deepEqual(phases, ['enumerate', 'execute']);
  assert.equal(record.outcome, 'completed');
  assert.deepEqual(record.refusals, []);
  assert.equal(record.bundleDigestAfter, plan.grant.bundleDigest);
  assert.equal(record.settlement.settled, true);
  assert.ok(Date.parse(record.finishedAt) > Date.parse(record.startedAt));
}));

test('pinned bytes are verified before and after execution, so late substitution cannot be accepted', async () => boundary(async ({ oracle, plan }) => {
  const stale = await executeAttempt({ ...plan, grant: { ...plan.grant, bundleDigest: `sha256:${'9'.repeat(64)}` } }, { uid: attestorUid, run: settledRunner, settle: absent });
  assert.deepEqual(stale.phases, []);
  assert.ok(stale.refusals.some(r => /differ from the pinned digest/.test(r)));

  const substituting: Runner = async command => {
    // Model candidate-influenced code replacing an approved helper after preflight.
    if (command.argv.at(-1) === 'execute') await writeFile(join(oracle, 'suite.spec.ts'), 'expect(true).toBe(true)');
    return { exitCode: 0, timedOut: false };
  };
  const mutated = await executeAttempt(plan, { uid: attestorUid, run: substituting, settle: absent });
  assert.notEqual(mutated.bundleDigestAfter, mutated.bundleDigestBefore);
  assert.equal(mutated.outcome, 'failed');
  assert.ok(mutated.refusals.some(r => /changed during the attempt/.test(r)));
}));

test('unverified settlement and timeouts keep the execution-resource barrier closed', async () => boundary(async ({ plan }) => {
  const unknown = await executeAttempt(plan, { uid: attestorUid, run: settledRunner, settle: async () => 'unknown' });
  assert.equal(unknown.settlement.settled, false);
  assert.ok(unknown.refusals.some(r => /settlement is unverified/.test(r)));

  const stillRunning = await executeAttempt(plan, { uid: attestorUid, run: settledRunner, settle: async () => 'present' });
  assert.equal(stillRunning.settlement.settled, false);

  const timeout: Runner = async command => command.argv.at(-1) === 'execute' ? { exitCode: 137, timedOut: true } : { exitCode: 0, timedOut: false };
  const timedOut = await executeAttempt(plan, { uid: attestorUid, run: timeout, settle: absent });
  assert.equal(timedOut.outcome, 'timed_out');
  assert.deepEqual(timedOut.phases.map(p => p.phase), ['enumerate', 'execute']);
}));

test('failed enumeration stops the attempt, and a failing execution still reaches integrity checks', async () => boundary(async ({ plan }) => {
  const badInventory = await executeAttempt(plan, { uid: attestorUid, run: async command => ({ exitCode: command.argv.at(-1) === 'enumerate' ? 2 : 0, timedOut: false }), settle: absent });
  assert.deepEqual(badInventory.phases.map(p => p.phase), ['enumerate']);
  assert.ok(badInventory.refusals.some(r => /inventory enumeration did not complete/.test(r)));

  const failingTests = await executeAttempt(plan, { uid: attestorUid, run: async command => ({ exitCode: command.argv.at(-1) === 'execute' ? 1 : 0, timedOut: false }), settle: absent });
  assert.deepEqual(failingTests.refusals, []);
  assert.equal(failingTests.outcome, 'completed');
  assert.equal(failingTests.phases.at(-1)!.exitCode, 1);
}));

test('every local refusal happens before acknowledgement, and preflight bytes carry into execution', async () => boundary(async ({ oracle, output, plan }) => {
  const preflight = await preflightAttempt(plan, { uid: attestorUid });
  // The boundary preflight approved is this attempt's own directory, not the shared root.
  assert.equal(preflight.outputPath, await realpath(attemptBoundaryPath(plan)));
  assert.deepEqual(preflight, { oraclePath: await realpath(oracle), outputPath: await realpath(output),
    outputBoundary: await boundaryIdentity(output), bundleDigest: plan.grant.bundleDigest, testAccountEnv: {} });

  // Each structural refusal rejects, so a runner can decline before acknowledging and
  // let the attempt expire instead of holding protected resources until an operator acts.
  await writeFile(join(output, 'planted.json'), '{}');
  await assert.rejects(preflightAttempt(plan, { uid: attestorUid }), /must be empty/);
  await rm(join(output, 'planted.json'));
  await assert.rejects(preflightAttempt({ ...plan, oraclePath: join(oracle, 'missing') }, { uid: attestorUid }), /ENOENT|no such file/);
  await symlink('/etc/passwd', join(oracle, 'link.ts'));
  await assert.rejects(preflightAttempt(plan, { uid: attestorUid }), /cannot contain symlinks/);
  await rm(join(oracle, 'link.ts'));

  const record = await executeAttempt(plan, { uid: attestorUid, run: settledRunner, settle: absent, preflight });
  assert.equal(record.bundleDigestBefore, preflight.bundleDigest);
  assert.deepEqual(record.refusals, []);
  assert.deepEqual(record.settlement.containers.map(c => c.name), containerNames(plan.grant.attemptId));
}));

test('losing attempt authority stops execution instead of exercising the target to the deadline', async () => boundary(async ({ plan }) => {
  const authority = new AbortController();
  const phases: string[] = [];
  // The server rejects a heartbeat mid-attempt: the container boundary fences the host,
  // not the target, so the phase is killed and no further phase is started.
  const run: Runner = async (command, _timeout, signal) => { phases.push(command.argv.at(-1)!); authority.abort(); return { exitCode: signal?.aborted ? 137 : 0, timedOut: false }; };
  const settled: string[] = [];
  const aborted = await executeAttempt(plan, { uid: attestorUid, run, settle: async name => { settled.push(name); return 'absent'; }, signal: authority.signal });
  assert.deepEqual(phases, ['enumerate']);
  assert.ok(aborted.refusals.some(r => /authority was lost/.test(r)));
  assert.equal(aborted.outcome, 'failed');
  // Settlement still runs: an aborted attempt must not leave a container able to act.
  assert.deepEqual(settled, containerNames(plan.grant.attemptId));
  assert.equal(aborted.settlement.settled, true);

  const before = new AbortController(); before.abort();
  const never = await executeAttempt(plan, { uid: attestorUid, run: settledRunner, settle: absent, signal: before.signal });
  assert.deepEqual(never.phases, []);
  assert.ok(never.refusals.some(r => /authority was lost/.test(r)));
}));

test('a collector observes settlement itself rather than reading the record', async () => {
  const names = containerNames('11111111-2222-3333-4444-555555555555');
  const seen: string[] = [];
  assert.deepEqual(await observeContainers(names, { inspect: async name => { seen.push(name); return name.includes('execute') ? 'present' : 'absent'; } }),
    [{ name: names[0], state: 'absent' }, { name: names[1], state: 'present' }]);
  assert.deepEqual(seen, names);
  // Observation is read-only; it has no way to remove a container to manufacture `absent`.
  assert.deepEqual(await observeContainers([], {}), []);
});

test('an elapsed attempt deadline refuses execution instead of running unauthorized', async () => boundary(async ({ plan }) => {
  const record = await executeAttempt({ ...plan, grant: { ...plan.grant, deadline: new Date(Date.now() - 1000).toISOString() } }, { uid: attestorUid, run: settledRunner, settle: absent });
  assert.deepEqual(record.phases, []);
  assert.ok(record.refusals.some(r => /deadline elapsed/.test(r)));
}));
