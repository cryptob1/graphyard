import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapGate, gateCauses, gateLimitMs, gateRecordPath, gateSummary, readGateRecord, revertRate, runDiagnostics, runGate, writeGateRecord, type GatePorts, type GateRecord } from '../src/batch-gate.js';
import { batchGateStep } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { deployOnce, deployRecordPath, type DeployWatchPorts } from '../src/deploy-watch.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import type { ServeLanding } from '../src/merge-writer/serve-revert.js';
import { batchGateCauses } from '../src/daemon/master-stalled-delivery.js';
import { checkoutRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3119: the batch gate on main. Merged work is verified together, one batch at a time, in the
// private trial container; only verified commits serve; a confirmed failure reverts the culprit.

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const repository = 'owner/project';

function item(key: string, proofs: string[]): Work {
  return { id: `work-${key}`, key, title: `${key} change`, description: `${key} change`, type: 'feature', priority: 2,
    criteria: [{ id: 'AC-1', text: `${key} works`, proofs }], mergeLedger: null } as unknown as Work;
}

/** An origin whose main holds a verified base and three merges (GY-1, GY-2, GY-3), and the coordinator checkout. */
async function fixture(label: string, broken: string | null = null) {
  const base = await temporaryDirectory(label);
  const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), coordinator = join(base, 'coordinator');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, pusher);
  const write = async (files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) { await mkdir(join(pusher, name, '..'), { recursive: true }); await writeFile(join(pusher, name), text); }
    git(pusher, 'add', '.');
  };
  await write({ 'graphyard.json': JSON.stringify({ gate: { core: ['create-work-item', 'smoke'] } }), 'e2e/cases/create-work-item.json': '{}', 'e2e/cases/smoke.json': '{}', 'e2e/cases/other.json': '{}', 'e2e/cases/case-1.json': '{}', 'e2e/cases/case-2.json': '{}', 'e2e/cases/case-3.json': '{}' });
  git(pusher, 'commit', '-q', '-m', 'base');
  git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  const verified = git(pusher, 'rev-parse', 'HEAD');
  const merges: string[] = [];
  for (const n of [1, 2, 3]) {
    git(pusher, 'checkout', '-q', '-b', `item-${n}`);
    await write({ [`src/f${n}.ts`]: `GY-${n}` === broken ? 'broken\n' : 'ok\n' });
    git(pusher, 'commit', '-q', '-m', `change ${n}`);
    git(pusher, 'checkout', '-q', 'main');
    git(pusher, 'merge', '-q', '--no-ff', '-m', `Merge GY-${n}: change ${n}`, `item-${n}`);
    merges.push(git(pusher, 'rev-parse', 'HEAD'));
  }
  git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  git(base, 'clone', '-q', origin, coordinator);
  const work = [item('GY-1', ['e2e:case-1']), item('GY-2', ['e2e:case-2', 'unit:x']), item('GY-3', ['e2e:case-3'])];
  return { base, coordinator, verified, merges, tip: merges[2]!, work };
}

/**
 * The merge writer's reads over the coordinator checkout, with a trial that judges a commit by its
 * tree: a `broken` source fails the case its item binds. Every trial call is recorded.
 */
