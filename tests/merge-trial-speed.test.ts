import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildRun } from '../src/child-runner.js';
import type { FilesystemProbe } from '../src/install/worktree-root.js';
import { runMergeTrial, type MergeTrialInput } from '../src/merge-writer/executor.js';
import { runTrial, shardTestFiles, trialAttempts, trialNoVerdict, trialPhases, trialRetries, trialShardLanes, trialTestGroupSize, TrialRunnerError, TrialTimeoutError } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1832: the control plane's own trial of a merged tree is fast and conclusive — its tests run in
// parallel shards sized to the host, each phase's time is recorded, and an attempt that reaches no
// verdict names its outcome, phase and reason and is tried once more.

const mergeSha = 'a'.repeat(40);
const durable: FilesystemProbe = async path => ({ probed: path, volatile: null, freeBytes: null });
const failure = (fields: { status?: number | null; signal?: string | null; timedOut?: boolean; cause?: unknown; stdout?: string }) =>
  Object.assign(new Error('Command failed'), { status: null, signal: null, stdout: '', stderr: '', ...fields });
const proofsOf = (index: number) => index % 3 === 0 ? ['unit:alpha-works'] : index % 3 === 1 ? ['unit:alpha-works', 'integration:beta-holds'] : [];

/**
 * A repository's trial children, answered without a checkout: the checkout and install answer at
 * once, the selection lists `files`, and each runner process reads its list and answers, per file,
 * TAP cases for that file's proofs and a duration record, failing the files `failing` names. The
 * clock advances by each phase's cost, and the runner processes in flight are counted.
 */
function repository(files: string[], options: { failing?: string[]; baseline?: Record<string, number>; runner?: (attempt: number, list: string[]) => Error | null; build?: (attempt: number) => Error | null } = {}) {
  let clock = Date.parse('2030-03-01T00:00:00Z'), inFlight = 0;
  const seen = { maxInFlight: 0, lists: [] as string[][], concurrency: [] as string[], attempts: 0, builds: 0 };
  const failing = new Set(options.failing ?? []);
  const run: ChildRun = async (command, args) => {
    if (command === 'git' && args[2] === 'worktree' && args[3] === 'add') {
      seen.attempts += 1;
      // The merge's own timing baseline, as the checkout holds it.
      if (options.baseline) { await mkdir(join(args[5]!, 'tests/helpers'), { recursive: true }); await writeFile(join(args[5]!, 'tests/helpers/timing-baseline.json'), JSON.stringify({ files: options.baseline })); }
      return '';
    }
    if (command === 'npm' && args[0] === 'ci') { clock += 1000; return ''; }
    if (command === 'npm' && args[1] === 'build') {
      clock += 2000; seen.builds += 1;
      const error = options.build?.(seen.attempts);
      if (error) throw error;
      return '';
    }
    if (command === 'node' && args[0] === 'scripts/ci-tests.mjs') { clock += 300; return `affected: ${files.length} test files\n${files.join('\n')}\n`; }
    if (command === 'node' && args.includes('tests/helpers/run-tests.ts')) {
      const list = (await readFile(args[args.indexOf('--files-from') + 1]!, 'utf8')).split('\n').filter(Boolean);
      seen.lists.push(list); seen.concurrency.push(args.find(arg => arg.startsWith('--test-concurrency='))!);
      inFlight += 1; seen.maxInFlight = Math.max(seen.maxInFlight, inFlight);
      // Every runner process takes a moment before it answers, so the shards a lane pool starts together are in flight together.
      await new Promise(resolve => setTimeout(resolve, 25));
      inFlight -= 1; clock += 5000;
      const error = options.runner?.(seen.attempts, list);
      if (error) throw error;
      const tap = ['TAP version 13'], records: string[] = [];
      for (const file of list) {
        const index = files.indexOf(file), bad = failing.has(file);
        tap.push(`# Subtest: ${file}`, ...proofsOf(index).map((proof, at) => `    ${bad && at === 0 ? 'not ok' : 'ok'} ${at + 1} - ${proof} — case of ${file}`), `${bad ? 'not ok' : 'ok'} ${index + 1} - ${file}`);
        records.push(JSON.stringify({ file, durationMs: 10, passed: !bad }));
      }
      await writeFile(args[args.indexOf('--durations') + 1]!, `${records.join('\n')}\n`);
      const out = `${tap.join('\n')}\n`;
      if (list.some(file => failing.has(file))) throw failure({ status: 1, stdout: out });
      return out;
    }
    return '';
  };
  return { run, seen, now: () => clock };
}
const input = async (repo: ReturnType<typeof repository>, extra: Partial<MergeTrialInput> = {}): Promise<MergeTrialInput> => {
  const scratch = await temporaryDirectory('merge-trial-speed');
  return { root: join(scratch, 'coordinator'), base: join(scratch, 'base'), mergeSha, changedFiles: ['src/app.ts'], timeoutMs: 600_000, key: 'GY-1832', run: repo.run, now: repo.now,
    temporaryRoots: [scratch], probe: durable, proofs: ['unit:alpha-works', 'integration:beta-holds'], proofFiles: [], ...extra };
};

