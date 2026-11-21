import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { emptyDaemonState } from '../src/daemon/state.js';
import { mergeWriterStep, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { trialHalfCelsius } from '../src/daemon/cpu-pressure.js';
import type { TrialRunHandle, TrialRunRequest } from '../src/merge-writer/trial-run.js';
import { mergeRecordKinds, type MergePorts, type MergeRecordEvent, type MergeTrialRun } from '../src/merge-writer/executor.js';
import { foldMergeLedger } from '../src/model-boundary/merge-ledger.js';
import { masterConfigSchema } from '../src/master.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { DaemonState } from '../src/daemon/state.js';
import type { Work } from '../src/model.js';

// GY-3401: on vishrog (24 cores, 99C) the GY-3373 guard stopped new launches but trials and
// sessions already running kept the host at its limit. Now, while the CPU temperature the guard
// reads sits at the trial halving limit (GY-3416: 5C under the 85C heat limit), trials already
// running finish, the merge writer starts no trial beyond half its cap, and the full cap returns
// once the reading drops below it. Driven through the merge writer's own step over detached trial
// runs (the fixture of merge-writer-refills-slots).

const proof = 'integration:hot-trial-cap';

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
  /** GY-3401: whether the CPU reads hot, and the most trials running at once after a start while it did. */
  hot = false;
  hotPeak = 0;
  recorded = new Map<number, MergeRecordEvent[]>();
  ledgerEvents: { kind: string; payload: unknown; work: string }[] = [];
  constructor(public submitted: number) {}
  live() { return [...this.runs.values()].filter(run => !run.finished).length; }
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
      parallel: 4, cores: 24,
      launchTrialRun: spec => {
        const run = new Run(spec, `/runs/${spec.key}-${spec.head.slice(0, 8)}`);
        world.runs.set(spec.key, run); world.launches.push(spec.key);
        world.peak = Math.max(world.peak, world.live());
        if (world.hot) world.hotPeak = Math.max(world.hotPeak, world.live());
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


/** The CPU reading the loop's close step leaves on the state before the merge writer runs. */
function reading(state: DaemonState, world: World, celsius: number) {
  world.hot = celsius >= trialHalfCelsius;
  state.cpuPressure = { at: iso(start), avg60: 20, steal: null, stat: null, celsius, samples: [], testBudget: null, trialCap: state.cpuPressure?.trialCap ?? null };
}

test(`${proof} — at the halving limit running trials finish, no trial starts beyond half the cap of 4, and the full cap returns once it cools`, { timeout: 60_000 }, async () => {
  const world = new World(0), state = emptyDaemonState(config), cycle = loop(world, state, false, start);
  reading(state, world, trialHalfCelsius - 1);
  // One head comes due a cycle, so each trial is its own flight and settles on its own.
  for (let n = 1; n <= 3; n++) { world.submitted = n; await cycle(); await waitFor(() => world.launches.length === n); }
  assert.deepEqual(world.launches, ['GY-1', 'GY-2', 'GY-3'], 'cool: three due heads start under the cap of 4');
  assert.deepEqual(state.cpuPressure?.trialCap, { now: 4, full: 4 });

  // The sensor reaches the halving limit (GY-3416: 5C under the 85C heat limit) and three more heads are due.
  reading(state, world, trialHalfCelsius);
  world.submitted = 6;
  await cycle();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(state.cpuPressure?.trialCap, { now: 2, full: 4 }, 'hot: the cap is halved, and the state carries both numbers');
  assert.deepEqual(world.launches, ['GY-1', 'GY-2', 'GY-3'], 'three trials already run: none starts beyond half the cap');
  assert.equal(world.live(), 3, 'the trials already running are not stopped');

  // Two of them finish and land; one slot under the halved cap frees, and only one head starts.
  world.finish('GY-1'); world.finish('GY-2');
  await waitFor(() => world.snapshot().filter(item => item.stage === 'done').length === 2);
  for (let round = 0; round < 3; round++) { await cycle(); await new Promise(resolve => setTimeout(resolve, 20)); }
  await waitFor(() => world.launches.length === 4);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(world.launches, ['GY-1', 'GY-2', 'GY-3', 'GY-4'], 'hot: one head fills the halved cap beside GY-3');
  assert.equal(world.hotPeak, 2, 'while hot, never more than 2 trials ran after a start');
  assert.ok(world.snapshot().slice(0, 2).every(item => item.stage === 'done'), 'the trials that ran on while hot finished and landed');

  // It cools below the halving limit: the full cap returns at the next cycle.
  reading(state, world, trialHalfCelsius - 1);
  await cycle();
  await waitFor(() => world.launches.length === 6);
  assert.deepEqual(world.launches, ['GY-1', 'GY-2', 'GY-3', 'GY-4', 'GY-5', 'GY-6'], 'cool again: the two waiting heads start beside the two running');
  assert.equal(world.live(), 4);
  assert.deepEqual(state.cpuPressure?.trialCap, { now: 4, full: 4 }, 'the full cap is back');
  for (const key of ['GY-3', 'GY-4', 'GY-5', 'GY-6']) world.finish(key);
});
