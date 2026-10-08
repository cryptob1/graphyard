import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { emptyDaemonState } from '../src/master-daemon.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import type { FlakeLedgerStore } from '../src/flake-ledger.js';
import type { FlakeLedger } from '../src/model/flake-ledger.js';
import { proofTestFile } from '../src/model/scope-companions.js';
import { mainFailedRerunLimit } from '../src/main-guard.js';
import { checkRerunLimit } from '../src/merge-queue.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';

// GY-1498. A required check that failed and passed on its one rerun of the same sha was recorded on
// the item (GY-516, GY-1497) and forgotten: nothing noticed one test flaking day after day. The flake
// ledger reads each such failed job once and files one fix item per repeatedly flaky test.

const clock = Date.parse('2030-01-10T12:00:00Z');
const hour = 3_600_000, day = 24 * hour;
const iso = (at: number) => new Date(at).toISOString();
const sha = (n: number) => String(n).padStart(40, 'a');
// The modules under test are loaded inside each test, so a change without them fails its cases rather than the file.
const load = async () => ({ ...await import('../src/daemon/cycle-flakes.js'), ...await import('../src/flake-ledger.js'), ...await import('../src/model/flake-ledger.js') });
const emptyLedger = (): FlakeLedger => ({ version: 1, entries: [], read: {}, filed: {} });
const flaky = 'unit:fleet-panel-renders-registry — the fleet panel renders the registry';

/** An item whose `test` check failed in job `job` on `head` and passed on its rerun, `ago` before the clock. */
function rerun(n: number, job: number, head: string, ago: number, state: 'passed' | 'failed' | 'owed' = 'passed'): Work {
  return { id: `work-${n}`, key: `GY-${n}`, title: `Item ${n}`, stage: 'done', submission: { epoch: 1, pr: 100 + n },
    checkReruns: [{ sha: head, check: 'test', failedRunId: job, state, at: iso(clock - ago - 60_000), ...(state === 'passed' ? { rerunId: job + 1, resolvedAt: iso(clock - ago) } : {}) }] } as unknown as Work;
}
function mainFlake(n: number, job: number | null, merge: string, ago: number): Work {
  return { id: `work-${n}`, key: `GY-${n}`, title: `Item ${n}`, stage: 'done', submission: { epoch: 1, pr: 100 + n },
    mainGuardFlakes: [{ mergeSha: merge, check: 'test', failedRunId: job, rerunRunId: job === null ? null : job + 1, at: iso(clock - ago) }] } as unknown as Work;
}
function memoryStore(): FlakeLedgerStore & { ledger: FlakeLedger; writes: number } {
  const store = { ledger: emptyLedger(), writes: 0, read: async () => structuredClone(store.ledger), write: async (ledger: FlakeLedger) => { store.ledger = structuredClone(ledger); store.writes += 1; } };
  return store;
}
interface Fake { work: Work[]; logs: Record<number, string[] | Error>; reads: number[]; filed: { title: string; priority: number; plannedFiles: string[]; proofs: string[]; key: string }[]; reruns: number[] }
function cycleOf(fake: Fake, store: FlakeLedgerStore, at = clock, file = true): Cycle {
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  const effects = {
    persist: async () => {}, flakeLedger: store,
    failedTests: async (job: number) => { fake.reads.push(job); const log = fake.logs[job]; if (log instanceof Error) throw log; return log ?? []; },
    rerunJob: async (job: number) => { fake.reruns.push(job); },
    ...(file ? { fileFaultClass: async (input: any, key: string) => {
      fake.filed.push({ title: input.title, priority: input.priority, plannedFiles: input.plannedFiles, proofs: input.criteria.flatMap((criterion: any) => criterion.proofs), key });
      const item = { id: `filed-${fake.filed.length}`, key: `GY-${900 + fake.filed.length}`, title: input.title, stage: 'ready' } as unknown as Work;
      fake.work.push(item);
      return item;
    } } : {}),
  } as unknown as DaemonEffects;
  return { config, state: emptyDaemonState(config), effects, snapshot: { work: fake.work, now: iso(at) }, clock: at, now: () => at, performed: [] } as unknown as Cycle;
}
const fakeOf = (work: Work[], logs: Fake['logs'] = {}): Fake => ({ work, logs, reads: [], filed: [], reruns: [] });

