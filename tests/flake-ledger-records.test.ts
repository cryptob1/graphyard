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
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';

// GY-1498. A test that failed and passed on its rerun of the same commit was forgotten: nothing
// noticed one test flaking day after day. The flake ledger reads each such flake once and files
// one fix item per flaky test. Since GY-2010 the only flakes are the merge writer's trial flakes
// (GY-1834), recorded on each item's merge ledger; no CI job log is read.

const clock = Date.parse('2030-01-10T12:00:00Z');
const hour = 3_600_000, day = 24 * hour;
const iso = (at: number) => new Date(at).toISOString();
const sha = (n: number) => String(n).padStart(40, 'a');
// The modules under test are loaded inside each test, so a change without them fails its cases rather than the file.
const load = async () => ({ ...await import('../src/daemon/cycle-flakes.js'), ...await import('../src/flake-ledger.js'), ...await import('../src/model/flake-ledger.js') });
const emptyLedger = (): FlakeLedger => ({ version: 1, entries: [], read: {}, filed: {} });
const flaky = 'unit:fleet-panel-renders-registry — the fleet panel renders the registry';

/** An item whose trial of merge commit `merge` flaked on `tests`, `ago` before the clock; `proofs` are its criterion proofs. */
function trialled(n: number, merge: string, tests: string[], ago: number, proofs = ['unit:fleet-panel-renders-registry']): Work {
  return { id: `work-${n}`, key: `GY-${n}`, title: `Item ${n}`, stage: 'done', criteria: [{ id: 'AC-1', text: 'Works', proofs }],
    mergeLedger: { key: `GY-${n}`, state: 'reconciled', head: sha(5_000 + n), baseTip: null, mergeSha: merge, risk: null, intentAt: null, pushedAt: null, observedTip: null, refusal: null, events: 4,
      flakes: [{ head: sha(5_000 + n), mergeSha: merge, files: ['tests/fleet-panel.test.ts'], tests, at: iso(clock - ago) }] } } as unknown as Work;
}
function memoryStore(): FlakeLedgerStore & { ledger: FlakeLedger; writes: number } {
  const store = { ledger: emptyLedger(), writes: 0, read: async () => structuredClone(store.ledger), write: async (ledger: FlakeLedger) => { store.ledger = structuredClone(ledger); store.writes += 1; } };
  return store;
}
interface Fake { work: Work[]; filed: { title: string; priority: number; plannedFiles: string[]; proofs: string[]; key: string }[] }
function cycleOf(fake: Fake, store: FlakeLedgerStore, at = clock, file = true): Cycle {
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 0, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  const effects = {
    persist: async () => {}, flakeLedger: store,
    ...(file ? { fileFaultClass: async (input: any, key: string) => {
      fake.filed.push({ title: input.title, priority: input.priority, plannedFiles: input.plannedFiles, proofs: input.criteria.flatMap((criterion: any) => criterion.proofs), key });
      const item = { id: `filed-${fake.filed.length}`, key: `GY-${900 + fake.filed.length}`, title: input.title, stage: 'ready' } as unknown as Work;
      fake.work.push(item);
      return item;
    } } : {}),
  } as unknown as DaemonEffects;
  return { config, state: emptyDaemonState(config), effects, snapshot: { work: fake.work, now: iso(at) }, clock: at, now: () => at, performed: [] } as unknown as Cycle;
}
const fakeOf = (work: Work[]): Fake => ({ work, filed: [] });

test('unit:flake-ledger-records — a merge trial flake is read once, by its merge commit, into the 0600 ledger file, bounded to 500 entries and 30 days', async () => {
  const { flakeStep, flakeLedgerPath, flakeLedgerStore, emptyFlakeLedger, flakeLedgerLimit, recordTrialFlake } = await load();
  const root = await temporaryDirectory('flake-ledger');
  const store = flakeLedgerStore(root);
  const fake = fakeOf([trialled(1, sha(1), [flaky], hour), trialled(2, sha(2), [flaky, 'unit:other-proof — another'], 2 * hour)]);
  await flakeStep(cycleOf(fake, store));
  await flakeStep(cycleOf(fake, store, clock + 60_000));
  assert.equal(statSync(flakeLedgerPath(root)).mode & 0o777, 0o600);
  const ledger = await store.read();
  assert.deepEqual(Object.keys(ledger.read).sort(), [`trial:${sha(1)}`, `trial:${sha(2)}`], 'each merge commit is read once, however many cycles see it');
  assert.deepEqual(ledger.entries.map(({ test, check, sha: at, pr, source, failedRunId }) => ({ test, check, sha: at, pr, source, failedRunId })).sort((a, b) => a.sha.localeCompare(b.sha) || a.test!.localeCompare(b.test!)), [
    { test: flaky, check: 'trial', sha: sha(1), pr: null, source: 'trial-rerun', failedRunId: 0 },
    { test: flaky, check: 'trial', sha: sha(2), pr: null, source: 'trial-rerun', failedRunId: 0 },
    { test: 'unit:other-proof — another', check: 'trial', sha: sha(2), pr: null, source: 'trial-rerun', failedRunId: 0 },
  ]);
  assert.ok(ledger.entries.every(entry => typeof entry.at === 'string'));

  // Bounded: 600 flakes keep the newest 500, and one older than 30 days is never kept.
  const bounded = emptyFlakeLedger();
  for (let n = 0; n < 600; n++) recordTrialFlake(bounded, { key: 'GY-1', mergeSha: sha(n), tests: [`unit:t${n} — x`], proofs: null, at: iso(clock - (600 - n) * 60_000) }, clock);
  assert.equal(bounded.entries.length, flakeLedgerLimit);
  assert.equal(bounded.entries[0].sha, sha(100));
  assert.equal(recordTrialFlake(bounded, { key: 'GY-1', mergeSha: sha(9999), tests: [flaky], proofs: null, at: iso(clock - 31 * day) }, clock), false, 'an entry older than 30 days is not kept');
  const old = memoryStore();
  await flakeStep(cycleOf(fakeOf([trialled(3, sha(3), [flaky], 31 * day)]), old));
  assert.deepEqual(old.ledger.entries, [], 'a flake outside the 30-day retention is never read');
});

