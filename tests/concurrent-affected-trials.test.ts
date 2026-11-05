import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { mergeWriterIdle, mergeWriterSummary, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { MergeRecordEvent } from '../src/merge-writer/executor.js';
import { trialFailurePrefix } from '../src/model/rework-ground.js';
import type { MergeLedgerState } from '../src/model/merge-ledger.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';

// GY-3120: each queued head is trialled alone on the current main tip, up to run.mergeWriter.parallel
// trials at once. A head whose trial passes lands as soon as it passes — re-merged onto whatever the
// heads that landed before it left, with no second trial — and never waits on or cancels another
// head's trial.

const start = Date.parse('2030-06-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy' } } });
const githubDouble = new Proxy({}, { get: (_, name) => { throw new Error(`the merge writer step called GitHub (${String(name)})`); } });

/** main's first-parent chain, what the writer recorded, every trial with the head and tip it ran on, and the order things happened in. */
class World {
  main = [sha('base')];
  pushes: string[] = [];
  heads = new Map<string, number>();
  recorded = new Map<number, MergeRecordEvent[]>();
  trials: { n: number; baseTip: string }[] = [];
  log: string[] = [];
  running = 0; widest = 0;
  /** `trialMs(n)`: how long head n's trial runs; `failing`: the heads whose trial fails. */
  constructor(readonly count: number, readonly trialMs: (n: number) => number, readonly failing: number[] = [], readonly parallel = 3) {}
  head(n: number) { return sha(`head${n}`); }
  ledger(n: number) {
    let ledger = null as MergeLedgerState | null;
    for (const event of this.recorded.get(n) ?? []) {
      if (event.kind === 'intent') ledger = { key: `GY-${n}`, state: 'intent', head: event.head, baseTip: event.baseTip, mergeSha: event.mergeSha, risk: event.risk, intentAt: event.at, pushedAt: null, observedTip: null, refusal: null, events: (ledger?.events ?? 0) + 1 };
      else if (event.kind === 'pushed' && ledger) ledger = { ...ledger, state: 'pushed', pushedAt: event.pushedAt, events: ledger.events + 1 };
      else if (event.kind === 'reconciled' && ledger) ledger = { ...ledger, state: 'reconciled', observedTip: event.observedTip, events: ledger.events + 1 };
      else if (event.kind === 'refused') ledger = { key: `GY-${n}`, head: event.head, baseTip: null, mergeSha: null, risk: null, intentAt: null, pushedAt: null, observedTip: null, events: 1, ...ledger, state: 'refused', refusal: { kind: 'merge', reason: event.reason } };
    }
    return ledger;
  }
  snapshot(): Work[] {
    return Array.from({ length: this.count }, (_, index) => index + 1).map(n => {
      const ledger = this.ledger(n), delivered = ledger?.state === 'reconciled';
      const candidate = { sha: this.head(n), baseSha: sha('base'), pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' };
      return {
        id: `w${n}`, key: `GY-${n}`, description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
        policy: { checks: ['test'], review: true }, revision: 1, policyRevision: 1, createdAt: iso(start + n * 1000), updatedAt: iso(start), stageEnteredAt: iso(start + n * 1000),
        ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: n }, candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [], mergeLedger: ledger,
        observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: delivered, mergeSha: delivered ? ledger!.mergeSha : null, mergeable: true, protected: false, baseTip: this.main[0], baseTipContained: true, at: iso(start) },
        gates: ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: name !== 'test' && name !== 'merge', reasons: [] })),
        ...(delivered ? { stage: 'done', delivery: { mergedAt: ledger!.pushedAt!, mergeSha: ledger!.mergeSha!, authorizationRevision: 1 } } : { stage: 'build' }),
      } as unknown as Work;
    });
  }
  ports(): MergeWriterReads {
    const world = this;
    return {
      baseBranch: 'main', now: () => start, parallel: this.parallel,
      fetch: async () => world.main[0]!,
      merge: async (head, baseTip) => {
        const n = Array.from({ length: world.count }, (_, index) => index + 1).find(entry => world.head(entry) === head)!;
        const mergeSha = sha(`merge:${head}:${baseTip}`);
        world.heads.set(mergeSha, n);
        return { mergeSha, files: [`src/item-${n}.ts`] };
      },
      trial: async (mergeSha, files, _item, baseTip) => {
        const n = world.heads.get(mergeSha)!;
        assert.deepEqual(files, [`src/item-${n}.ts`], 'a trial is handed only its own head\'s change, the affected selection\'s input');
        world.trials.push({ n, baseTip: baseTip! });
        world.running += 1; world.widest = Math.max(world.widest, world.running);
        await new Promise(resolve => setTimeout(resolve, world.trialMs(n)));
        world.running -= 1;
        world.log.push(`trial-done:${n}`);
        const failed = world.failing.includes(n);
        return { build: 'pass', tests: { passed: failed ? 0 : 1, failed: failed ? ['tests/item.test.ts'] : [], files: 1 }, durationMs: world.trialMs(n), logTail: '', files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: failed ? 1 : 0 } } };
      },
      push: async (mergeSha, baseTip) => {
        if (baseTip !== world.main[0]) return 'rejected';
        world.main.unshift(mergeSha);
        world.pushes.push(mergeSha);
        world.log.push(`landed:${world.heads.get(mergeSha)}`);
        return 'pushed';
      },
      holds: async commit => world.main.includes(commit),
      record: async (item, event) => { const n = Number(item.key.slice(3)); world.recorded.set(n, [...(world.recorded.get(n) ?? []), event]); },
    };
  }
}