function reads(coordinator: string, options: { gate?: { root: string; repository: string }; hold?: Promise<void>; failing?: (commit: string) => string[] } = {}) {
  const trials: { commit: string; files: readonly string[]; proofs: string[] }[] = [], filed: { title: string; key: string }[] = [];
  const run = (...args: string[]) => git(coordinator, ...args);
  const brokenCases = (commit: string) => run('ls-tree', '-r', '--name-only', commit, 'src').split('\n').filter(Boolean)
    .filter(file => run('show', `${commit}:${file}`) === 'broken').map(file => `e2e:case-${/f(\d+)/.exec(file)![1]}`);
  const value: MergeWriterReads = {
    baseBranch: 'main', now: Date.now,
    fetch: async () => { run('fetch', '-q', 'origin', 'main'); return run('rev-parse', 'origin/main'); },
    git: async (args, extra) => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
    merge: async () => { throw new Error('unused'); },
    trial: async (commit, files, trialItem) => {
      await options.hold;
      const proofs = trialItem.criteria.flatMap(criterion => criterion.proofs);
      trials.push({ commit, files, proofs });
      const failing = [...brokenCases(commit), ...(options.failing?.(commit) ?? [])];
      return { build: 'pass', tests: { passed: 1, failed: failing.filter(id => id.startsWith('test:')).map(id => id.slice(5)), files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {},
        e2e: proofs.map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: failing.includes(proof) ? 1 : 0 })) } as unknown as MergeTrialRun;
    },
    push: async (sha, baseTip) => { run('push', '-q', `--force-with-lease=main:${baseTip}`, 'origin', `${sha}:main`); return 'pushed'; },
    holds: async () => true,
    record: async () => undefined,
    createWork: async (input, key) => { filed.push({ title: input.title, key }); return { key: `GY-${100 + filed.length}` }; },
    ...(options.gate ? { gate: options.gate } : {}),
  };
  return { value, trials, filed };
}

const cycleWith = (mergeWriter: MergeWriterReads, work: Work[], state = emptyDaemonState({ url: 'http://127.0.0.1:1', repository } as any)) =>
  ({ state, effects: { mergeWriter } as any, snapshot: { work, now: new Date().toISOString() } as any, performed: [], now: Date.now });

test('integration:main-batch-gate — at rollout the served commit is the first verified commit; one gate at a time runs build, the bound and core cases and the affected tests on the main tip, records it verified, and the deploy watch serves only the verified commit', async () => {
  const { coordinator, verified, tip, merges, work } = await fixture('batch-gate-pass');
  // Rollout: the deploy record serving the last commit before the batch makes it the first verified commit.
  await mkdir(join(coordinator, '.graphyard'), { recursive: true });
  await writeFile(deployRecordPath(coordinator), JSON.stringify({ tip: verified, failed: null, reason: null, at: new Date().toISOString(), repository }));
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const loop = reads(coordinator, { gate: { root: coordinator, repository }, hold });
  const cycle = cycleWith(loop.value, work);
  const first = await batchGateStep(cycle);
  assert.equal(readGateRecord(gateRecordPath(coordinator))!.verified, verified, 'the currently served commit is the first verified commit');
  // A second cycle while the gate is in flight starts no second gate.
  const second = await batchGateStep(cycle);
  assert.equal(second!.gate, first!.gate, 'one gate at a time');
  release();
  await first!.gate;
  // The diagnostics, due at rollout, run beside it on the verified commit; the gate's own trials are on the tip.
  await first!.diagnostics;
  const gated = loop.trials.filter(entry => entry.commit === tip);
  assert.equal(gated.length, 1, 'one trial judged the whole batch');
  assert.ok(loop.trials.filter(entry => entry.commit !== tip).every(entry => entry.commit === verified));
  const [trial] = gated;
  assert.equal(trial!.commit, tip, 'the gate runs on the main tip');
  assert.deepEqual(trial!.proofs.sort(), ['e2e:case-1', 'e2e:case-2', 'e2e:case-3', 'e2e:create-work-item', 'e2e:smoke'], 'the bound cases of every merged item and the gate.core cases (create-work-item and the smoke)');
  assert.deepEqual([...trial!.files].sort(), ['src/f1.ts', 'src/f2.ts', 'src/f3.ts'], 'the affected selection runs over the files the batch changed');
  const record = readGateRecord(gateRecordPath(coordinator))!;
  assert.equal(record.verified, tip, 'a passing gate records the tip verified');
  assert.deepEqual(record.merges.map(merge => merge.item), ['GY-1', 'GY-2', 'GY-3']);
  assert.equal(record.inFlight, null);
  // Graphyard's own graphyard.json names the core set.
  assert.deepEqual(checkoutRepositoryPolicy(process.cwd()).gate.core, ['create-work-item', 'smoke']);

  // The whole catalog replaces the subset once the diagnostics measured it within the limit.
  const fits = { ...bootstrapGate(repository, verified), catalogMs: gateLimitMs - 1 };
  const whole = reads(coordinator);
  const { batchGatePorts } = await import('../src/daemon/cycle-batch-gate.js');
  assert.equal((await runGate(batchGatePorts({ ...whole.value, git: whole.value.git! }, work), fits)).outcome, 'verified');
  assert.deepEqual(whole.trials[0]!.proofs.sort(), ['e2e:case-1', 'e2e:case-2', 'e2e:case-3', 'e2e:create-work-item', 'e2e:other', 'e2e:smoke'], 'the whole E2E catalog');

  // The deploy watch serves the verified commit, never the fetched main tip.
  const deployed: string[] = [];
  const file = deployRecordPath(coordinator);
  await writeGateRecord(gateRecordPath(coordinator), { ...record, verified: merges[1]! });
  const ports: DeployWatchPorts = { fetch: async () => tip, head: async () => verified, checkout: async () => {}, build: async commit => { deployed.push(commit); }, restart: async () => {}, health: async () => {}, pin: async () => {}, prune: async () => {}, schema: async () => 1, database: async () => 1 };
  assert.equal(await deployOnce(file, ports, () => {}, repository), 'deployed');
  assert.deepEqual(deployed, [merges[1]], 'the latest verified commit is deployed, not the main tip');
  assert.equal(await deployOnce(file, ports, () => {}, repository), 'unchanged', 'an unverified main tip deploys nothing');
  assert.equal(await deployOnce(file, ports, () => {}, 'owner/other'), 'deployed', 'a record gating another repository never pins this one');
});

