import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { emptyDaemonState } from '../src/daemon/state.js';
import { mergeWriterIdle, mergeWriterStep, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { TrialRunHandle, TrialRunRequest } from '../src/merge-writer/trial-run.js';
import { mergeRecordKinds, type MergePorts, type MergeRecordEvent, type MergeTrialRun } from '../src/merge-writer/executor.js';
import { foldMergeLedger } from '../src/model-boundary/merge-ledger.js';
import { masterConfigSchema } from '../src/master.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { DaemonState } from '../src/daemon/state.js';
import type { Work } from '../src/model.js';

// GY-3182: with `parallel` slots, a head that becomes due while another head's trial runs starts
// its own trial on the next cycle — it never waits for the running flight to settle — and no more
// than `parallel` trials ever run at once. Trials started in different cycles are each adopted by
// the loop that follows a restart.

const start = Date.parse('2030-09-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const base = sha('base');
const pass: MergeTrialRun = { build: 'pass', tests: { passed: 3, failed: [], files: 3 }, durationMs: 1000, logTail: '', files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } };

/** One detached trial run: alive until it reaches its verdict, watched only by the loop processes still alive. */
class Run {
  private verdict: MergeTrialRun | null = null;
  private watchers = new Set<(verdict: MergeTrialRun) => void>();
  finished = false;
  constructor(readonly spec: TrialRunRequest, readonly directory: string) {}
  watch(): Promise<MergeTrialRun> { return this.verdict ? Promise.resolve(this.verdict) : new Promise(resolve => this.watchers.add(resolve)); }
  finish(verdict: MergeTrialRun) { this.verdict = verdict; for (const watcher of this.watchers) watcher(verdict); this.watchers.clear(); }
  die() { this.watchers.clear(); }
}

/** Main's chain, the ledger, and the detached runs; `submitted` items are the ones a worker has handed in so far. */
class World {
  main = [base];
  runs = new Map<string, Run>();
  launches: string[] = [];
  /** The most trials running at once across the whole test. */
  peak = 0;
  recorded = new Map<number, MergeRecordEvent[]>();
  ledgerEvents: { kind: string; payload: unknown; work: string }[] = [];
  constructor(public submitted: number) {}
  private live() { return [...this.runs.values()].filter(run => !run.finished).length; }
  snapshot(): Work[] {
    const folded = foldMergeLedger(this.ledgerEvents as never);
    return Array.from({ length: this.submitted }, (_, index) => index + 1).map(n => {
      const ledger = folded[`GY-${n}`] ?? null, delivered = ledger?.state === 'reconciled';
      const candidate = { sha: sha(`head${n}`), baseSha: base, pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' };
      return {
        id: `w${n}`, key: `GY-${n}`, title: `Item ${n}`, type: 'feature', description: '', priority: 1, dependencies: [],
        criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }], policy: { checks: ['test'], review: true },
        revision: 1, policyRevision: 1, createdAt: iso(start + n * 1000), updatedAt: iso(start), stageEnteredAt: iso(start + n * 1000),
        ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: n }, candidate, reworkRequested: false,
        scenarioRequirements: [], evidence: [], blocker: null, violations: [], mergeLedger: ledger,
        observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: delivered, mergeSha: delivered ? ledger!.mergeSha : null, mergeable: true, protected: false, baseTip: this.main[0], baseTipContained: true, at: iso(start) },
        gates: ['ready', 'build', 'review'].map(name => ({ name, passed: true, reasons: [] })),
        ...(delivered ? { stage: 'done', delivery: { mergedAt: ledger!.pushedAt!, mergeSha: ledger!.mergeSha!, authorizationRevision: 1 } } : { stage: 'build' }),
      } as unknown as Work;
    });
  }
  reads(adopt: boolean): MergeWriterReads {
    const world = this;
    const ports: MergePorts = {
      baseBranch: 'main', now: () => start,
      fetch: async () => world.main[0]!,
      merge: async (head, tip) => ({ mergeSha: sha(`merge:${head}:${tip}`), files: ['src/item.ts'] }),
      trial: async () => { throw new Error('these reads launch detached trial runs only'); },
      push: async mergeSha => { world.main.unshift(mergeSha); return 'pushed'; },
      holds: async commit => world.main.includes(commit),
      record: async (item, event) => {
        const n = Number(item.key.slice(3));
        world.recorded.set(n, [...(world.recorded.get(n) ?? []), event]);
        const { kind, ...fields } = event as typeof event & { kind: string };
        const payload = kind === 'intent' ? { key: item.key, ...fields } : kind === 'refused' ? { ...fields, kind: 'merge' } : fields;
        world.ledgerEvents.push({ kind: mergeRecordKinds[kind], payload, work: item.key });
      },
    };
    const handle = (run: Run): TrialRunHandle => ({ directory: run.directory, mergeSha: run.spec.mergeSha, trial: () => run.watch(), detach: () => {}, cancel: () => { world.runs.delete(run.spec.key); } });
    return {
      ...ports,
      parallel: 3,
      launchTrialRun: spec => {
        const run = new Run(spec, `/runs/${spec.key}-${spec.head.slice(0, 8)}`);
        world.runs.set(spec.key, run); world.launches.push(spec.key);
        world.peak = Math.max(world.peak, world.live());
        return handle(run);
      },
      ...(adopt ? { adoptTrialRun: async (ref: { key: string; head: string; mergeSha: string; directory: string }) => {
        const run = world.runs.get(ref.key);
        return run && run.spec.mergeSha === ref.mergeSha && run.directory === ref.directory ? handle(run) : null;
      } } : {}),
      stopTrialRun: ref => { for (const run of world.runs.values()) if (run.directory === ref.directory) world.runs.delete(run.spec.key); },
    };
  }
  /** A run reaches its verdict and leaves the set of running trials. */
  finish(key: string) { const run = this.runs.get(key)!; run.finish(pass); run.finished = true; }
}