test('unit:flake-fix-item-filed-once — a criterion proof\'s third flake on its second commit within 7 days files one P1 "Flaky test" item planned on its proof\'s file; nothing more while open or for 7 days after it closes', async () => {
  const { flakeStep, flakyItemTitle } = await load();
  const store = memoryStore();
  // Two flakes of the item's own proof: under the threshold, nothing filed.
  const fake = fakeOf([trialled(1, sha(1), [flaky], 3 * day), trialled(2, sha(2), [flaky], 2 * day)]);
  await flakeStep(cycleOf(fake, store));
  assert.equal(fake.filed.length, 0, 'two flakes are not enough');
  // A third: one item.
  fake.work.push(trialled(3, sha(3), [flaky], day));
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
  fake.work.push(trialled(4, sha(4), [flaky], 30 * 60_000));
  for (let n = 0; n < 5; n++) await flakeStep(cycleOf(fake, store, clock + n * 60_000));
  assert.equal(fake.filed.length, 1, 'nothing more while the item is open');
  // It closes; within 7 days nothing more, after them a recurrence may file again.
  const item = fake.work.find(entry => entry.key === 'GY-901')!;
  (item as { stage: string }).stage = 'done';
  await flakeStep(cycleOf(fake, store, clock + hour));
  fake.work.push(trialled(5, sha(5), [flaky], -2 * day));
  await flakeStep(cycleOf(fake, store, clock + 3 * day));
  assert.equal(fake.filed.length, 1, 'nothing within 7 days of the close');
  for (const [n, ago] of [[7, -8 * day], [8, -8 * day - hour], [9, -8 * day - 2 * hour]] as const) fake.work.push(trialled(n, sha(10 + n), [flaky], ago));
  await flakeStep(cycleOf(fake, store, clock + 8 * day + 3 * hour));
  assert.equal(fake.filed.length, 2, 'a recurrence after the quiet period files again');

  // A filing that failed is retried, under the same key, so a lost reply returns the item already filed.
  const retried = memoryStore(), lost = fakeOf([trialled(1, sha(1), [flaky], 3 * hour), trialled(2, sha(2), [flaky], 2 * hour), trialled(3, sha(3), [flaky], hour)]);
  const cycle = cycleOf(lost, retried);
  (cycle.effects as any).fileFaultClass = async (_input: unknown, key: string) => { lost.filed.push({ key } as never); throw new Error('reply lost'); };
  const state = emptyDaemonState(cycle.config);
  await flakeStep({ ...cycle, state });
  await flakeStep({ ...cycleOf(lost, retried, clock + 60_000), state: { ...state, cycle: state.cycle + 5 } });
  assert.equal(lost.filed.length, 2);
  assert.equal(new Set(lost.filed.map(entry => entry.key)).size, 1, 'the retry files under the key the lost reply used');
});

test('unit:flake-ledger-never-relaxes-gates — a trial naming no test, or a test with no proof id, is recorded and files nothing; the ledger only reads, and an item without a trial flake contributes nothing', async () => {
  const { flakeStep } = await load();
  const store = memoryStore();
  const unnamed = 'the fleet panel renders without a proof id';
  const work = [
    trialled(1, sha(1), [], 3 * hour), trialled(2, sha(2), [], 2 * hour), trialled(3, sha(3), [], hour),
    trialled(4, sha(4), [unnamed], 3 * hour), trialled(5, sha(5), [unnamed], 2 * hour), trialled(6, sha(6), [unnamed], hour),
    { id: 'work-7', key: 'GY-7', title: 'No flake', stage: 'done', criteria: [] } as unknown as Work,
  ];
  const fake = fakeOf(work);
  const before = structuredClone(work);
  await flakeStep(cycleOf(fake, store));
  const ledger = await store.read();
  assert.deepEqual(ledger.entries.filter(entry => entry.test === 'tests/fleet-panel.test.ts').map(entry => entry.sha).sort(), [sha(1), sha(2), sha(3)], 'a trial naming no test is recorded under its files');
  assert.equal(ledger.entries.filter(entry => entry.test === unnamed).length, 3);
  assert.equal(fake.filed.length, 0, 'neither files anything');
  assert.equal(ledger.entries.length, 6, 'an item without a trial flake contributes nothing');
  // The ledger only reads: no item changes.
  assert.deepEqual(work, before);
});
