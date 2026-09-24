import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { GitHub } from '../src/github.js';
import { emptyDaemonState, githubPause, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Observation, Work } from '../src/model.js';

/**
 * GY-144: on 2026-09-23, while the GitHub App was paused after a rate limit, the loop requested
 * rework for five items from observations that no longer described them — each worker had already
 * pushed and submitted a green head the paused control plane had not observed. Rework is now
 * asked for only on a fresh observation, and a request names the observation it was decided from.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const minute = 60_000;
const reviewed = 'a'.repeat(40), moved = 'c'.repeat(40), base = 'b'.repeat(40);

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [] });
}

/** A submitted item whose last observation carries a changes-requested review on the head it saw. */
function verdictItem(observedAt: string): Work {
  const observation: Observation = {
    clockOffset: { min: 0, max: 0 }, candidate: { sha: reviewed, baseSha: base, pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'independent-reviewer', sha: reviewed, state: 'CHANGES_REQUESTED' }],
    protected: true, mergeable: true, merged: false, mergeSha: null, files: ['src/loop.ts'], scopeFiles: [], at: observedAt,
  } as Observation;
  return {
    id: 'work-42', key: 'GY-42', title: 'Rework only from what is current', description: '', type: 'bug', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:loop'] }], policy: { checks: ['test'], review: true },
    plannedFiles: ['src/loop.ts'], stage: 'review', revision: 5, policyRevision: 1, createdAt: iso(-4 * 60 * minute), updatedAt: iso(0),
    stageEnteredAt: iso(-30 * minute), ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: 42 },
    candidate: { sha: reviewed, baseSha: base, pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation, blocker: null, violations: [],
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }],
  } as Work;
}

function effects(snapshot: Awaited<ReturnType<DaemonEffects['snapshot']>>, decided: { action: string; reason: string }[]): DaemonEffects {
  return {
    agents: () => [], herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({}),
    snapshot: async () => snapshot,
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: snapshot.now, reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async (_work, action, reason) => { decided.push({ action, reason }); return { id: '5d8a8b9e-0000-4000-8000-000000000001' }; },
    decisions: async () => ({ decisions: [] }),
    approver: async () => ({ agentName: 'graphyard-approver-gy-42', pane: 'pane-1' }),
    persist: async () => {},
  };
}

test('unit:no-rework-from-stale-observation — while GitHub is paused and the observation is stale, the loop requests no rework and names the stale observation as why it waits', async () => {
  // The real GitHub client, paused the way a rate limit pauses it: every request is refused with
  // the pause, and that refusal is what the control plane's observation job keeps as its error.
  const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used-while-paused' });
  (github as unknown as { blockedUntil: number }).blockedUntil = Date.now() + 10 * minute;
  const refusal = await github.request('/pulls/42').then(() => assert.fail('a paused client must refuse'), (error: Error) => error.message);
  assert.match(refusal, /GitHub requests paused until/);
  const pausedUntil = /paused until (\S+)/.exec(refusal)![1];

  // The observation is five minutes old and names the reviewed head; the branch has since moved
  // to a new green head the paused control plane never saw. The loop reads the snapshot at a
  // clock inside the pause, so the observation job's refusal still stands.
  const at = Date.parse(pausedUntil) - 5 * minute;
  const item = verdictItem(new Date(at - 5 * minute).toISOString());
  const snapshot = { work: [item], now: new Date(at).toISOString(), jobs: [{ work_id: item.id, error: refusal }] };
  assert.deepEqual(githubPause(snapshot.jobs, at), { until: new Date(Date.parse(pausedUntil)).toISOString() });
  const decided: { action: string; reason: string }[] = [];
  const state = emptyDaemonState(config());
  const result = await runCycle(config(), state, effects(snapshot, decided), () => at);

  assert.deepEqual(decided, [], 'no rework decision is requested from a stale observation during a pause');
  assert.equal(Object.keys(state.approvals).length, 0, 'no approver is put to work on it');
  const waiting = result.actions.find(action => action.work === item.key && action.kind === 'decision');
  assert.ok(waiting, 'the item carries a line saying why its rework waits');
  assert.equal(waiting.state, 'done');
  assert.match(waiting.detail, /rework waits for a fresh GitHub observation/);
  assert.match(waiting.detail, /stale observation/);
  assert.match(waiting.detail, new RegExp(`paused until ${pausedUntil.replace(/[.]/g, '\\.')}`));
  assert.ok(waiting.detail.includes(item.observation!.at) && waiting.detail.includes(reviewed.slice(0, 12)), 'it names the observation: its time and the head it saw');
  assert.ok(!waiting.detail.includes(moved.slice(0, 12)));

  // Unpaused, an observation older than two minutes is still no ground for rework.
  const later = at + 30 * minute;
  const stale = verdictItem(new Date(later - 3 * minute).toISOString());
  const unpaused = await runCycle(config(), state, effects({ work: [stale], now: new Date(later).toISOString(), jobs: [{ work_id: stale.id, error: refusal }] }, decided), () => later);
  assert.deepEqual(decided, [], 'no rework from an observation past the two-minute bound');
  assert.match(unpaused.actions.find(action => action.work === stale.key)!.detail, /stale observation, older than two minutes/);

  // A fresh observation of the moved head carries no verdict against it: nothing is requested at all.
  const fresh = verdictItem(new Date(later - 20_000).toISOString());
  fresh.candidate = { ...fresh.candidate!, sha: moved };
  fresh.observation = { ...fresh.observation!, candidate: { ...fresh.observation!.candidate, sha: moved }, reviews: [] };
  await runCycle(config(), state, effects({ work: [fresh], now: new Date(later).toISOString(), jobs: [] }, decided), () => later);
  assert.deepEqual(decided, [], 'the fresh observation shows the head moved past the verdict');
});

