import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapGate, catalogBudgetMs, catalogFits, diagnosticsIntervalMs, gateCauses, gateRunsMaxAgeMs, measuredCatalogMs, gateLimitMs, gateRecordPath, gateSummary, readGateRecord, revertRate, runDiagnostics, runGate, writeGateRecord, type GatePorts, type GateRecord } from '../src/batch-gate.js';
import { appendReleaseNote, latestReleaseNote, readReleaseNotes, releaseNote, releaseNotesPath } from '../src/release-notes.js';
import { RefusedResponse } from '../src/model/refusal.js';
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

const cycleWith = (mergeWriter: MergeWriterReads, work: Work[], state = emptyDaemonState({ url: 'http://127.0.0.1:1', repository } as any), log: (line: string) => void = () => {}) =>
  ({ state, effects: { mergeWriter } as any, snapshot: { work, now: new Date().toISOString() } as any, performed: [], now: Date.now, log });

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

  // The whole catalog replaces the subset once its measured time fits half the limit.
  const fits = { ...bootstrapGate(repository, verified), catalogMs: catalogBudgetMs - 1 };
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

test('integration:batch-gate-survives-restart — a batch in flight when the loop restarts is adopted and finished by the next loop on the same candidate tip, without a new run of its finished steps or a fetch, and a merge that lands meanwhile is verified by the following batch', async () => {
  const { base, coordinator, verified, tip, work } = await fixture('batch-gate-restart', 'GY-2');
  // Rollout: the deploy record's commit is the first verified one, so the first gate cuts verified..tip.
  await mkdir(join(coordinator, '.graphyard'), { recursive: true });
  await writeFile(deployRecordPath(coordinator), JSON.stringify({ tip: verified, failed: null, reason: null, at: new Date().toISOString(), repository }));
  const loop = reads(coordinator, { gate: { root: coordinator, repository } });
  let fetches = 0;
  const realFetch = loop.value.fetch!;
  loop.value.fetch = async () => { fetches++; return realFetch(); };
  // The first loop dies between the whole batch's run and its failing check's re-run — its flight
  // ends unresolved, exactly as a process the restart kills leaves the record standing.
  let loops = 1;
  const onTip: { proofs: string[] }[] = [];
  const trial = loop.value.trial!;
  let diagnostics: Promise<unknown> | null = null;
  loop.value.trial = async (commit, files, trialItem) => {
    const proofs = trialItem.criteria.flatMap(criterion => criterion.proofs);
    if (commit !== tip) return trial(commit, files, trialItem); // the diagnostics run on the verified commit
    onTip.push({ proofs });
    if (loops === 1 && proofs.length > 1) return trial(commit, files, trialItem); // the cut's one whole run
    if (loops === 1) { await diagnostics; throw new Error('the loop restarted mid-gate'); } // the failing check's re-run
    return trial(commit, files, { ...trialItem, criteria: [] }); // the next loop: the re-run passes, a flake
  };
  const first = await batchGateStep(cycleWith(loop.value, work));
  diagnostics = first!.diagnostics;
  await first!.gate;
  assert.equal(fetches, 1, 'the first loop fetched the tip it cut its batch on');
  const mid = readGateRecord(gateRecordPath(coordinator))!;
  assert.equal(mid.verified, verified, 'nothing is verified yet');
  assert.equal(mid.inFlight?.tip, tip, 'the cut batch stands on disk for the next loop to adopt');
  assert.deepEqual(Object.values(mid.inFlight!.results ?? {}), [['e2e:case-2']], 'the whole run is a recorded finished step with its one failing check');

  // A merge lands on main while the gate was in flight: it rides the next batch. (It repairs the
  // broken file, so the following batch's whole-catalog gate — the diagnostics measured the catalog
  // fast — passes; the phase-1 flake was the fake trial's pass, not the tree's.)
  const pusher = join(base, 'pusher');
  git(pusher, 'checkout', '-q', '-b', 'item-4');
  await mkdir(join(pusher, 'src'), { recursive: true });
  await writeFile(join(pusher, 'src/f2.ts'), 'ok\n');
  git(pusher, 'add', 'src');
  git(pusher, 'commit', '-q', '-m', 'change 4');
  git(pusher, 'checkout', '-q', 'main');
  git(pusher, 'merge', '-q', '--no-ff', '-m', 'Merge GY-4: change 4', 'item-4');
  git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  const later = git(pusher, 'rev-parse', 'HEAD');

  // The next loop — a fresh cycle state, as a restart builds — adopts the batch and finishes it.
  loops = 2;
  const work4 = [...work, item('GY-4', ['e2e:case-4'])];
  const second = await batchGateStep(cycleWith(loop.value, work4));
  await second!.gate;
  await second!.diagnostics;
  assert.equal(fetches, 1, 'the adopted batch fetches nothing: no new run is cut on the newer main');
  assert.deepEqual(onTip.map(entry => entry.proofs.length), [5, 1, 1], 'the batch\'s whole run ran once, then only the interrupted re-run of the failing check');
  const adopted = readGateRecord(gateRecordPath(coordinator))!;
  assert.equal(adopted.verified, tip, 'the adopted batch verifies its own candidate tip, not the newer main');
  assert.equal(adopted.inFlight, null);
  assert.ok(loop.filed.some(entry => entry.key === 'flake:e2e:case-2'), 'the passing re-run files its flake');
  assert.equal(readGateRecord(gateRecordPath(coordinator))!.filed!['flake:e2e:case-2']!.item, 'GY-101', 'the filed case binding survives on disk for a later run to reuse (GY-3147)');

  // The following batch gates the merge that landed meanwhile.
  const third = await batchGateStep(cycleWith(loop.value, work4));
  await third!.gate;
  await third!.diagnostics;
  assert.equal(fetches, 2, 'the following batch is cut on the fetched main tip');
  const following = readGateRecord(gateRecordPath(coordinator))!;
  assert.equal(following.verified, later, 'the merge that landed while the gate ran is verified by the following batch');
  assert.deepEqual(following.merges.map(merge => merge.item), ['GY-1', 'GY-2', 'GY-3', 'GY-4']);
});