test('unit:flake-ledger-records — a passed PR rerun and a main guard flake are each read once, by failed run id, into the 0600 ledger file, bounded to 500 entries and 30 days', async () => {
  const { flakeStep, flakeLedgerPath, flakeLedgerStore, emptyFlakeLedger, flakeLedgerLimit, recordFlake } = await load();
  const root = await temporaryDirectory('flake-ledger');
  const store = flakeLedgerStore(root);
  const fake = fakeOf([rerun(1, 501, sha(1), hour), mainFlake(2, 601, sha(2), 2 * hour)], { 501: [flaky], 601: [flaky, 'unit:other-proof — another'] });
  await flakeStep(cycleOf(fake, store));
  await flakeStep(cycleOf(fake, store, clock + 60_000));
  assert.deepEqual(fake.reads.sort(), [501, 601], 'each failed job is read once, however many cycles see it');
  assert.equal(statSync(flakeLedgerPath(root)).mode & 0o777, 0o600);
  const ledger = await store.read();
  assert.deepEqual(ledger.entries.map(({ test, check, sha: at, pr, source, failedRunId }) => ({ test, check, sha: at, pr, source, failedRunId })).sort((a, b) => a.failedRunId - b.failedRunId || a.test!.localeCompare(b.test!)), [
    { test: flaky, check: 'test', sha: sha(1), pr: 101, source: 'pr-rerun', failedRunId: 501 },
    { test: flaky, check: 'test', sha: sha(2), pr: 102, source: 'main-rerun', failedRunId: 601 },
    { test: 'unit:other-proof — another', check: 'test', sha: sha(2), pr: 102, source: 'main-rerun', failedRunId: 601 },
  ]);
  assert.ok(ledger.entries.every(entry => typeof entry.at === 'string'));

  // Bounded: 600 flakes keep the newest 500, and one older than 30 days is dropped and never read.
  const bounded = emptyFlakeLedger();
  for (let n = 0; n < 600; n++) recordFlake(bounded, { check: 'test', sha: sha(n), pr: null, source: 'pr-rerun', failedRunId: n, at: iso(clock - (600 - n) * 60_000) }, [`unit:t${n} — x`], clock);
  assert.equal(bounded.entries.length, flakeLedgerLimit);
  assert.equal(bounded.entries[0].failedRunId, 100);
  recordFlake(bounded, { check: 'test', sha: sha(1), pr: null, source: 'pr-rerun', failedRunId: 9999, at: iso(clock - 31 * day) }, [flaky], clock);
  assert.ok(!bounded.entries.some(entry => entry.failedRunId === 9999), 'an entry older than 30 days is not kept');
  const old = fakeOf([rerun(3, 701, sha(3), 31 * day)], { 701: [flaky] });
  await flakeStep(cycleOf(old, memoryStore()));
  assert.deepEqual(old.reads, [], 'a flake outside the 30-day retention is never read');
});

test('unit:flake-fix-item-filed-once — 3 flakes on 2 shas within 7 days file one P1 "Flaky test" item planned on its proof\'s file; nothing more while open or for 7 days after it closes', async () => {
  const { flakeStep, flakyItemTitle } = await load();
  const store = memoryStore();
  // Two flakes on one sha: under the threshold, nothing filed.
  const fake = fakeOf([rerun(1, 501, sha(1), 3 * day), rerun(2, 502, sha(1), 2 * day)], { 501: [flaky], 502: [flaky], 503: [flaky], 504: [flaky], 505: [flaky], 506: [flaky] });
  await flakeStep(cycleOf(fake, store));
  assert.equal(fake.filed.length, 0);
  // A third on one sha still has one sha: nothing filed.
  fake.work.push(rerun(3, 503, sha(1), day));
  await flakeStep(cycleOf(fake, store));
  assert.equal(fake.filed.length, 0, 'three flakes on one sha are not enough');
  // A fourth on a second sha: one item.
  fake.work.push(rerun(4, 504, sha(2), hour));
  await flakeStep(cycleOf(fake, store));
  assert.equal(fake.filed.length, 1);
  const [filed] = fake.filed;
  assert.equal(filed.title, `Flaky test: ${flaky}`);
  assert.equal(filed.title, flakyItemTitle(flaky));
  assert.equal(filed.priority, 1);
  assert.deepEqual(filed.proofs, ['unit:fleet-panel-renders-registry']);
  assert.deepEqual(filed.plannedFiles, [proofTestFile(['unit:fleet-panel-renders-registry'])]);
  assert.deepEqual(filed.plannedFiles, ['tests/fleet-panel-renders-registry.test.ts']);

  // While it is open, more flakes file nothing.
  fake.work.push(rerun(5, 505, sha(3), 30 * 60_000));
  for (let n = 0; n < 5; n++) await flakeStep(cycleOf(fake, store, clock + n * 60_000));
  assert.equal(fake.filed.length, 1, 'nothing more while the item is open');
  // It closes; within 7 days nothing more, after them a recurrence may file again.
  const item = fake.work.find(entry => entry.key === 'GY-901')!;
  (item as { stage: string }).stage = 'done';
  await flakeStep(cycleOf(fake, store, clock + hour));
  fake.work.push(rerun(6, 506, sha(4), -2 * day));
  await flakeStep(cycleOf(fake, store, clock + 3 * day));
  assert.equal(fake.filed.length, 1, 'nothing within 7 days of the close');
  for (const [n, ago] of [[7, -8 * day], [8, -8 * day - hour], [9, -8 * day - 2 * hour]] as const) { fake.work.push(rerun(n, 600 + n, sha(10 + n), ago)); fake.logs[600 + n] = [flaky]; }
  await flakeStep(cycleOf(fake, store, clock + 8 * day + 3 * hour));
  assert.equal(fake.filed.length, 2, 'a recurrence after the quiet period files again');

  // A filing that failed is retried, under the same key, so a lost reply returns the item already filed.
  const retried = memoryStore(), lost = fakeOf([rerun(1, 501, sha(1), 3 * hour), rerun(2, 502, sha(2), 2 * hour), rerun(3, 503, sha(3), hour)], { 501: [flaky], 502: [flaky], 503: [flaky] });
  const cycle = cycleOf(lost, retried);
  (cycle.effects as any).fileFaultClass = async (_input: unknown, key: string) => { lost.filed.push({ key } as never); throw new Error('reply lost'); };
  const state = emptyDaemonState(cycle.config);
  await flakeStep({ ...cycle, state });
  await flakeStep({ ...cycleOf(lost, retried, clock + 60_000), state: { ...state, cycle: state.cycle + 5 } });
  assert.equal(lost.filed.length, 2);
  assert.equal(new Set(lost.filed.map(entry => entry.key)).size, 1, 'the retry files under the key the lost reply used');
});