test('unit:rework-records-its-observation — a rework request carries the time and candidate SHA of the observation it was decided from', async () => {
  const observedAt = iso(-30_000);
  const item = verdictItem(observedAt);
  const decided: { action: string; reason: string }[] = [];
  const state = emptyDaemonState(config());
  const result = await runCycle(config(), state, effects({ work: [item], now: iso(0), jobs: [] }, decided), () => clock);

  assert.equal(decided.length, 1, 'a fresh observation of a standing verdict is decided on');
  assert.equal(decided[0].action, 'rework');
  assert.ok(decided[0].reason.includes(observedAt), `the decision carries the observation time: ${decided[0].reason}`);
  assert.ok(decided[0].reason.includes(reviewed), `the decision carries the observed candidate SHA: ${decided[0].reason}`);
  assert.match(decided[0].reason, /Decided from the GitHub observation taken at/);
  // The watch is keyed by the head and the verdict it answers.
  const watch = Object.entries(state.approvals).find(([key]) => key.includes(`:${reviewed}:verdict:`))![1];
  assert.deepEqual(watch.observation, { at: observedAt, sha: reviewed }, 'the loop keeps the same pair with the request');
  assert.ok(result.actions.some(action => action.kind === 'decision' && action.detail.includes(observedAt) && action.detail.includes(reviewed)));
});

test('unit:rework-answers-earlier-refusal — a rework on new grounds cites each refused rework of the item, which the server otherwise refuses as a repeat', async () => {
  const observedAt = iso(-30_000), item = verdictItem(observedAt), decided: { action: string; reason: string }[] = [];
  const refused = '6ee09885-03ee-419b-9e67-a05e42e03afb';
  const withHistory: DaemonEffects = { ...effects({ work: [item], now: iso(0), jobs: [] }, decided),
    decisions: async () => ({ decisions: [{ id: refused, action: 'rework', state: 'refused', input: { previousWorkerStopped: true }, approvedBy: null, refusal: { approver: 'graphyard-approver-graphyard', reason: 'Premature' } }] }) };
  await runCycle(config(), emptyDaemonState(config()), withHistory, () => clock);
  assert.equal(decided.length, 1, 'the verdict is decided on despite the earlier refusal');
  assert.ok(decided[0].reason.includes(refused), `the request cites the refused decision: ${decided[0].reason}`);
  assert.match(decided[0].reason, /different grounds/);
});
