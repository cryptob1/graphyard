import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { emptyDaemonState } from '../src/daemon/state.js';
import { mergeWriterStep, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { trialRunFiles, type TrialRunHandle } from '../src/merge-writer/trial-run.js';
import { mergeRecordKinds, type MergePorts, type MergeRecordEvent, type MergeTrialRun } from '../src/merge-writer/executor.js';
import { foldMergeLedger } from '../src/model-boundary/merge-ledger.js';
import { masterConfigSchema } from '../src/master.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { DaemonState } from '../src/daemon/state.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3564: a merge trial whose run has finished — its result file written — but whose completion
// never reached the loop (the watcher's promise stays pending) is collected from its files within
// one cycle: the head settles on the recorded verdict and its lane takes the next candidate, with
// no loop restart. A trial still running beside it is left alone.

const start = Date.parse('2030-09-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const base = sha('base');
const pass: MergeTrialRun = { build: 'pass', tests: { passed: 3, failed: [], files: 3 }, durationMs: 1000, logTail: '', files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } };

class World {
  main = [base];
  launched: string[] = [];
  directories = new Map<string, string>();
  stopped: string[] = [];
  recorded = new Map<number, MergeRecordEvent[]>();
  ledgerEvents: { kind: string; payload: unknown; work: string }[] = [];
  /** How many items workers have handed in so far. */
  submitted = 1;
  constructor(readonly count: number, readonly root: string) {}
  head(n: number) { return sha(`head${n}`); }
  snapshot(): Work[] {
    const folded = foldMergeLedger(this.ledgerEvents as never);
    return Array.from({ length: this.submitted }, (_, index) => index + 1).map(n => {
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
  reads(): MergeWriterReads {
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
    return {
      ...ports,
      parallel: 2,
      // Each run's directory is real, but its completion is lost: the watcher's promise never settles.
      launchTrialRun: (spec): TrialRunHandle => {
        const directory = join(world.root, spec.key);
        mkdirSync(directory, { recursive: true });
        world.launched.push(spec.key); world.directories.set(spec.key, directory);
        return { directory, mergeSha: spec.mergeSha, trial: () => new Promise<MergeTrialRun>(() => {}), detach: () => {}, cancel: () => { world.stopped.push(spec.key); } };
      },
      stopTrialRun: ref => { world.stopped.push(ref.directory); },
    };
  }
}

function loop(world: World, state: DaemonState) {
  const reads = world.reads();
  let clock = start;
  const effects = { mergeWriter: reads, persist: async () => {}, rework: async (work: Work) => { work.reworkRequested = true; } };
  return async () => { clock += 30_000; await mergeWriterStep({ state, effects, now: () => clock, snapshot: { work: world.snapshot(), now: iso(clock) }, performed: [] } as unknown as Cycle); };
}

const waitFor = async (what: () => boolean, ms = 5_000) => { for (let waited = 0; !what() && waited < ms; waited += 5) await new Promise(resolve => setTimeout(resolve, 5)); };
const kinds = (world: World, n: number) => (world.recorded.get(n) ?? []).map(event => event.kind).filter(kind => kind !== 'trial-step');

test('integration:collect-finished-trial — a trial whose completion is lost but whose result file exists is settled from its files without a loop restart, its lane takes the next candidate, and a trial still running is untouched', { timeout: 60_000 }, async () => {
  const world = new World(3, await temporaryDirectory('collect-finished-trial', tmpdir()));
  const state = emptyDaemonState(config);
  const step = loop(world, state);
  // GY-1 is handed in and its trial starts; GY-2 follows in a flight of its own, then GY-3 waits for a lane.
  await step();
  await waitFor(() => world.launched.length === 1);
  world.submitted = 2;
  await step();
  await waitFor(() => world.launched.length === 2);
  assert.deepEqual(world.launched, ['GY-1', 'GY-2'], 'both lanes launched a trial');
  world.submitted = 3;

  // Cycles pass with neither run finished: both stay in flight, nothing is collected, and GY-3 waits.
  await step();
  await step();
  assert.deepEqual(world.launched, ['GY-1', 'GY-2'], 'GY-3 waits for a free lane');
  assert.deepEqual(state.mergeWriter.inFlights?.map(entry => entry.key), ['GY-1', 'GY-2'], 'running trials stay in flight');
  assert.deepEqual(kinds(world, 1), ['intent']);

  // GY-1's run finishes and writes its exit and result files; the completion never reaches the loop.
  const one = world.directories.get('GY-1')!;
  writeFileSync(trialRunFiles(one).result, `${JSON.stringify({ ok: true, run: pass })}\n`);
  writeFileSync(join(one, 'exit'), '0\n');

  // One cycle collects it from its files and the flight lands; the next records it, drops it from flight and fills its lane.
  await step();
  await waitFor(() => kinds(world, 1).includes('reconciled'), 2_000);
  await step();
  assert.deepEqual(kinds(world, 1), ['intent', 'trial', 'pushed', 'reconciled'], 'GY-1 merged on the verdict its result file recorded');
  assert.equal(world.snapshot()[0]!.stage, 'done', 'GY-1 is delivered');
  await waitFor(() => world.launched.length === 3, 2_000);
  assert.deepEqual(world.launched, ['GY-1', 'GY-2', 'GY-3'], 'the freed lane took the next candidate');
  assert.deepEqual(state.mergeWriter.inFlights?.map(entry => entry.key), ['GY-2', 'GY-3'], 'master status no longer shows the finished trial in flight: only the trials still running');
  assert.deepEqual(kinds(world, 2), ['intent'], 'the still-running trial of GY-2 is untouched');
  assert.deepEqual(world.stopped, [], 'no running trial was stopped');
});