/** Pure gate ports: `fails(commit, check)` decides each check's result on each commit. */
function gatePorts(landings: ServeLanding[], fails: (commit: string, check: string, call: number) => boolean, options: { slow?: boolean; clock?: number } = {}) {
  let clock = options.clock ?? 0, calls = 0;
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

test('unit:batch-gate-own-deadline — a gate run is bounded by its own 45-minute limit, not the 20-minute merge-trial deadline: a 25-minute run records its verdict, only a run past 45 minutes is a timeout, and the trial it runs carries the gate\'s remaining time', async () => {
  const { trialTimeoutMinutes } = await import('../src/master/merge-writer-settings.js');
  const { mergeWriterReads } = await import('../src/daemon/cycle-merge-writer.js');
  const { batchGatePorts } = await import('../src/daemon/cycle-batch-gate.js');
  const verified = sha(1), batch = [landing(2), landing(3)], tip = sha(3);
  assert.ok(gateLimitMs === 45 * 60_000 && gateLimitMs > trialTimeoutMinutes * 60_000);

  // A run needing 25 minutes completes and records its verdict; the run was handed the gate's own time left.
  {
    const { ports } = gatePorts(batch, () => false);
    let clock = 0;
    const limits: number[] = [];
    ports.now = () => clock;
    ports.run = async (_commit, _checks, _files, timeoutMs) => { limits.push(timeoutMs); clock += 25 * 60_000; return []; };
    const record = bootstrapGate(repository, verified);
    assert.equal((await runGate(ports, record)).outcome, 'verified');
    assert.equal(record.verified, tip);
    assert.deepEqual(limits, [gateLimitMs], 'the trial is bounded by the gate\'s 45 minutes');
  }
  // Only a run past 45 minutes counts as a gate timeout.
  {
    const { ports } = gatePorts(batch, () => false);
    let clock = 0;
    ports.now = () => clock;
    ports.run = async () => { clock += gateLimitMs + 1; return []; };
    const record = bootstrapGate(repository, verified);
    assert.equal((await runGate(ports, record)).outcome, 'timeout');
    assert.equal(record.attempt.timeouts, 1);
  }
  // The gate's trial port passes that bound down to the trial, which otherwise keeps the merge-trial deadline.
  {
    const seen: (number | undefined)[] = [];
    const base: MergeWriterReads = { ...reads('/unused').value, trial: async (...args) => { seen.push(args[9]); return { build: 'pass', tests: { passed: 0, failed: [], files: 0 }, e2e: [] } as unknown as MergeTrialRun; } };
    await batchGatePorts({ ...base, git: base.git! }, []).run(tip, ['build', 'affected'], ['src/a.ts'], 30 * 60_000);
    assert.deepEqual(seen, [30 * 60_000]);
    const timeouts: number[] = [];
    const writer = mergeWriterReads({ baseBranch: 'main', run: {}, repository } as never, '/unused', async () => '', { base: '/unused', record: async () => undefined,
      trial: async input => { timeouts.push(input.timeoutMs); return {} as never; } });
    const gateItem = { key: 'batch-gate', criteria: [] } as unknown as Work;
    await writer.trial(tip, [], gateItem, undefined, undefined, undefined, undefined, undefined, undefined, gateLimitMs);
    await writer.trial(tip, [], gateItem);
    assert.deepEqual(timeouts, [gateLimitMs, trialTimeoutMinutes * 60_000]);
  }
});

test('unit:batch-gate-catalog-by-measured-time — the gate runs the whole E2E catalog only when the catalog time measured from recent gate runs, batch tests included, fits half the 45-minute limit; otherwise smoke, the bound cases, gate.core and the affected tests; the full catalog still runs as the diagnostic', async () => {
  const verified = sha(1), batch = [landing(2), landing(3)];
  const day = Date.parse('2026-11-05T12:00:00Z');
  const catalog = ['create-work-item', 'smoke', 'case-2', 'case-3', 'other'];
  const subset = ['build', 'e2e:case-2', 'e2e:case-3', 'e2e:create-work-item', 'e2e:smoke', 'affected'];
  const whole = ['build', ...catalog.map(id => `e2e:${id}`), 'affected'];
  const gate = (record: GateRecord, runMs: number, slow = false) => {
    const { ports, runs } = gatePorts(batch, () => false);
    let clock = day;
    ports.now = () => clock;
    ports.catalog = async () => catalog;
    ports.run = async (commit, checks) => { runs.push({ commit, checks: [...checks] }); clock += slow ? gateLimitMs + 1 : runMs; return []; };
    return runGate(ports, record).then(outcome => ({ outcome, checks: runs[0]!.checks }));
  };
  assert.equal(catalogBudgetMs, gateLimitMs / 2);

  // Nothing measured: the subset. The quiet diagnostics' 9.5 minutes fit half the limit: the whole catalog.
  assert.deepEqual((await gate(bootstrapGate(repository, verified), 60_000)).checks, subset);
  const quiet = { ...bootstrapGate(repository, verified), catalogMs: 571_824 };
  const first = await gate(quiet, 30 * 60_000);
  assert.deepEqual(first.checks, whole, 'the whole catalog runs while its measured time fits');
  assert.equal(first.outcome.outcome, 'verified', 'a run that does fit the limit still verifies');
  // That gate run measured 30 minutes under load: the next batch runs the subset, whatever the diagnostics measured.
  assert.deepEqual(quiet.gateRuns!.map(run => run.ms), [30 * 60_000], 'the gate run is measured, batch tests included');
  quiet.verified = verified;
  assert.deepEqual((await gate(quiet, 60_000)).checks, subset, 'the measured gate run does not fit half the limit');
  assert.equal(quiet.gateRuns!.length, 1, 'a subset run measures nothing of the catalog');

  // A whole-catalog run that times out counts its elapsed time.
  const timed = { ...bootstrapGate(repository, verified), catalogMs: 5 * 60_000 };
  assert.equal((await gate(timed, 0, true)).outcome.outcome, 'timeout');
  assert.ok(timed.gateRuns![0]!.ms > gateLimitMs, 'the timeout is measured');

  // A fast recent gate run fits; the slowest of the recent runs decides; old runs age out.
  const fast = { ...bootstrapGate(repository, verified), catalogMs: 40 * 60_000, gateRuns: [{ ms: 12 * 60_000, at: new Date(day - 60_000).toISOString() }] };
  assert.equal(measuredCatalogMs(fast, day), 12 * 60_000, 'recent gate runs, not the diagnostics');
  assert.ok(catalogFits(fast, day));
  assert.ok(!catalogFits({ ...fast, gateRuns: [...fast.gateRuns, { ms: catalogBudgetMs + 1, at: fast.gateRuns[0]!.at }] }, day), 'the slowest recent run decides');
  assert.ok(!catalogFits(fast, day + gateRunsMaxAgeMs), 'aged-out runs leave the diagnostics\' measure');

  // The full catalog still runs as the scheduled diagnostic, whatever the gate runs.
  const { batchGatePorts } = await import('../src/daemon/cycle-batch-gate.js');
  const seen: string[][] = [];
  const base: MergeWriterReads = { ...reads('/unused').value, git: async args => args[0] === 'ls-tree' ? catalog.map(id => `${id}.json`).join('\n') : '',
    trial: async (_commit, _files, trialItem) => { seen.push(trialItem.criteria.flatMap(criterion => criterion.proofs)); return { build: 'pass', tests: { passed: 0, failed: [], files: 0 }, e2e: [] } as unknown as MergeTrialRun; } };
  await batchGatePorts({ ...base, git: base.git! }, []).diagnose(verified);
  assert.deepEqual(seen.at(-1)!.sort(), catalog.map(id => `e2e:${id}`).sort(), 'the diagnostic runs the whole catalog');
});

test('unit:batch-gate-outcome-visible — every settled run is the record\'s lastOutcome with its tip, outcome, reason or failing check and end time, the run in flight names its current step, and each outcome is one journal line (GY-3141)', async () => {
  const verified = sha(1), batch = [landing(2), landing(3)], tip = sha(3);
  const at = '2026-11-05T10:00:00.000Z';

  // A passing run records a plain verified outcome with no reason.
  {
    const { ports } = gatePorts(batch, () => false, { clock: Date.parse(at) });
    const record = bootstrapGate(repository, verified);
    assert.equal((await runGate(ports, record)).outcome, 'verified');
    assert.deepEqual(record.lastOutcome, { tip, outcome: 'verified', reason: null, finishedAt: at });
  }
  // A reverted run names its failing check and the culprit it reverted.
  {
    const { ports } = gatePorts(batch, (commit, check) => check === 'e2e:case-3' && commit !== sha(2), { clock: Date.parse(at) });
    const record = bootstrapGate(repository, verified);
    await runGate(ports, record);
    assert.deepEqual([record.lastOutcome!.outcome, record.lastOutcome!.reason], ['reverted', 'reverted GY-3 for failing e2e:case-3']);
    assert.ok(Date.parse(record.lastOutcome!.finishedAt!) > 0, 'the end time is recorded');
  }
  // A timeout names the limit, and the second timeout holds with its reason.
  {
    const { ports } = gatePorts(batch, () => false, { slow: true });
    const record = bootstrapGate(repository, verified);
    await runGate(ports, record);
    assert.deepEqual([record.lastOutcome!.outcome, record.lastOutcome!.reason], ['timeout', 'past 45 minutes']);
    await runGate(ports, record);
    assert.equal(record.lastOutcome!.outcome, 'held');
    assert.match(record.lastOutcome!.reason!, /timed out twice/);
    // master status shows the last outcome with its tip cut to the summary's 12 characters.
    assert.equal(gateSummary(record)!.lastOutcome!.tip, tip.slice(0, 12));
    assert.equal(gateSummary(record)!.lastOutcome!.reason, record.lastOutcome!.reason);
  }
  // A run that throws records an error outcome with the message, and leaves its batch standing for adoption.
  {
    const { ports } = gatePorts(batch, () => false, { clock: Date.parse(at) });
    ports.run = async () => { throw new Error('the trial container is gone'); };
    const record = bootstrapGate(repository, verified);
    await assert.rejects(runGate(ports, record), /the trial container is gone/);
    assert.deepEqual([record.lastOutcome!.tip, record.lastOutcome!.outcome, record.lastOutcome!.reason, record.lastOutcome!.finishedAt], [tip, 'error', 'the trial container is gone', at]);
    assert.equal(record.inFlight?.tip, tip, 'the thrown gate leaves its batch for the next loop to adopt');
  }

  // End to end on real git: the run in flight names its current step, and the settled outcome is one journal line.
  {
    const { coordinator, verified: realVerified, tip: realTip, work } = await fixture('batch-gate-outcome');
    await mkdir(join(coordinator, '.graphyard'), { recursive: true });
    await writeFile(deployRecordPath(coordinator), JSON.stringify({ tip: realVerified, failed: null, reason: null, at: new Date().toISOString(), repository }));
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const loop = reads(coordinator, { gate: { root: coordinator, repository }, hold });
    // The tip's own trial starting is the signal that the step label before it has landed on disk (the gate awaits that write before it runs).
    let reached!: () => void;
    const entered = new Promise<void>(resolve => { reached = resolve; });
    const realTrial = loop.value.trial!;
    loop.value.trial = async (commit: string, files: readonly string[], trialItem: any) => { if (commit === realTip) reached(); await hold; return realTrial(commit, files, trialItem); };
    const lines: string[] = [];
    const first = await batchGateStep(cycleWith(loop.value, work, undefined, line => lines.push(line)));
    await entered;
    // While the whole batch's run is in flight, the record and master status name the current step.
    const mid = readGateRecord(gateRecordPath(coordinator))!;
    assert.equal(mid.inFlight!.tip, realTip);
    assert.match(mid.inFlight!.step!, /^running \d+ check\(s\) on \w{12}$/);
    assert.equal(gateSummary(mid)!.inFlight!.step, mid.inFlight!.step);
    release();
    await first!.gate;
    await first!.diagnostics;
    const done = readGateRecord(gateRecordPath(coordinator))!;
    assert.equal(done.lastOutcome!.outcome, 'verified');
    assert.equal(done.lastOutcome!.tip, realTip);
    assert.ok(Date.parse(done.lastOutcome!.finishedAt!) > 0);
    const outcomeLines = lines.filter(line => line.includes('Batch gate on'));
    assert.equal(outcomeLines.length, 1, 'one journal line names the outcome');
    assert.match(outcomeLines[0]!, new RegExp(`^\\[graphyard-master\\] cycle \\d+ merge done: Batch gate on ${realTip.slice(0, 12)}: verified$`));
  }

  // A failing run end to end: the error outcome reaches the record on disk and the journal in one line.
  {
    const { coordinator, verified: realVerified, tip: realTip, work } = await fixture('batch-gate-error');
    await mkdir(join(coordinator, '.graphyard'), { recursive: true });
    await writeFile(deployRecordPath(coordinator), JSON.stringify({ tip: realVerified, failed: null, reason: null, at: new Date().toISOString(), repository }));
    const loop = reads(coordinator, { gate: { root: coordinator, repository } });
    const realTrial = loop.value.trial!;
    loop.value.trial = async (commit, files, trialItem) => {
      if (commit !== realVerified) throw new Error('the trial container is gone');
      return realTrial(commit, files, trialItem);
    };
    const lines: string[] = [];
    const gate = await batchGateStep(cycleWith(loop.value, work, undefined, line => lines.push(line)));
    await gate!.gate;
    await gate!.diagnostics;
    const record = readGateRecord(gateRecordPath(coordinator))!;
    assert.deepEqual([record.lastOutcome!.tip, record.lastOutcome!.outcome], [realTip, 'error']);
    assert.match(record.lastOutcome!.reason!, /the trial container is gone/);
    assert.equal(record.inFlight?.tip, realTip, 'the failed run leaves its batch standing for the next loop to adopt');
    assert.ok(lines.some(line => line.includes('The batch gate failed and runs again next cycle') && line.includes('the trial container is gone')), 'the journal names the error outcome');
  }
});

test('unit:verified-batch-release-note — a verified batch appends a release note of its items with their summaries and bound cases, the reverted listed apart, the latest 20 kept', async () => {
  const { coordinator, verified, tip, work } = await fixture('batch-gate-release-note', 'GY-2');
  await mkdir(join(coordinator, '.graphyard'), { recursive: true });
  await writeFile(deployRecordPath(coordinator), JSON.stringify({ tip: verified, failed: null, reason: null, at: new Date().toISOString(), repository }));
  work[0]!.summary = 'GY-1 summary';
  work[0]!.description = 'First sentence. Second sentence.';
  work[2]!.criteria = [{ id: 'AC-1', text: 'works', proofs: ['unit:y'] }] as Work['criteria'];
  const loop = reads(coordinator, { gate: { root: coordinator, repository }, failing: commit => (commit === tip ? ['e2e:case-2'] : []) });
  const first = await batchGateStep(cycleWith(loop.value, work));
  await first!.gate; await first!.diagnostics;
  assert.equal(readGateRecord(gateRecordPath(coordinator))!.lastOutcome?.outcome, 'reverted');
  await (await batchGateStep(cycleWith(loop.value, work)))!.gate; // the recut batch verifies
  const notes = readReleaseNotes(releaseNotesPath(coordinator));
  const note = notes.at(-1)!;
  assert.equal(note.commit, readGateRecord(gateRecordPath(coordinator))!.verified);
  assert.ok(note.reverted.some(entry => entry.key === 'GY-2'));
  assert.equal(note.items.find(entry => entry.key === 'GY-1')?.summary, 'GY-1 summary');
  assert.deepEqual(note.items.find(entry => entry.key === 'GY-1')?.cases, ['e2e:case-1']);
  assert.equal(releaseNote('c', 'now', [{ sha: 'a', item: work[0]! }], new Set()).items.length, 1);
  assert.equal(releaseNote('c', 'now', [{ sha: 'a', item: { ...work[0]!, summary: '' } }], new Set()).items[0]!.summary, 'First sentence.');
  assert.equal(releaseNote('c', 'now', [{ sha: 'a', item: work[2]! }], new Set()).items[0]!.cases.length, 0);
  for (let n = 0; n < 25; n++) await appendReleaseNote(releaseNotesPath(coordinator), note);
  assert.equal(readReleaseNotes(releaseNotesPath(coordinator)).length, 20);
  assert.match(latestReleaseNote(releaseNotesPath(coordinator))!.items.join('\n'), /GY-3.*no E2E case/);
});

test('unit:batch-gate-filing-idempotent — a known red or diagnostic failure whose item is already filed — the same case under different wording, as a later tip makes — is reused and never re-filed; a refused or failed filing is a gate note and never aborts the verdict (GY-3147)', async () => {
  const verified = sha(1), batch = [landing(2)];
  const refused = () => new RefusedResponse('Graphyard refused work (409): Idempotency key reused with different input', 409, { error: 'Idempotency key reused with different input' });

  // The gate: a known red filed on one batch, then the same case on the next batch — its filing would name the new tip, so its wording differs.
  {
    const world = gatePorts(batch, (_, check) => check === 'test:tests/a.test.ts');
    const filings: string[] = [];
    world.ports.file = async input => { filings.push(input.key); return { item: `GY-${100 + filings.length}` }; };
    const record = bootstrapGate(repository, verified);
    assert.equal((await runGate(world.ports, record)).outcome, 'verified', 'the first batch files its known red');
    assert.deepEqual(filings, ['known-red:test:tests/a.test.ts']);
    const next = [landing(3)];
    world.ports.landings = async () => next;
    world.ports.fetch = async () => next[0]!.sha;
    assert.equal((await runGate(world.ports, record)).outcome, 'verified');
    assert.equal(filings.length, 1, 'the case already has its item: reused, never re-filed');
    assert.equal(record.filed!['known-red:test:tests/a.test.ts']!.item, 'GY-101', 'the binding names the filed item');
  }
  // A filing the control plane refuses — its key was filed before with different input — is already filed: the verdict stands.
  {
    const world = gatePorts(batch, (_, check) => check === 'test:tests/a.test.ts');
    world.ports.file = async () => { throw refused(); };
    const record = bootstrapGate(repository, verified);
    assert.equal((await runGate(world.ports, record)).outcome, 'verified');
    assert.equal(record.lastOutcome!.outcome, 'verified', 'the run records its verdict');
    assert.equal(record.filed!['known-red:test:tests/a.test.ts']!.item, null, 'the refused key is treated as already filed');
    assert.deepEqual(record.notes, [], 'a refused key is already filed, not a failure');
  }
  // A filing that fails outright never aborts the run: it is a gate note, and the verdict stands.
  {
    const world = gatePorts(batch, (_, check) => check === 'test:tests/a.test.ts');
    world.ports.file = async () => { throw new Error('the control plane is unreachable'); };
    const record = bootstrapGate(repository, verified);
    assert.equal((await runGate(world.ports, record)).outcome, 'verified');
    assert.deepEqual(record.notes, ['known-red:test:tests/a.test.ts: the control plane is unreachable']);
    assert.deepEqual(record.filed, {}, 'nothing was filed: the next run tries again');
    assert.ok(gateSummary(record)!.notes.includes('known-red:test:tests/a.test.ts: the control plane is unreachable'), 'master status shows the note');
  }
  // The diagnostics file idempotently too: each case is filed once and reused a day later.
  {
    const record = bootstrapGate(repository, verified);
    let clock = Date.parse('2026-11-05T00:00:00Z');
    const diagnose = { failed: ['test:tests/slow.test.ts', 'e2e:board'], catalogMs: 20 * 60_000 };
    const filings: string[] = [];
    const ports = { now: () => clock, file: async (input: { key: string }) => { filings.push(input.key); return { item: `GY-${100 + filings.length}` }; }, diagnose: async () => diagnose };
    assert.deepEqual(await runDiagnostics(ports, record), diagnose.failed);
    clock += diagnosticsIntervalMs;
    assert.deepEqual(await runDiagnostics(ports, record), diagnose.failed, 'due again a day later');
    assert.equal(filings.length, 2, 'each case is filed once, then reused');
    assert.deepEqual(Object.keys(record.filed!), ['diagnostic:test:tests/slow.test.ts', 'diagnostic:e2e:board']);
  }
  // A refused diagnostic filing is already filed, and a failed one is a note: neither aborts the run's own records.
  {
    let clock = Date.parse('2026-11-05T00:00:00Z');
    const diagnose = { failed: ['e2e:board'], catalogMs: 5 * 60_000 };
    const refusedRecord = bootstrapGate(repository, verified);
    assert.deepEqual(await runDiagnostics({ now: () => clock, file: async () => { throw refused(); }, diagnose: async () => diagnose }, refusedRecord), diagnose.failed);
    assert.equal(refusedRecord.filed!['diagnostic:e2e:board']!.item, null);
    assert.equal(refusedRecord.diagnosticsAt, new Date(clock).toISOString(), 'the run still records its verdict');
    const down = bootstrapGate(repository, verified);
    assert.deepEqual(await runDiagnostics({ now: () => clock, file: async () => { throw new Error('the control plane is down'); }, diagnose: async () => diagnose }, down), diagnose.failed);
    assert.deepEqual(down.notes, ['diagnostic:e2e:board: the control plane is down']);
    assert.deepEqual(down.filed, {});
    assert.equal(down.catalogMs, diagnose.catalogMs, 'the run still records its own fields');
  }
});

test('unit:gate-catalog-known-red — before any culprit search, a confirmed catalog-only e2e case (not smoke, not gate.core, not bound by a batch item) is re-run on the last verified commit: red there too is a filed known red and nothing is reverted, while smoke, gate.core and bound cases stay strict and blame their culprit (GY-3147)', async () => {
  const verified = sha(1), batch = [landing(2), landing(3)];
  const catalog = ['create-work-item', 'smoke', 'case-2', 'case-3', 'other'];
  // The measured catalog fits half the limit, so the gate runs the whole catalog — 'other' is catalog-only.
  const wholeWorld = (fails: (commit: string, check: string, call: number) => boolean) => {
    const world = gatePorts(batch, fails);
    world.ports.catalog = async () => catalog;
    return world;
  };
  const measured = () => ({ ...bootstrapGate(repository, verified), catalogMs: 60_000 });

  // A catalog case red on every commit yields a known red, not a revert of the first item.
  {
    const world = wholeWorld((_, check) => check === 'e2e:other');
    const record = measured();
    const outcome = await runGate(world.ports, record);
    assert.equal(outcome.outcome, 'verified');
    assert.deepEqual(outcome.outcome === 'verified' && outcome.knownRed, ['e2e:other']);
    assert.deepEqual(world.filed, ['known-red:e2e:other'], 'the known red is filed for an owner');
    assert.deepEqual(world.reverted, [], 'nothing is reverted for a case the batch did not break');
    assert.ok(world.runs.some(entry => entry.commit === verified && entry.checks.includes('e2e:other')), 'the case is re-run on the last verified commit before any culprit search');
  }
  // A catalog case the batch broke — it passes on the verified commit — is no known red: it blames its culprit.
  {
    const world = wholeWorld((commit, check) => check === 'e2e:other' && commit !== verified);
    assert.equal((await runGate(world.ports, measured())).outcome, 'reverted');
    assert.deepEqual(world.reverted, ['GY-2']);
    assert.deepEqual(world.filed, []);
  }
  // Smoke, gate.core and the batch's bound cases stay strict: red on every commit, each still blames its culprit and is never compared with the verified commit.
  for (const check of ['e2e:smoke', 'e2e:create-work-item', 'e2e:case-3']) {
    const world = wholeWorld((_, failing) => failing === check);
    assert.equal((await runGate(world.ports, measured())).outcome, 'reverted', `${check} must pass outright even when the whole catalog runs`);
    assert.ok(!world.runs.some(entry => entry.commit === verified), `${check} is never probed on the verified commit`);
    assert.deepEqual(world.filed, []);
    assert.deepEqual(world.reverted, ['GY-2'], `${check} still blames its culprit`);
  }
});

test('unit:gate-results-saved-before-filing — every check result is on the gate record before anything is filed — the run and re-run steps, and each probe verdict, for a flake, a known-red test and a known-red catalog case — so a filing failure or crash cannot lose them; a ports.file failure is logged as a note and the run still reaches its verdict (GY-3147)', async () => {
  const verified = sha(1), batch = [landing(2)];
  // The whole catalog runs; the flake passes its re-run, the test and the catalog case fail on every commit.
  const record = { ...bootstrapGate(repository, verified), catalogMs: 60_000 };
  const world = gatePorts(batch, (_commit, check, call) => (check === 'e2e:case-2' && call === 0) || check === 'test:tests/a.test.ts' || check === 'e2e:other');
  world.ports.catalog = async () => ['create-work-item', 'smoke', 'case-2', 'other'];
  const file = gateRecordPath(await temporaryDirectory('gate-results-before-filing'));
  world.ports.checkpoint = async () => { await writeGateRecord(file, record); };
  const filed: string[] = [];
  world.ports.file = async input => {
    const onDisk = readGateRecord(file)!;
    if (input.key === 'flake:e2e:case-2')
      assert.ok(Object.entries(onDisk.inFlight?.results ?? {}).some(([step, failed]) => step.includes('e2e:case-2') && !failed.includes('e2e:case-2')),
        'the re-run the flake passed is saved before the flake is filed');
    else assert.equal(onDisk.results[verified]?.[input.key.slice('known-red:'.length)], true, `the probe verdict for ${input.key.slice('known-red:'.length)} is saved before it is filed`);
    filed.push(input.key);
    return { item: `GY-${100 + filed.length}` };
  };
  assert.equal((await runGate(world.ports, record)).outcome, 'verified');
  assert.deepEqual(filed, ['flake:e2e:case-2', 'known-red:e2e:other', 'known-red:test:tests/a.test.ts'], 'three filings, each after its result was saved');

  // A filing that fails outright is logged as a note and loses nothing: the verdict stands and the results are already on disk.
  {
    const record2 = bootstrapGate(repository, verified);
    const world2 = gatePorts(batch, (_, check) => check === 'test:tests/a.test.ts');
    const file2 = gateRecordPath(await temporaryDirectory('gate-results-before-filing-2'));
    world2.ports.checkpoint = async () => { await writeGateRecord(file2, record2); };
    world2.ports.file = async () => { throw new Error('the control plane is unreachable'); };
    assert.equal((await runGate(world2.ports, record2)).outcome, 'verified', 'the run continues to its verdict');
    assert.deepEqual(record2.notes, ['known-red:test:tests/a.test.ts: the control plane is unreachable'], 'the failure is logged');
    assert.equal(readGateRecord(file2)!.results[verified]!['test:tests/a.test.ts'], true, 'the probe verdict was saved before the filing failed, so the crash lost nothing');
  }
});

test('e2e:diagnostic-failure-details — a scheduled diagnostic through batchGatePorts files the proof, the exact tested commit and the trial\'s failing step; the gate record keeps the latest details across a reload, a repeated failure keeps its item and shows its newer commit and step in master status, and a record without details still reads (GY-3264)', async () => {
  const { batchGatePorts } = await import('../src/daemon/cycle-batch-gate.js');
  const steps: Record<string, string> = { 'e2e:hard-math-smoke': 'step 2 solve the fixture: expected 42, received 41' };
  const filed: { key: string; description: string }[] = [];
  const base: MergeWriterReads = { ...reads('/unused').value,
    git: async args => args[0] === 'ls-tree' ? 'hard-math-smoke.json\nsmoke.json\nother.json' : '',
    trial: async (_commit, _files, trialItem) => {
      const proofs = trialItem.criteria.flatMap(criterion => criterion.proofs);
      return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {},
        e2e: proofs.map(proof => proof === 'e2e:smoke' ? { proof, case: 'smoke', executed: 1, failed: 0 }
          : { proof, case: proof.slice(4), executed: 1, failed: 1, ...(steps[proof] ? { failingStep: steps[proof] } : {}) }) } as unknown as MergeTrialRun;
    },
    createWork: async (input, key) => { filed.push({ key, description: input.description }); return { key: `GY-${3262 + filed.length}` }; } };
  let clock = Date.parse('2026-11-10T00:00:00Z');
  const ports = { ...batchGatePorts({ ...base, git: base.git! }, []), now: () => clock };
  const file = gateRecordPath(await temporaryDirectory('diagnostic-details'));

  // The first run files each failure with its proof, the exact commit and the trial's own failing step; none is invented.
  const first = sha(1);
  await writeGateRecord(file, bootstrapGate(repository, first));
  const record = readGateRecord(file)!;
  assert.deepEqual((await runDiagnostics(ports, record))!.sort(), ['e2e:hard-math-smoke', 'e2e:other']);
  const hardMath = filed.find(entry => entry.key === 'diagnostic:e2e:hard-math-smoke')!;
  assert.match(hardMath.description, new RegExp(`verified commit ${first} failed e2e:hard-math-smoke: step 2 solve the fixture: expected 42, received 41\\.`));
  assert.match(filed.find(entry => entry.key === 'diagnostic:e2e:other')!.description, new RegExp(`${first} failed e2e:other\\. It never blocks`), 'no detail, no invented cause');
  await writeGateRecord(file, record);
  assert.deepEqual(readGateRecord(file)!.diagnosticFailures!['e2e:hard-math-smoke'], { commit: first, detail: steps['e2e:hard-math-smoke'], at: new Date(clock).toISOString() });
  assert.equal(readGateRecord(file)!.diagnosticFailures!['e2e:other']!.detail, null);

  // A day later the same case fails on a newer commit with a newer step: its item is reused, and the newer detail survives a reload.
  clock += diagnosticsIntervalMs;
  const second = sha(2);
  steps['e2e:hard-math-smoke'] = 'step 3 check the answer: the run timed out after 600 seconds';
  const reloaded = readGateRecord(file)!;
  reloaded.verified = second;
  await runDiagnostics(ports, reloaded);
  assert.equal(filed.length, 2, 'an already-filed key files no duplicate');
  await writeGateRecord(file, reloaded);
  const status = gateSummary(readGateRecord(file))!.diagnosticFailures.find(failure => failure.check === 'e2e:hard-math-smoke');
  assert.deepEqual(status, { check: 'e2e:hard-math-smoke', commit: second, detail: steps['e2e:hard-math-smoke'], at: new Date(clock).toISOString(), item: 'GY-3263' },
    'master status batchGate names the newer commit, its failing step and the existing item');

  // A record an older loop wrote, with no details, still reads.
  const older = bootstrapGate(repository, first);
  delete older.diagnosticFailures;
  await writeGateRecord(file, older);
  assert.deepEqual(gateSummary(readGateRecord(file))!.diagnosticFailures, []);
});
