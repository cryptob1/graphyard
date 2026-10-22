import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cycleSteps, emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { mergeWriterIdle, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { MergePorts, MergeRecordEvent } from '../src/merge-writer/executor.js';
import { masterConfigSchema, type WorkerProfile } from '../src/master.js';
import type { Work } from '../src/model.js';

// GY-2877: the loop's cycle is snapshot, close, dispatch, merge writer, persist and nothing else.

const start = Date.parse('2030-04-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const tip = sha('main-tip');
const worker = { name: 'w1', principal: 'w1-principal', agentName: 'agent-w1', mode: 'launch', kind: 'claude', credentialFile: '/outside/w1.token', agentArgs: [], environment: {} } as unknown as WorkerProfile;
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [worker], run: { mergeWriter: { deployKeyFile: '/keys/deploy', retrials: 3 } } });
const gates = (passed: string[]) => ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: passed.includes(name), reasons: passed.includes(name) ? [] : [`${name} refused`] }));
const item = (fields: Record<string, unknown>) => ({
  description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
  policy: { checks: ['test'], review: true }, revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(start - 60_000),
  ready: true, epoch: 0, lease: null, workspaces: [], submission: null, candidate: null, reworkRequested: false, scenarioRequirements: [], evidence: [],
  observation: null, blocker: null, violations: [], sessions: [], gates: gates(['ready']), stage: 'ready', ...fields,
}) as unknown as Work;

/** A store holding a claimable item, a submitted head and a running session whose item is Done. */
function store() {
  const candidate = { sha: sha('head2'), baseSha: tip, pr: 2, branch: 'graphyard/gy-2-1', author: 'worker' };
  return [
    item({ id: 'w1', key: 'GY-1', title: 'Claimable' }),
    item({ id: 'w2', key: 'GY-2', title: 'Submitted', stage: 'build', epoch: 1, submission: { epoch: 1, pr: 2 }, candidate, gates: gates(['ready', 'build', 'review', 'test']),
      observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, baseTip: tip, baseTipContained: true, at: iso(start) } }),
    item({ id: 'w3', key: 'GY-3', title: 'Delivered', stage: 'done', epoch: 1,
      sessions: [{ id: 'w1-principal:1', kind: 'implementation', principal: 'w1-principal', epoch: 1, runtime: 'claude', host: 'machine-a', workspace: null, tab: null, pane: 'p3', agentName: 'agent-w1', role: null, head: null, attach: null, transcript: null, subject: 'GY-3: Delivered', startedAt: iso(start), updatedAt: iso(start), endedAt: null, state: 'running', outcome: null }] }),
  ];
}

function mergePorts() {
  const events: { key: string; kind: string }[] = [];
  const ports: MergePorts = {
    baseBranch: 'main', retrials: 3, now: () => start,
    fetch: async () => tip,
    merge: async head => ({ mergeSha: sha(`merge:${head}`), files: ['src/app.ts'] }),
    trial: async () => ({ build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 10, logTail: '', files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } }),
    push: async () => 'pushed',
    holds: async () => false,
    record: async (target: Pick<Work, 'key'>, event: MergeRecordEvent) => { events.push({ key: target.key, kind: event.kind }); },
  };
  return { reads: { ...ports, merger: async () => 'control-plane' as const } as MergeWriterReads, events };
}

test('unit:five-step-cycle — one cycle records exactly snapshot, close, dispatch, merge writer and persist in that order: the claimable item is dispatched, the submitted head trialled and merged, the Done item\'s session closed, the cursor persisted, and no other step, carry, wake or reading is recorded', async () => {
  const work = store(), merge = mergePorts();
  const dispatched: string[] = [], closed: string[] = [], recorded: { key: string; id: string; state: string | undefined }[] = [];
  let persisted: DaemonState | null = null;
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: iso(start) }),
    agents: () => [], herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({ w1: { available: true, reason: null } }),
    closeSession: pane => { closed.push(pane); },
    recordSession: async (target, handle) => { recorded.push({ key: target.key, id: handle.id, state: handle.state }); },
    dispatch: async (target, profile) => { dispatched.push(`${target.key}:${profile.name}`); return { pane: 'p1', epoch: 1 }; },
    mergeWriter: merge.reads,
    persist: async state => { persisted = structuredClone(state); },
  };
  const state = emptyDaemonState(config);
  const result = await runCycle(config, state, effects, () => start);
  await mergeWriterIdle(state);

  assert.deepEqual(result.metrics.steps, ['snapshot', 'close', 'dispatch', 'merge writer', 'persist']);
  assert.deepEqual(result.metrics.steps, [...cycleSteps]);
  assert.deepEqual(state.metrics.at(-1)?.steps, [...cycleSteps], 'the cycle record names the five steps in order');
  assert.deepEqual(dispatched, ['GY-1:w1'], 'the claimable item is dispatched to the free worker profile');
  assert.deepEqual(merge.events.filter(event => event.key === 'GY-2').map(event => event.kind), ['intent', 'trial', 'pushed', 'reconciled'], 'the submitted head is trialled and merged');
  assert.deepEqual(closed, ['p3'], 'the session whose item is Done is closed');
  assert.deepEqual(recorded.filter(entry => entry.key === 'GY-3'), [{ key: 'GY-3', id: 'w1-principal:1', state: 'finished' }]);
  const cursor = persisted as DaemonState | null;
  assert.ok(cursor, 'the cursor is persisted');
  assert.equal(cursor.cycle, 1);
  assert.deepEqual(cursor.metrics.at(-1)?.steps, [...cycleSteps]);
  assert.deepEqual(Object.values(state.actions).map(action => action.kind).sort(), ['close', 'dispatch'], 'nothing but the close and the dispatch is recorded as an action');
  assert.ok(!Object.keys(state.actions).some(key => /^(wake|capacity|deployment|reading|carried|attention|invariant|upgrade)/.test(key)), Object.keys(state.actions).join(', '));
  assert.ok(!('deployment' in state) && !('upgrade' in state) && !('invariants' in state), 'the cursor carries no deployment, upgrade or invariant state');
});
