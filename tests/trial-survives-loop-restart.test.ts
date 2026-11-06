import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { emptyDaemonState } from '../src/daemon/state.js';
import { mergeWriterIdle, mergeWriterStep, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { TrialRunHandle, TrialRunRequest } from '../src/merge-writer/trial-run.js';
import { mergeRecordKinds, type MergePorts, type MergeRecordEvent, type MergeTrialRun } from '../src/merge-writer/executor.js';
import { foldMergeLedger } from '../src/model-boundary/merge-ledger.js';
import { trialFailurePrefix } from '../src/model/rework-ground.js';
import { masterConfigSchema } from '../src/master.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { DaemonState } from '../src/daemon/state.js';
import type { Work } from '../src/model.js';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultChildRun } from '../src/child-runner.js';
import { trialMerge } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3159: a merge trial in progress when the loop restarts onto a new release reaches its own
// verdict. The restart leaves each detached trial run alive; the next loop adopts it — the run's
// own promise answers in place of a fresh launch — and the head settles on the trial's verdict:
// merged when it passes, refused for its own failure when it fails, never settled as refused merely
// because the loop restarted. A run a restart left dead (no verdict recorded) falls back to the
// old settle-and-requeue, and the fallback is what keeps a hard crash from stalling the queue.