test('unit:flake-ledger-never-relaxes-gates — a log naming no test, or a test with no proof id, is recorded and files nothing; a failure with no passing rerun is never recorded; reruns and reverts are unchanged', async () => {
  const { flakeStep, flakeSources } = await load();
  const store = memoryStore();
  const unnamed = 'the fleet panel renders without a proof id';
  const work = [
    rerun(1, 501, sha(1), 3 * hour), rerun(2, 502, sha(2), 2 * hour), rerun(3, 503, sha(3), hour),
    rerun(4, 504, sha(4), 3 * hour), rerun(5, 505, sha(5), 2 * hour), rerun(6, 506, sha(6), hour),
    rerun(7, 507, sha(7), hour, 'failed'), rerun(8, 508, sha(8), hour, 'owed'), mainFlake(9, null, sha(9), hour),
  ];
  const fake = fakeOf(work, { 501: [], 502: [], 503: [], 504: [unnamed], 505: [unnamed], 506: [unnamed], 507: [flaky], 508: [flaky] });
  const before = structuredClone(work);
  await flakeStep(cycleOf(fake, store));
  const ledger = await store.read();
  assert.deepEqual(ledger.entries.filter(entry => entry.test === null).map(entry => [entry.check, entry.failedRunId]), [['test', 501], ['test', 502], ['test', 503]], 'a log naming no test is recorded under its check');
  assert.equal(ledger.entries.filter(entry => entry.test === unnamed).length, 3);
  assert.equal(fake.filed.length, 0, 'neither files anything');
  assert.ok(!fake.reads.includes(507) && !fake.reads.includes(508), 'a failure whose rerun failed or has not passed is never read');
  assert.ok(!ledger.entries.some(entry => [507, 508].includes(entry.failedRunId)));
  assert.deepEqual(flakeSources(work).map(source => source.failedRunId), [501, 502, 503, 504, 505, 506], 'a main flake with no failed run has no job to read');
  // The ledger only reads: no item, rerun or revert changes, and the single reruns stand.
  assert.deepEqual(work, before);
  assert.deepEqual(fake.reruns, []);
  assert.equal(mainFailedRerunLimit, 1);
  assert.equal(checkRerunLimit, 20);
  // A log that cannot be read is retried, then recorded under its check so it is not read forever.
  const unreadable = fakeOf([rerun(1, 801, sha(1), hour)], { 801: new Error('log expired') }), kept = memoryStore();
  for (let n = 0; n < 4; n++) await flakeStep(cycleOf(unreadable, kept, clock + n * 60_000));
  assert.deepEqual(unreadable.reads, [801, 801, 801]);
  assert.deepEqual((await kept.read()).entries.map(entry => [entry.test, entry.failedRunId]), [[null, 801]]);
});