const harness = (world: World) => {
  const reworked: string[] = [];
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: world.snapshot(), now: iso(start) }), closeSession: () => {}, dispatch: async () => {},
    decisions: async () => ({ decisions: [] }), persist: async () => {}, github: githubDouble, merge: githubDouble, mergeWriter: world.ports(),
    rework: async (work: Work) => { reworked.push(work.key); } } as unknown as DaemonEffects;
  return { state: emptyDaemonState(config), effects, reworked };
};
const kinds = (world: World, n: number) => (world.recorded.get(n) ?? []).map(event => event.kind);

test('integration:concurrent-affected-trials — three heads trial at once, each alone on main; each lands as soon as its trial passes, a later one re-merged onto the moved tip without a second trial', { timeout: 30_000 }, async () => {
  // The oldest head's trial is the slowest: the younger heads land first, never waiting on it.
  const world = new World(3, n => [0, 300, 150, 30][n]!);
  const { state, effects } = harness(world);
  await runCycle(config, state, effects, () => start);
  assert.deepEqual(mergeWriterSummary(state.mergeWriter, start).inFlights?.map(entry => entry.key), ['GY-1', 'GY-2', 'GY-3'], 'master status names every head in flight');
  await mergeWriterIdle(state);
  assert.equal(world.widest, 3, 'the three trials ran at once');
  assert.deepEqual(world.trials.map(entry => [entry.n, entry.baseTip]).sort(), [1, 2, 3].map(n => [n, sha('base')]), 'one trial per head, each alone on the base tip');
  assert.deepEqual(world.log, ['trial-done:3', 'landed:3', 'trial-done:2', 'landed:2', 'trial-done:1', 'landed:1'], 'each head lands as soon as its own trial passes');
  const m3 = sha(`merge:${world.head(3)}:${sha('base')}`), m2 = sha(`merge:${world.head(2)}:${m3}`), m1 = sha(`merge:${world.head(1)}:${m2}`);
  assert.deepEqual(world.pushes, [m3, m2, m1], 'a head whose base moved under its trial is re-merged onto the tip as it stands');
  assert.deepEqual(world.main.slice(0, 4), [m1, m2, m3, sha('base')]);
  assert.deepEqual(kinds(world, 3), ['intent', 'trial', 'pushed', 'reconciled']);
  for (const n of [1, 2]) assert.deepEqual(kinds(world, n), ['intent', 'trial', 'intent', 'pushed', 'reconciled'], `GY-${n} records the re-merge's intent and lands without another trial`);
  await runCycle(config, state, effects, () => start + 60_000);
  assert.equal(state.mergeWriter.inFlights, undefined, 'a settled flight leaves no head in flight');
  assert.equal(state.mergeWriter.inFlight, null);
});

test('integration:concurrent-affected-trials — a failing head is refused for rework while the heads beside it land without being trialled again', { timeout: 30_000 }, async () => {
  const world = new World(3, n => [0, 30, 60, 90][n]!, [2]);
  const { state, effects, reworked } = harness(world);
  await runCycle(config, state, effects, () => start);
  await mergeWriterIdle(state);
  assert.equal(world.trials.length, 3, 'no head is trialled twice');
  const m1 = sha(`merge:${world.head(1)}:${sha('base')}`), m3 = sha(`merge:${world.head(3)}:${m1}`);
  assert.deepEqual(world.pushes, [m1, m3]);
  assert.deepEqual(kinds(world, 2), ['intent', 'trial', 'refused']);
  const refusal = world.recorded.get(2)!.find(event => event.kind === 'refused')!;
  assert.ok(refusal.kind === 'refused' && refusal.reason.startsWith(trialFailurePrefix), 'the refusal grounds the failing head\'s rework');
  await runCycle(config, state, effects, () => start + 60_000);
  assert.deepEqual(reworked, ['GY-2'], 'the failing head returns to a worker');
});

test('integration:concurrent-affected-trials — no more than run.mergeWriter.parallel heads trial at once; the queue only orders which head starts next', { timeout: 30_000 }, async () => {
  const world = new World(5, () => 20, [], 2);
  const { state, effects } = harness(world);
  await runCycle(config, state, effects, () => start);
  assert.deepEqual(state.mergeWriter.inFlights?.map(entry => entry.key), ['GY-1', 'GY-2'], 'the two oldest heads start first');
  await mergeWriterIdle(state);
  assert.equal(world.widest, 2);
  for (let cycle = 1; cycle < 8; cycle++) { await runCycle(config, state, effects, () => start + cycle * 60_000); await mergeWriterIdle(state); }
  assert.equal(world.widest, 2, 'never more than the configured trials at once');
  assert.deepEqual(world.trials.map(entry => entry.n), [1, 2, 3, 4, 5], 'one trial per head, in queue order');
  assert.equal(world.pushes.length, 5, 'every head lands');
});