const start = Date.parse('2030-09-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const base = sha('base');

/** One detached trial run the loops share across a restart: alive until it reaches its verdict, and watched only by processes this restart left alive. */
class Run {
  private verdict: MergeTrialRun | null = null;
  private watchers = new Set<(verdict: MergeTrialRun) => void>();
  stopped = false;
  constructor(readonly spec: TrialRunRequest, readonly directory: string) {}
  /** Watches the run to its verdict; a process that dies waiting (the restart) never reports. */
  watch(): Promise<MergeTrialRun> {
    if (this.verdict) return Promise.resolve(this.verdict);
    return new Promise(resolve => this.watchers.add(resolve));
  }
  /** The run's own process ends: whatever it reached is its verdict, reported to every watcher alive. */
  finish(verdict: MergeTrialRun) { this.verdict = verdict; for (const watcher of this.watchers) watcher(verdict); this.watchers.clear(); }
  /** The loop process that watched this run died at the restart: its watcher never reports. */
  die() { this.watchers.clear(); }
}

/** The world a merge flight runs against: main's chain, the ledger, and the detached trial runs the loops share across the restart. */
class World {
  main = [base];
  runs = new Map<string, Run>();
  recorded = new Map<number, MergeRecordEvent[]>();
  ledgerEvents: { kind: string; payload: unknown; work: string }[] = [];
  reworks: Work[] = [];
  constructor(readonly count: number) {}
  head(n: number) { return sha(`head${n}`); }
  fold() { return foldMergeLedger(this.ledgerEvents as never); }
  snapshot(): Work[] {
    const folded = this.fold();
    return Array.from({ length: this.count }, (_, index) => index + 1).map(n => {
      const ledger = folded[`GY-${n}`] ?? null, delivered = ledger?.state === 'reconciled';
      const candidate = { sha: this.head(n), baseSha: base, pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' };
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
  ports(options: { adopt?: boolean } = {}): MergeWriterReads {
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
    const handle = (run: Run): TrialRunHandle => ({ directory: run.directory, mergeSha: run.spec.mergeSha,
      trial: () => run.watch(), detach: () => {}, cancel: () => { run.stopped = true; world.runs.delete(run.spec.key); } });
    return {
      ...ports,
      parallel: 2,
      launchTrialRun: spec => { const run = new Run(spec, `/runs/${spec.key}-${spec.head.slice(0, 8)}`); world.runs.set(spec.key, run); return handle(run); },
      ...(options.adopt ? { adoptTrialRun: async (ref: { key: string; head: string; mergeSha: string; directory: string }) => {
        const run = world.runs.get(ref.key);
        return run && run.spec.head === ref.head && run.spec.mergeSha === ref.mergeSha && run.directory === ref.directory ? handle(run) : null;
      } } : {}),
      stopTrialRun: ref => { for (const run of world.runs.values()) if (run.directory === ref.directory) { run.stopped = true; world.runs.delete(run.spec.key); } },
    };
  }
}

const pass: MergeTrialRun = { build: 'pass', tests: { passed: 3, failed: [], files: 3 }, durationMs: 1000, logTail: '', files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } };
const ownFailure: MergeTrialRun = { build: 'pass', tests: { passed: 0, failed: ['tests/item.test.ts'], files: 1 }, durationMs: 1000, logTail: 'not ok 1 - unit:item-works works', files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 1 } } };

/** One loop process over the world: its own state — a restart carries nothing but the persisted one — and its own reads. */
function loop(world: World, state: DaemonState, adopt: boolean, clock: number) {
  const reads = world.ports({ adopt });
  const effects = { mergeWriter: reads, persist: async () => {}, rework: async (work: Work) => { world.reworks.push(work); work.reworkRequested = true; } };
  return async () => { clock += 1000; await mergeWriterStep({ state, effects, now: () => clock, snapshot: { work: world.snapshot(), now: iso(clock) }, performed: [] } as unknown as Cycle); };
}

/** Waits until `what` holds, for the flight's own microtasks to reach it. */
const waitFor = async (what: () => boolean, ms = 5_000) => { for (let waited = 0; !what() && waited < ms; waited += 5) await new Promise(resolve => setTimeout(resolve, 5)); };

test('unit:trial-survives-loop-restart — a trial in progress when the loop restarts onto a new release is adopted by the next loop and reaches its own verdict: the passing head merges on its one trial, and the failing head is refused for its own failure — neither is settled as refused merely because the loop restarted', { timeout: 60_000 }, async () => {
  const world = new World(2);
  // Loop one: both heads' trials launch detached and are still running when the loop restarts.
  const first = emptyDaemonState(config);
  let clock = start;
  const stepOne = loop(world, first, false, clock);
  await stepOne();
  await waitFor(() => world.runs.size === 2);
  assert.deepEqual([...world.runs.keys()].sort(), ['GY-1', 'GY-2'], 'each head launched one detached trial run');
  assert.ok(first.mergeWriter.inFlights?.every(entry => entry.run), 'each in-flight entry carries its run, so the restart leaves it findable');

  // The loop restarts: a fresh process over the persisted state, its reads able to watch the runs the restart left.
  for (const run of world.runs.values()) run.die();
  const next = structuredClone(first);
  const stepTwo = loop(world, next, true, clock + 300_000);
  await stepTwo();
  assert.equal(next.mergeWriter.inFlight?.key, 'GY-1', 'the next loop adopted the trials into a flight of its own');
  assert.match(next.actions['merge-writer-trial-adoption']?.detail ?? '', /Adopted the merge trial\(s\) of GY-1, GY-2/, 'the adoption is the journal line the restart is read by');
  assert.equal(world.runs.size, 2, 'the adopted flight launched nothing: the trials the restart left answer their own runs');

  // The runs reach their verdicts while the new loop watches: GY-1 passes, GY-2 fails its own proof.
  world.runs.get('GY-1')!.finish(pass);
  world.runs.get('GY-2')!.finish(ownFailure);
  await mergeWriterIdle(next);
  await stepTwo();

  const one = world.recorded.get(1)!.map(event => event.kind).filter(kind => kind !== 'trial-step');
  assert.deepEqual(one, ['intent', 'intent', 'trial', 'pushed', 'reconciled'], 'the passing head lands on its adopted trial: the next loop re-intends the merge, runs no second trial, and delivers');
  assert.equal(one.filter(kind => kind === 'trial').length, 1, 'exactly one trial ran for the head across the restart');
  assert.equal(world.snapshot()[0]!.stage, 'done', 'GY-1 is delivered');

  const two = world.recorded.get(2)!.map(event => event.kind).filter(kind => kind !== 'trial-step');
  assert.ok(two.includes('trial') && two.includes('refused'), 'the failing head records its own trial and its own refusal');
  const refusal = world.recorded.get(2)!.find(event => event.kind === 'refused')!;
  assert.ok(refusal.kind === 'refused' && refusal.reason.startsWith(trialFailurePrefix) && /tests\/item\.test\.ts/.test(refusal.reason), 'the refusal names the trial\'s own failing test, not the restart');
  assert.ok(world.reworks.some(work => work.key === 'GY-2'), 'the failure grounds its rework as any trial failure does');
  for (const action of Object.values(next.actions)) assert.ok(!action.detail || !/Settled an open intent/.test(action.detail), 'no open intent of the adopted trials was settled as refused');

  // A later loop after another restart finds nothing left to adopt: every trial settled on its own.
  const third = structuredClone(next);
  const stepThree = loop(world, third, true, clock + 600_000);
  await stepThree();
  assert.equal(third.mergeWriter.inFlight, null, 'a settled world adopts nothing');
});

test('unit:trial-survives-loop-restart — a restart that leaves no watchable run (a hard kill recorded no verdict) still settles the open intent as refused unpushed and queues the head afresh', { timeout: 60_000 }, async () => {
  const world = new World(1);
  const first = emptyDaemonState(config);
  let clock = start;
  await loop(world, first, false, clock)();
  await waitFor(() => world.runs.has('GY-1'));
  assert.ok(world.runs.has('GY-1'));

  // The run died with the loop: nothing to adopt.
  for (const run of world.runs.values()) run.die();
  world.runs.delete('GY-1');
  const next = structuredClone(first);
  const stepTwo = loop(world, next, true, clock + 300_000);
  await stepTwo();
  await stepTwo();
  const refusal = world.recorded.get(1)!.find(event => event.kind === 'refused');
  assert.ok(refusal?.kind === 'refused' && /was never pushed/.test(refusal.reason), 'the open intent settles refused unpushed, the fallback a dead run takes');
  assert.ok(Object.values(next.actions).some(action => /Settled an open intent/.test(action.detail ?? '')), 'the settle is the journal line it always was');
});

test('unit:trial-survives-loop-restart — the merge commit of a head onto an unmoved tip is the same commit when the next loop computes it again later, so the adopted trial still names it and is not cancelled', async () => {
  const identity = { GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com', GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const root = await temporaryDirectory('trial-restart-repo', tmpdir());
  const run = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
  run('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.txt'), 'one\n'); writeFileSync(join(root, 'b.txt'), 'two\n');
  run('add', '-A'); run('commit', '-q', '-m', 'base');
  const start = run('rev-parse', 'HEAD');
  writeFileSync(join(root, 'a.txt'), 'head\n'); run('commit', '-q', '-am', 'head');
  const head = run('rev-parse', 'HEAD');
  run('checkout', '-q', '--detach', start);
  writeFileSync(join(root, 'b.txt'), 'main\n'); run('commit', '-q', '-am', 'main moved');
  const baseTip = run('rev-parse', 'HEAD');
  const git = async (args: string[], env: Record<string, string> = {}) => String(await defaultChildRun('git', ['-C', root, ...args], { env: { ...process.env, ...identity, ...env } }));
  const before = await trialMerge(git, { head, baseTip, subject: 'Merge GY-1: Head' });
  // The restart: the next loop recomputes the merge after the clock has moved past a second.
  await delay(1_100);
  const after = await trialMerge(git, { head, baseTip, subject: 'Merge GY-1: Head' });
  assert.ok('mergeSha' in before && 'mergeSha' in after);
  assert.notEqual(before.mergeSha, head, 'the head does not fast-forward the tip, so a merge commit is made');
  assert.equal(after.mergeSha, before.mergeSha);
});
