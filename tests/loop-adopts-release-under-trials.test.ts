import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle, type Cycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { mergeWriterIdle, mergeWriterStep, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { releaseAdoptionBoundMs, runDaemon } from '../src/daemon/run.js';
import type { MergeRecordEvent } from '../src/merge-writer/executor.js';
import { masterConfigSchema } from '../src/master.js';
import type { MergeLedgerState } from '../src/model/merge-ledger.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3148: the deploy unit serves a new release while the merge writer's concurrent per-head
// trials keep it never idle. The loop still restarts onto the served release within a bound —
// cancelling its trials at a boundary, refusing no head — and the next loop adopts those trials
// from the recorded ledger state: open intents are refused unpushed and the heads trialled afresh.
// In-flight entries a restart left for items that got a new head or no longer await a merge are
// dropped instead of aging into a stall nothing clears.

const start = Date.parse('2030-07-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const githubDouble = new Proxy({}, { get: (_, name) => { throw new Error(`the merge writer step called GitHub (${String(name)})`); } });
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy' } } });

/** main's first-parent chain, what the writer recorded, every trial, and per-item snapshot overrides. */
class World {
  main = [sha('base')];
  pushes: string[] = [];
  heads = new Map<string, number>();
  recorded = new Map<number, MergeRecordEvent[]>();
  trials: { n: number; head: string }[] = [];
  /** While true (the loop has not restarted) a trial never settles on its own. */
  held = true;
  overrides: Record<number, Record<string, unknown>> = {};
  constructor(readonly count: number, readonly parallel = 2) {}
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
        ...this.overrides[n],
      } as unknown as Work;
    });
  }
  ports(extra: Partial<MergeWriterReads> = {}): MergeWriterReads {
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
      // While the world holds its trials, each stays in flight forever: only a cancel settles one.
      trial: async (mergeSha, _files, _item, _baseTip, _onStep, _onTiming, _heads, _share, _signal) => {
        const n = world.heads.get(mergeSha)!;
        world.trials.push({ n, head: world.head(n) });
        if (world.held) await new Promise(() => {});
        return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } };
      },
      push: async (mergeSha, baseTip) => {
        if (baseTip !== world.main[0]) return 'rejected';
        world.main.unshift(mergeSha);
        world.pushes.push(mergeSha);
        return 'pushed';
      },
      holds: async commit => world.main.includes(commit),
      record: async (item, event) => { const n = Number(item.key.slice(3)); world.recorded.set(n, [...(world.recorded.get(n) ?? []), event]); },
      ...extra,
    };
  }
}

const harness = (world: World, loadedRelease?: { commit: string; dirty: boolean | null }) => {
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: world.snapshot(), now: iso(start) }), closeSession: () => {}, dispatch: async () => {},
    decisions: async () => ({ decisions: [] }), persist: async () => {}, github: githubDouble, merge: githubDouble, mergeWriter: world.ports(),
    ...(loadedRelease ? { loadedRelease } : {}) } as unknown as DaemonEffects;
  return { state: emptyDaemonState(config), effects };
};
const kinds = (world: World, n: number) => (world.recorded.get(n) ?? []).map(event => event.kind);

