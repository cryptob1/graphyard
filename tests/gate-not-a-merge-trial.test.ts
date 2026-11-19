import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runCycle } from '../src/daemon/cycle.js';
import { mergeWriterSummary, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { batchGateFlights } from '../src/daemon/trial-slots.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import { masterConfigSchema } from '../src/master.js';
import { slotsDirectoryVariable } from '../src/master/verification-slots.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { Work } from '../src/model.js';

// GY-3531: a gate that cannot verify blocked every merge, and every fix to the gate is itself a
// merge. The gate's run is not a merge trial: trialCap counts the merge writer's own trials only.

const start = Date.parse('2030-04-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const tip = sha('main-tip');
// The host's heavy-job budget is this test's own, so the host's real load never holds a trial here.
const previous = process.env[slotsDirectoryVariable];
after(() => { if (previous === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = previous; });

async function world() {
  process.env[slotsDirectoryVariable] = await temporaryDirectory('gate-not-a-merge-trial-slots');
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [],
    run: { mergeWriter: { deployKeyFile: '/keys/deploy' }, trialCap: { value: 1, until: iso(start + 3_600_000) } } });
  const gates = ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: name !== 'merge', reasons: name !== 'merge' ? [] : ['merge refused'] }));
  const queued = (n: number) => {
    const candidate = { sha: sha(`head${n}`), baseSha: tip, pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' };
    return {
      id: `w${n}`, key: `GY-${n}`, title: `Queued merge ${n}`, description: '', type: 'feature', priority: 1, dependencies: [],
      criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }], policy: { checks: ['test'], review: true }, revision: 1, policyRevision: 1,
      createdAt: iso(start + n), updatedAt: iso(start), stageEnteredAt: iso(start - 60_000), ready: true, epoch: 1, lease: null, workspaces: [],
      submission: { epoch: 1, pr: n }, candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [], sessions: [], gates, stage: 'build',
      observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, baseTip: tip, baseTipContained: true, at: iso(start) },
    } as unknown as Work;
  };
  const work = [queued(1), queued(2)];
  const started: string[] = [];
  const reads = {
    baseBranch: 'main', now: () => start, cores: 8, parallel: 4, fetch: async () => tip,
    merge: async (head: string) => ({ mergeSha: sha(`merge:${head}`), files: ['src/app.ts'] }),
    // Each merge trial stays running, so the test sees what runs at once.
    trial: async (mergeSha: string) => { started.push(mergeSha); return new Promise<MergeTrialRun>(() => {}); },
    push: async () => 'pushed', holds: async () => false, record: async () => {},
  } as unknown as MergeWriterReads;
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: iso(start) }), agents: () => [], herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({}), closeSession: () => {}, dispatch: async () => null, dispatchTick: async () => {},
    mergeWriter: reads, persist: async () => {},
  } as unknown as DaemonEffects;
  const state = emptyDaemonState(config);
  // A gate run in flight beside the loop, as batchGateStep leaves it; it never settles here.
  batchGateFlights.set(state, { gate: new Promise<void>(() => {}), diagnostics: null });
  const cycle = async (at: number) => { await runCycle(config, state, effects, () => at); await new Promise(resolve => setTimeout(resolve, 50)); };
  return { state, started, cycle };
}

test('integration:gate-not-a-merge-trial — with trialCap 1 a running batch gate and one queued merge trial run at once; two queued merge trials still respect the cap of 1', async () => {
  const { state, started, cycle } = await world();
  await cycle(start);
  assert.equal(started.length, 1, 'the merge trial starts beside the running gate without waiting for it');
  await cycle(start + 60_000);
  assert.equal(started.length, 1, 'the second queued merge waits: trialCap 1 counts the merge writer\'s own trials');
  assert.equal(state.mergeWriter.inFlights?.length ?? (state.mergeWriter.inFlight ? 1 : 0), 1);
});

test('e2e:gate-not-a-merge-trial — with a gate in flight and a merge queued, master status shows the merge in flight beside the gate', async () => {
  const { state, cycle } = await world();
  await cycle(start);
  assert.ok(batchGateFlights.get(state)?.gate, 'the gate is still in flight');
  const summary = mergeWriterSummary(state.mergeWriter, start);
  assert.equal(summary.inFlight?.key, 'GY-1', 'master status shows the merge in flight beside the gate');
  assert.ok(summary.queue.some(entry => entry.key === 'GY-2'), 'the second merge stays queued under trialCap 1');
  assert.equal(summary.inFlights?.length ?? 1, 1, 'one merge in flight under trialCap 1');
});
