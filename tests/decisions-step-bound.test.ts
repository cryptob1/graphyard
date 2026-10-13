import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { approvalWatchSchema, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { RefusedResponse } from '../src/model/refusal.js';
import type { Observation, Work } from '../src/model.js';

/** GY-1766: the decisions step never holds the loop cycle for one owed decision's approver call. */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2026-10-07T03:53:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const sha = 'c'.repeat(40), base = 'b'.repeat(40);
const config = (): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });

/** An item whose reviewer requested changes on its candidate, so the loop requests a rework; `quiet` has nothing to decide. */
function item(key: string, quiet = false): Work {
  const candidate = { sha, baseSha: base, pr: 42, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' };
  const observation = {
    clockOffset: { min: 0, max: 0 }, candidate, checks: [{ name: 'test', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'independent-reviewer', sha, state: 'CHANGES_REQUESTED' }],
    protected: true, mergeable: true, merged: false, mergeSha: null, files: ['src/loop.ts'], scopeFiles: [], at: iso(-20_000),
  } as Observation;
  return {
    id: `00000000-0000-4000-8000-${key.replace(/\D/g, '').padStart(12, '0')}`, key, title: key, description: '', type: 'bug', priority: 2,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:loop'] }], policy: { checks: ['test'], review: true },
    plannedFiles: ['src/loop.ts'], stage: quiet ? 'build' : 'review', revision: 5, policyRevision: 1, createdAt: iso(-3_600_000), updatedAt: iso(0),
    stageEnteredAt: iso(-1_800_000), ready: true, epoch: 1, lease: null, workspaces: [], submission: quiet ? null : { epoch: 1, pr: 42 },
    candidate: quiet ? null : candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: quiet ? null : observation, blocker: null, violations: [],
    gates: [{ name: 'build', passed: !quiet, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }],
  } as unknown as Work;
}

function effects(work: Work, overrides: Partial<DaemonEffects>): DaemonEffects {
  return {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [work], now: iso(0), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async () => ({ id: 'unused' }), decisions: async () => ({ decisions: [] }),
    approver: async () => ({ agentName: 'graphyard-approver', pane: 'pane-1' }), persist: async () => {},
    ...overrides,
  };
}
const decisionFaults = (state: ReturnType<typeof emptyDaemonState>) => state.faults.instances.filter(instance => instance.faultClass === 'decision');

test('unit:decisions-step-bounded-per-decision — a decide call that does not answer returns the step, leaves the decision owed and is no fault', async () => {
  const work = item('GY-1766'), sent: string[] = [];
  const state = emptyDaemonState(config());
  const started = performance.now();
  const result = await runCycle(config(), state, effects(work, { decide: async (_target, action) => { sent.push(action); return new Promise(() => {}); }, decisionCallBoundMs: 30 }), () => clock);
  assert.ok(performance.now() - started < 5_000, 'the step returned instead of waiting on the call');
  assert.deepEqual(sent, ['rework']);
  const recorded = result.actions.filter(action => action.kind === 'decision' && action.work === 'GY-1766');
  assert.ok(recorded.some(action => action.state === 'done' && /30 ms per-decision bound passed/.test(action.detail) && /stays owed and is retried next cycle/.test(action.detail)), JSON.stringify(recorded));
  assert.ok(!recorded.some(action => action.state === 'failed'), 'a carried decision is not a failure');
  assert.deepEqual(decisionFaults(state), []);
  assert.deepEqual(Object.values(state.approvals), [], 'no watch exists until a decision stands');
});

test('unit:decisions-step-applies-once — a retry joins the call still in flight, and an answer within the bound is applied as before', async () => {
  const work = item('GY-1766'), sent: string[] = [];
  let answer!: (value: { id: string }) => void;
  const slow = new Promise<{ id: string }>(resolve => { answer = resolve; });
  const fx = effects(work, { decide: async (_target, action) => { sent.push(action); return slow; }, decisionCallBoundMs: 20 });
  const state = emptyDaemonState(config());
  await runCycle(config(), state, fx, () => clock);
  await runCycle(config(), state, fx, () => clock + 60_000);
  assert.deepEqual(sent, ['rework'], 'the retry did not send a second request while the first was unanswered');
  answer({ id: 'decision-1' });
  await slow;

  const quick = emptyDaemonState(config()), asked: string[] = [];
  await runCycle(config(), quick, effects(work, { decide: async (_target, action) => { asked.push(action); return { id: 'decision-2' }; }, decisionCallBoundMs: 5_000 }), () => clock);
  assert.deepEqual(asked, ['rework']);
  assert.deepEqual(Object.values(quick.approvals).map(watch => watch.decision), ['decision-2'], 'an answer inside the bound opens its watch exactly as before');
});