/** Pure gate ports: `fails(commit, check)` decides each check's result on each commit. */
function gatePorts(landings: ServeLanding[], fails: (commit: string, check: string, call: number) => boolean, options: { slow?: boolean } = {}) {
  let clock = 0, calls = 0;
  const runs: { commit: string; checks: string[] }[] = [], filed: string[] = [], reverted: string[] = [];
  const tip = landings.at(-1)!.sha;
  const ports: GatePorts = {
    now: () => clock,
    fetch: async () => reverted.length ? `${'f'.repeat(39)}${reverted.length}` : tip,
    landings: async () => landings,
    files: async () => ['src/a.ts'],
    catalog: async () => [],
    core: async () => ['create-work-item', 'smoke'],
    run: async (commit, checks) => {
      runs.push({ commit, checks: [...checks] });
      if (options.slow) clock += gateLimitMs + 1;
      const call = calls++;
      const expanded = checks.flatMap(check => check === 'affected' ? ['test:tests/a.test.ts'] : [check]);
      return expanded.filter(check => fails(commit, check, call));
    },
    revert: async landing => { reverted.push(landing.item.key); return { revertSha: `${'e'.repeat(39)}${reverted.length}` }; },
    file: async input => { filed.push(input.key); },
  };
  return { ports, runs, filed, reverted };
}
const sha = (n: number) => `${n}`.repeat(40).slice(0, 40);
const landing = (n: number): ServeLanding => ({ sha: sha(n), before: sha(n - 1), subject: `Merge GY-${n}`, item: item(`GY-${n}`, [`e2e:case-${n}`]) });