test('unit:trial-sharded-verdict-equal — runTrial runs the selected files in parallel shards bounded by the host\'s cores (half of them at once, each runner at its share of the cores, none over trialTestGroupSize files, split by the merge\'s timing baseline), and its verdict — passed, failed files, per-proof executed and failed counts — equals a single-process run\'s on the same selection', async () => {
  // The split: every file once, never more shards than files, never fewer than keep each within the group size, longest first.
  assert.deepEqual([trialShardLanes(24), trialShardLanes(3), trialShardLanes(1), trialShardLanes(0)], [12, 1, 1, 1]);
  const many = Array.from({ length: 100 }, (_, index) => `tests/f${String(index).padStart(3, '0')}.test.ts`);
  for (const [lanes, expected] of [[12, 12], [1, Math.ceil(100 / trialTestGroupSize)], [200, 100]] as const) {
    const shards = shardTestFiles(many, lanes);
    assert.equal(shards.length, expected, `${lanes} lanes`);
    assert.deepEqual(shards.flat().sort(), many, 'every file once');
    assert.ok(shards.every(shard => shard.length >= 1 && shard.length <= trialTestGroupSize));
  }
  const weighted = shardTestFiles(['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts', 'tests/d.test.ts'], 2, { 'tests/a.test.ts': 10, 'tests/b.test.ts': 90, 'tests/c.test.ts': 50, 'tests/d.test.ts': 40 });
  assert.deepEqual(weighted, [['tests/b.test.ts', 'tests/a.test.ts'], ['tests/c.test.ts', 'tests/d.test.ts']], 'balanced by the baseline, each shard longest first');
  assert.deepEqual(shardTestFiles([], 4), []);

  const files = Array.from({ length: 30 }, (_, index) => `tests/s${String(index).padStart(2, '0')}.test.ts`), failing = ['tests/s03.test.ts', 'tests/s04.test.ts', 'tests/s29.test.ts'];
  const baseline = Object.fromEntries(files.map((file, index) => [file, 100 + index * 37 % 500]));
  // The same selection on one core (one runner process) and on a 16-core host (eight shards at once).
  const single = repository(files, { failing, baseline }), sharded = repository(files, { failing, baseline });
  const alone = await runMergeTrial(await input(single, { cores: 1 }));
  const parallel = await runMergeTrial(await input(sharded, { cores: 16 }));
  assert.equal(single.seen.lists.length, 1, 'one core: one runner process over the whole selection');
  assert.equal(sharded.seen.lists.length, 8, 'sixteen cores: eight shards');
  assert.equal(sharded.seen.maxInFlight, 8, 'all eight run at once, never more than half the cores');
  assert.deepEqual(new Set(sharded.seen.concurrency), new Set(['--test-concurrency=2']), 'each runner at its share of the cores');
  assert.deepEqual(sharded.seen.lists.flat().sort(), files, 'every selected file runs once, in exactly one shard');
  for (const list of sharded.seen.lists) assert.deepEqual(list, [...list].sort((a, b) => baseline[b]! - baseline[a]! || a.localeCompare(b)), 'each shard runs its longest file first');
  assert.equal(parallel.groups?.length, 8);

  // The verdict is the single process's: build, passed and failed files, the files counted, the runner's exit, and every proof's cases.
  const verdict = (run: typeof alone) => ({ build: run.build, tests: { ...run.tests, failed: [...run.tests.failed].sort() }, runnerExit: run.runnerExit, files: [...run.files].sort(), proofs: run.proofs });
  assert.deepEqual(verdict(parallel), verdict(alone));
  assert.deepEqual(verdict(alone).tests, { passed: 27, failed: failing, files: 30 });
  // Ten files carry unit:alpha-works only and ten carry both (one case each); a failing file fails its first case.
  assert.deepEqual(alone.proofs, { 'unit:alpha-works': { executed: 20, failed: 2 }, 'integration:beta-holds': { executed: 10, failed: 0 } });

  // A selection with no failure is the same pass either way, and a shard's failure is never lost to the others' passes.
  const clean = await runMergeTrial(await input(repository(files), { cores: 24 })), cleanAlone = await runMergeTrial(await input(repository(files), { cores: 1 }));
  assert.deepEqual(verdict(clean), verdict(cleanAlone));
  assert.deepEqual([clean.tests.failed, clean.runnerExit], [[], 0]);
});