test('unit:loop-adopts-release-under-trials — the deploy unit serves a release the loop did not load, and the loop restarts onto it within the bound while its concurrent trials run, cancelling them without refusing a head; the next loop adopts the trials from the ledger and drops the entries whose items moved on', { timeout: 60_000 }, async () => {
  assert.equal(releaseAdoptionBoundMs, 5 * 60_000, 'the bound the acceptance criterion names');

  // The loop's checkout: a git repository whose HEAD is the commit the deploy unit serves.
  const root = await temporaryDirectory('loop-adopts-release');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  await writeFile(join(root, 'file'), 'served\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'served']);
  const served = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const loaded = sha('the-release-this-loop-loaded');
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(join(root, '.graphyard', 'deploy.json'), JSON.stringify({ tip: served, failed: null, reason: null, at: new Date().toISOString() }));
  const loopConfig = { ...config, cliPath: join(root, 'bin/graphyard.mjs') };

  // Two queued heads trial at once and never settle: the merge writer is never idle.
  const world = new World(2);
  const { state, effects } = harness(world, { commit: loaded, dirty: false });
  let clock = start;
  const restarts: number[] = [], logs: string[] = [], host = new EventEmitter() as unknown as NodeJS.Process;
  await runDaemon(loopConfig, state, effects, { intervalMs: 20_000, identity: { pid: process.pid, host: 'machine-a' }, signals: ['SIGUSR2'], process: host,
    now: () => clock, log: line => logs.push(line), root, deployUnit: () => null,
    delay: async () => { clock += 60_000; },
    restartLoop: async () => { restarts.push(clock); host.emit('SIGUSR2'); } });
  assert.deepEqual(restarts, [start + releaseAdoptionBoundMs], 'the loop restarts at the bound, not before, and once');
  assert.ok(logs.some(line => line.includes('restarting through the supervisor unit') && line.includes('checkpointing the merge trial(s) of GY-1, GY-2')), 'the restart names the trials it checkpointed');
  assert.deepEqual(world.trials.map(entry => entry.n), [1, 2], 'each head ran one trial, cancelled rather than refused');
  for (const n of [1, 2]) {
    assert.deepEqual(kinds(world, n), ['intent', 'trial'], `GY-${n}'s cancelled trial recorded no verdict and refused nothing`);
    assert.equal(world.ledger(n)!.state, 'intent', `GY-${n}'s head is not refused: it stays queued for the next loop`);
  }

  // The next loop: a fresh process reading the persisted state, its trials now free to settle. The
  // first cycle settles the open intents the cancelled trials left; the next one reads the settled
  // ledger and restarts both heads' trials afresh.
  world.held = false;
  const next = structuredClone(state);
  await runCycle(loopConfig, next, effects, () => start + 360_000);
  await runCycle(loopConfig, next, effects, () => start + 380_000);
  await mergeWriterIdle(next);
  assert.deepEqual(world.trials.slice(2).map(entry => entry.n).sort(), [1, 2], 'the next loop restarts both trials on the same heads');
  for (const n of [1, 2]) {
    const sequence = kinds(world, n);
    assert.deepEqual(sequence.slice(0, 3), ['intent', 'trial', 'refused'], `GY-${n}'s open intent is refused unpushed before anything new starts`);
    const refusal = world.recorded.get(n)!.find(event => event.kind === 'refused')!;
    assert.ok(refusal.kind === 'refused' && /was never pushed/.test(refusal.reason), 'the adoption refuses the unpushed intent');
    assert.equal(sequence.filter(kind => kind === 'trial').length, 2, `GY-${n} is trialled once afresh, never twice for one adoption`);
    assert.deepEqual(sequence.slice(-2), ['pushed', 'reconciled'], `GY-${n}'s fresh trial passes and the head lands`);
  }
  assert.equal(world.pushes.length, 2, 'both heads land once their fresh trials pass');

  // In-flight entries a restart left whose items got a new head or no longer await a merge are dropped.
  const stale = new World(4);
  stale.overrides[2] = { reworkRequested: true };
  stale.overrides[3] = { candidate: { sha: sha('head3-new'), baseSha: sha('base'), pr: 3, branch: 'graphyard/gy-3-1', author: 'worker' } };
  stale.overrides[4] = { stage: 'done' };
  const { state: adopted, effects: adoptEffects } = harness(stale);
  adopted.mergeWriter.inFlight = { key: 'GY-1', id: 'w1', head: stale.head(1), startedAt: iso(start - 24 * 60_000), step: 'build', stepStartedAt: iso(start - 24 * 60_000) };
  adopted.mergeWriter.inFlights = [1, 2, 3, 4].map(n => ({ key: `GY-${n}`, id: `w${n}`, head: stale.head(n), startedAt: iso(start - 24 * 60_000), step: 'build', stepStartedAt: iso(start - 24 * 60_000) }));
  const performed: never[] = [];
  await mergeWriterStep({ state: adopted, effects: { ...adoptEffects, mergeWriter: stale.ports({ admit: () => false }) }, now: () => start, snapshot: { work: stale.snapshot(), now: iso(start) }, performed } as unknown as Cycle);
  assert.deepEqual(adopted.mergeWriter.inFlights?.map(entry => entry.key), ['GY-1'], 'only the head that still awaits its merge keeps its entry');
  assert.equal(adopted.mergeWriter.inFlight?.key, 'GY-1');
  const dropped = adopted.actions['merge-writer-inflight-adopted'];
  assert.equal(dropped?.state, 'done');
  assert.match(dropped?.detail ?? '', /GY-2 head [0-9a-f]+: .* returned for rework/, 'the drop names the reworked item and why');
  assert.match(dropped?.detail ?? '', /GY-3 head [0-9a-f]+: .* was replaced by/, 'the drop names the replaced head');
  assert.match(dropped?.detail ?? '', /GY-4 head [0-9a-f]+: GY-4 no longer awaits a merge/, 'the drop names the delivered item');
});