test('integration:main-batch-gate-failures — smoke, bound and core cases must pass outright; only an affected test failing on the verified commit too is a filed known red; a re-run pass is a filed flake; a confirmed failure reverts the smallest failing prefix\'s last item and recuts; a failing recut or a second timeout holds and wakes the master', async () => {
  const verified = sha(1), batch = [landing(2), landing(3), landing(4)], tip = sha(4);
  const fresh = () => bootstrapGate(repository, verified);

  // An affected test failing on both commits is a known red: filed for an owner, cached per commit, exempt.
  {
    const { ports, filed, runs } = gatePorts(batch, (_, check) => check === 'test:tests/a.test.ts');
    const record = fresh();
    const outcome = await runGate(ports, record);
    assert.equal(outcome.outcome, 'verified');
    assert.deepEqual(outcome.outcome === 'verified' && outcome.knownRed, ['test:tests/a.test.ts']);
    assert.deepEqual(filed, ['known-red:test:tests/a.test.ts']);
    assert.ok(runs.some(entry => entry.commit === verified), 'the test ran on the last verified commit');
    assert.equal(record.results[tip]?.['test:tests/a.test.ts'] ?? record.results[verified]?.['test:tests/a.test.ts'], undefined, 'the cache keeps only the newly verified commit');
  }
  // Smoke failing on both commits is no known red: it blocks.
  {
    const { ports, reverted, runs } = gatePorts(batch, (_, check) => check === 'e2e:smoke');
    const outcome = await runGate(ports, fresh());
    assert.equal(outcome.outcome, 'reverted');
    assert.ok(!runs.some(entry => entry.commit === verified), 'a smoke failure is never compared with the verified commit');
    assert.deepEqual(reverted, ['GY-2'], 'it fails from the first prefix on, so the first item is the culprit');
  }
  // Only the whole batch failing names its last item.
  {
    const { ports, reverted } = gatePorts(batch, (commit, check) => check === 'e2e:case-2' && commit === tip);
    assert.equal((await runGate(ports, fresh())).outcome, 'reverted');
    assert.deepEqual(reverted, ['GY-4']);
  }
  // A check that passes on its re-run is a filed flake, and nothing reverts.
  {
    const { ports, filed, reverted } = gatePorts(batch, (_, check, call) => check === 'e2e:case-3' && call === 0);
    const record = fresh();
    const outcome = await runGate(ports, record);
    assert.equal(outcome.outcome, 'verified');
    assert.deepEqual(filed, ['flake:e2e:case-3']);
    assert.deepEqual(reverted, []);
    assert.equal(record.verified, tip);
  }
  // A confirmed failure re-runs only that check on the prefixes in merge order; the smallest failing prefix names the culprit.
  {
    const { ports, reverted, runs } = gatePorts(batch, (commit, check) => check === 'e2e:case-3' && commit !== sha(2));
    const record = fresh();
    const outcome = await runGate(ports, record);
    assert.deepEqual(outcome, { outcome: 'reverted', tip, check: 'e2e:case-3', culprit: 'GY-3', revertSha: `${'e'.repeat(39)}1` });
    assert.deepEqual(runs.slice(2).map(entry => [entry.commit, entry.checks]), [[sha(2), ['e2e:case-3']], [sha(3), ['e2e:case-3']]], 'only the failing check, on the prefixes in merge order');
    assert.deepEqual(reverted, ['GY-3']);
    assert.equal(record.verified, verified, 'nothing is verified yet');
    // The recut (main now holds the revert) passing verifies it, so the other items ship.
    const recut = gatePorts(batch, () => false);
    recut.ports.fetch = async () => `${'f'.repeat(39)}1`;
    assert.equal((await runGate(recut.ports, record)).outcome, 'verified');
    assert.equal(record.verified, `${'f'.repeat(39)}1`);
    assert.deepEqual(record.merges.map(merge => [merge.item, merge.reverted]), [['GY-3', true], ['GY-2', false], ['GY-4', false]]);
  }
  // A recut that still fails holds the last verified commit served and wakes the master.
  {
    const { ports } = gatePorts(batch, (_, check) => check === 'e2e:case-4');
    const record = fresh();
    assert.equal((await runGate(ports, record)).outcome, 'reverted');
    const outcome = await runGate(ports, record);
    assert.equal(outcome.outcome, 'held');
    assert.equal(record.verified, verified);
    assert.ok(gateCauses(record).some(cause => cause.key === 'batch-gate'), 'the held batch wakes the master');
    assert.equal(batchGateCauses(record)[0]!.key, 'batch-gate');
    assert.equal((await runGate(ports, record)).outcome, 'idle', 'a held tip is not gated again until main moves');
  }
  // A gate past 45 minutes is a timeout: no culprit search, one recut, and a second timeout holds.
  {
    const { ports, reverted, runs } = gatePorts(batch, () => false, { slow: true });
    const record = fresh();
    assert.equal((await runGate(ports, record)).outcome, 'timeout');
    assert.equal(runs.length, 1, 'no re-run and no culprit search');
    assert.equal((await runGate(ports, record)).outcome, 'held');
    assert.deepEqual(reverted, []);
    assert.equal(record.verified, verified, 'the last verified commit stays served');
    assert.match(gateCauses(record)[0]!.detail, /timed out twice/);
  }
});