/** One loop process over the world: its own state and reads; each call is one cycle. */
function loop(world: World, state: DaemonState, adopt: boolean, from: number) {
  let clock = from;
  const effects = { mergeWriter: world.reads(adopt), persist: async () => {}, rework: async () => {} };
  return async () => { clock += 60_000; await mergeWriterStep({ state, effects, now: () => clock, snapshot: { work: world.snapshot(), now: iso(clock) }, performed: [] } as unknown as Cycle); };
}
const waitFor = async (what: () => boolean, ms = 5_000) => { for (let waited = 0; !what() && waited < ms; waited += 5) await new Promise(resolve => setTimeout(resolve, 5)); };

test('unit:tests/merge-writer-refills-slots.test.ts — with parallel 3 and one trial running, a head that becomes due starts its trial on the next cycle, the third fills the last slot, and a fourth waits for a slot: never more than 3 at once', { timeout: 60_000 }, async () => {
  const world = new World(1), state = emptyDaemonState(config), cycle = loop(world, state, false, start);
  await cycle();
  await waitFor(() => world.launches.length === 1);
  assert.deepEqual(world.launches, ['GY-1'], 'the only due head starts its trial');

  // GY-2 is submitted while GY-1's trial runs: the next cycle starts its trial beside it.
  world.submitted = 2;
  await cycle();
  await waitFor(() => world.launches.length === 2);
  assert.deepEqual(world.launches, ['GY-1', 'GY-2'], 'GY-2 started without waiting for GY-1 to settle');
  const positions = state.mergeWriter.inFlights ?? [];
  assert.deepEqual(positions.map(entry => entry.key), ['GY-1', 'GY-2'], 'master status shows both heads in flight');
  assert.notEqual(positions[0]!.startedAt, positions[1]!.startedAt, 'each started on its own cycle');

  // Three more are submitted: one fills the last slot, the other two wait.
  world.submitted = 5;
  await cycle();
  await waitFor(() => world.launches.length === 3);
  await cycle();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(world.launches, ['GY-1', 'GY-2', 'GY-3'], 'the third slot filled; nothing beyond it started');
  assert.equal(state.mergeWriter.inFlights?.length, 3);

  // GY-1 lands: the cycle that settles it starts nothing (the loop upgrades onto the merge), the next fills its slot.
  world.finish('GY-1');
  await waitFor(() => world.snapshot()[0]!.stage === 'done');
  await cycle();
  await cycle();
  await waitFor(() => world.launches.length === 4);
  assert.deepEqual(world.launches, ['GY-1', 'GY-2', 'GY-3', 'GY-4'], 'the freed slot went to the next due head while GY-2 and GY-3 ran on');
  assert.deepEqual(state.mergeWriter.inFlights?.map(entry => entry.key), ['GY-2', 'GY-3', 'GY-4']);
  assert.equal(world.peak, 3, 'never more than 3 trials ran at once');

  for (const key of ['GY-2', 'GY-3', 'GY-4']) world.finish(key);
  await mergeWriterIdle(state);
  for (let round = 0; round < 6 && world.snapshot().some(item => item.stage !== 'done'); round++) {
    await cycle();
    await waitFor(() => world.runs.has('GY-5'), 200);
    if (world.runs.has('GY-5')) world.finish('GY-5');
    await mergeWriterIdle(state);
  }
  assert.ok(world.snapshot().every(item => item.stage === 'done'), 'every head landed');
  assert.equal(world.peak, 3);
  for (let n = 1; n <= 5; n++) assert.equal(world.recorded.get(n)!.filter(event => event.kind === 'trial').length, 1, `GY-${n} ran exactly one trial`);
});

test('unit:tests/merge-writer-refills-slots.test.ts — a loop restart while two independently started trials run adopts both runs', { timeout: 60_000 }, async () => {
  const world = new World(1), first = emptyDaemonState(config), stepOne = loop(world, first, false, start);
  await stepOne();
  await waitFor(() => world.launches.length === 1);
  world.submitted = 2;
  await stepOne();
  await waitFor(() => world.launches.length === 2);
  assert.ok(first.mergeWriter.inFlights?.length === 2 && first.mergeWriter.inFlights.every(entry => entry.run), 'both heads carry their run on the persisted state');

  // The loop restarts: its watchers die, the runs live on, and the next loop reads only the persisted state.
  for (const run of world.runs.values()) run.die();
  const next = structuredClone(first), stepTwo = loop(world, next, true, start + 600_000);
  await stepTwo();
  assert.match(next.actions['merge-writer-trial-adoption']?.detail ?? '', /Adopted the merge trial\(s\) of GY-1, GY-2/, 'both runs were adopted');
  assert.deepEqual(next.mergeWriter.inFlights?.map(entry => entry.key), ['GY-1', 'GY-2']);

  world.finish('GY-1'); world.finish('GY-2');
  await mergeWriterIdle(next);
  await stepTwo();
  assert.deepEqual(world.launches, ['GY-1', 'GY-2'], 'no trial ran a second time');
  assert.ok(world.snapshot().every(item => item.stage === 'done'), 'both heads landed on their adopted trials');
  for (const action of Object.values(next.actions)) assert.ok(!/Settled an open intent/.test(action.detail ?? ''), 'no open intent was settled as refused');
});