test('unit:trial-phases-and-no-pending — every trial records its install, build, selection and test times; an attempt that times out, is cancelled or meets a host failure records a non-pending outcome naming its phase and reason and is retried once, and a verdict is never retried', async () => {
  const files = ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts', 'tests/d.test.ts'];
  // A passing trial: each phase's time, as the clock the children advanced it.
  const passing = repository(files);
  const passed = await runTrial(await input(passing, { cores: 1 }));
  assert.deepEqual(Object.keys(passed.phases ?? {}), [...trialPhases]);
  assert.deepEqual(passed.phases, { install: 1000, build: 2000, selection: 300, tests: 5000 }, 'install, build, selection and tests each timed');
  assert.equal(passed.durationMs, 8300);
  assert.equal(passed.retried, undefined, 'a first-attempt verdict carries no retry');
  assert.equal(passing.seen.attempts, 1);
  // Two shards at once: the test phase spans both runner processes (each moves this fixture's clock by its own cost).
  const sharded = await runTrial(await input(repository(files), { cores: 4 }));
  assert.equal(sharded.phases?.tests, 10_000);
  assert.equal(trialRetries, 1);

  // A failing test is the merge's verdict: recorded, timed and never retried.
  const failingRepo = repository(files, { failing: ['tests/b.test.ts'] });
  const failed = await runTrial(await input(failingRepo, { cores: 1 }));
  assert.deepEqual([failed.tests.failed, failingRepo.seen.attempts, failed.phases?.tests], [['tests/b.test.ts'], 1, 5000]);

  // A timeout on the first attempt and a verdict on the retry: the verdict stands, carrying the first attempt's outcome.
  const slow = repository(files, { runner: attempt => attempt === 1 ? failure({ timedOut: true, signal: 'SIGKILL' }) : null });
  const recovered = await runTrial(await input(slow, { cores: 1 }));
  assert.equal(slow.seen.attempts, 2, 'retried once');
  assert.deepEqual([recovered.build, recovered.tests.failed], ['pass', []]);
  assert.deepEqual(recovered.retried?.map(entry => [entry.outcome, entry.phase]), [['timeout', 'tests']]);
  assert.match(recovered.retried![0]!.reason, /timed out during its tests/);
  assert.deepEqual(recovered.retried![0]!.phases, { install: 1000, build: 2000, selection: 300, tests: 5000 });

  // Every kind of no-verdict, on both attempts: one retry, then the trial rejects with its outcome, phase and reason for each attempt — never pending.
  const cases = [
    { name: 'timeout', options: { runner: () => failure({ timedOut: true, signal: 'SIGKILL' }) }, outcome: 'timeout', phase: 'tests', reason: /timed out during its tests/, error: TrialTimeoutError },
    { name: 'cancelled', options: { runner: () => failure({ signal: 'SIGTERM' }) }, outcome: 'cancelled', phase: 'tests', reason: /tests runner exited \(signal SIGTERM\)/, error: TrialRunnerError },
    { name: 'host failure', options: { build: () => failure({ cause: new Error('spawn npm ENOENT') }) }, outcome: 'host-failure', phase: 'build', reason: /build runner exited/, error: TrialRunnerError },
    { name: 'runner exit naming no test', options: { runner: () => failure({ status: 3 }) }, outcome: 'host-failure', phase: 'tests', reason: /naming no failing test/, error: TrialRunnerError },
  ] as const;
  for (const entry of cases) {
    const repo = repository(files, entry.options);
    let caught: unknown;
    await assert.rejects(runTrial(await input(repo, { cores: 1 })), (error: unknown) => { caught = error; return error instanceof entry.error; }, entry.name);
    assert.equal(repo.seen.attempts, 2, `${entry.name}: tried once more`);
    const attempts = trialAttempts(caught);
    assert.equal(attempts.length, 2, `${entry.name}: both attempts recorded`);
    for (const attempt of attempts) {
      assert.notEqual(attempt.outcome as string, 'pending');
      assert.deepEqual([attempt.outcome, attempt.phase], [entry.outcome, entry.phase], entry.name);
      assert.match(attempt.reason, entry.reason);
      assert.deepEqual(Object.keys(attempt.phases), [...trialPhases]);
      assert.equal(attempt.phases.install, 1000, `${entry.name}: the phases reached are timed`);
    }
    assert.deepEqual(trialNoVerdict(caught), attempts[1], `${entry.name}: the error itself names the last attempt's outcome`);
  }
  // A host failure before any child (a managed root that cannot be made) is the install phase's, retried the same way.
  const unmade = repository(files);
  let caught: unknown;
  const blocked = await temporaryDirectory('merge-trial-speed-blocked');
  await writeFile(join(blocked, 'file'), '');
  await assert.rejects(runTrial({ ...(await input(unmade, { cores: 1 })), base: join(blocked, 'file', 'base') }), (error: unknown) => { caught = error; return true; });
  assert.deepEqual(trialAttempts(caught).map(entry => [entry.outcome, entry.phase]), [['host-failure', 'install'], ['host-failure', 'install']]);
  // A caller that asks for no retry gets one attempt.
  const once = repository(files, { runner: () => failure({ signal: 'SIGTERM' }) });
  await assert.rejects(runTrial(await input(once, { cores: 1, retries: 0 })), TrialRunnerError);
  assert.equal(once.seen.attempts, 1);
});