test('integration:main-batch-gate-failures — on real git, the culprit\'s merge is reverted on main through the revert-and-reland path and its re-land filed, the other merges stay', async () => {
  const { coordinator, verified, tip, merges, work } = await fixture('batch-gate-revert', 'GY-2');
  const loop = reads(coordinator);
  const { batchGatePorts } = await import('../src/daemon/cycle-batch-gate.js');
  const ports = batchGatePorts({ ...loop.value, git: loop.value.git! }, work);
  const record = bootstrapGate(repository, verified);
  const outcome = await runGate(ports, record);
  assert.equal(outcome.outcome, 'reverted');
  assert.equal(outcome.outcome === 'reverted' && outcome.culprit, 'GY-2');
  const main = git(coordinator, 'rev-parse', 'origin/main');
  assert.notEqual(main, tip);
  assert.match(git(coordinator, 'log', '-1', '--format=%s', main), /^Revert "Merge GY-2/);
  assert.deepEqual(git(coordinator, 'ls-tree', '--name-only', main, 'src/').split('\n').sort(), ['src/f1.ts', 'src/f3.ts'], 'only the culprit came back out');
  assert.ok(loop.filed.some(entry => entry.key === `gate-reland:${merges[1]}` && /^Re-land GY-2/.test(entry.title)), 'the re-land is filed');
  // The recut verifies the batch without the culprit.
  assert.equal((await runGate(ports, record)).outcome, 'verified');
  assert.equal(record.verified, main);
});

test('integration:batch-gate-diagnostics-and-revert-rate — the scheduled full suite and catalog against the verified commit file items and never block; master status shows the revert rate over the last 20 merges and above 1 in 5 wakes the master', async () => {
  const verified = sha(1);
  const record: GateRecord = bootstrapGate(repository, verified);
  let clock = Date.parse('2026-11-05T00:00:00Z');
  const filed: string[] = [], diagnosed: string[] = [];
  const ports = { now: () => clock, file: async (input: { key: string }) => { filed.push(input.key); }, diagnose: async (commit: string) => { diagnosed.push(commit); return { failed: ['test:tests/slow.test.ts', 'e2e:board'], catalogMs: 20 * 60_000 }; } };
  assert.deepEqual(await runDiagnostics(ports, record), ['test:tests/slow.test.ts', 'e2e:board']);
  assert.deepEqual(diagnosed, [verified], 'the diagnostics run against the latest verified commit');
  assert.deepEqual(filed, ['diagnostic:test:tests/slow.test.ts', 'diagnostic:e2e:board'], 'each failure files an item');
  assert.equal(record.verified, verified); assert.equal(record.held, null); assert.equal(record.catalogMs, 20 * 60_000, 'the catalog\'s measured time');
  clock += 60 * 60_000;
  assert.equal(await runDiagnostics(ports, record), null, 'not due again within the day');
  clock += 24 * 60 * 60_000;
  assert.ok(await runDiagnostics(ports, record), 'due again a day later');
  // A diagnostic failure never blocks the gate: the next batch is verified on its own checks.
  const batch = [landing(2)];
  const { ports: gate } = gatePorts(batch, () => false);
  assert.equal((await runGate(gate, record)).outcome, 'verified');

  // The revert rate reads the last 20 merges; above 1 in 5 wakes the master.
  const merges = (reverted: number) => Array.from({ length: 25 }, (_, index) => ({ sha: sha(index % 9), item: `GY-${index}`, reverted: index >= 25 - reverted }));
  assert.deepEqual(revertRate({ merges: merges(4) }), { reverted: 4, merges: 20, rate: 0.2 });
  assert.deepEqual(gateCauses({ ...record, merges: merges(4) }), [], '4 in 20 is not above 1 in 5');
  const high = { ...record, merges: merges(5) };
  assert.deepEqual(gateCauses(high).map(cause => cause.key), ['revert-rate']);
  assert.match(gateCauses(high)[0]!.detail, /5\/20/);
  assert.equal(gateSummary(high)!.revertRate, '5/20', 'master status shows the revert rate');
});
