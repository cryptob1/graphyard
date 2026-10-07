import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { approvalWatchSchema, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { RefusedResponse } from '../src/model/refusal.js';
import type { Observation, Work } from '../src/model.js';

/**
 * GY-1405 names this file for its proof: manual:fault-class-decision. The master loop filed 3
 * decision faults in 24 hours on 7 October 2026, each a refusal or a late read that judged nothing:
 *
 * - action:decision|GY-1387|2026-10-07T03:53:09.500Z — the rework request was refused 409
 *   "Delivered work is immutable; create a follow-up task": the item was delivered after the
 *   cycle's snapshot, so it needed no decision (GY-1336 already treats that refusal as moot).
 * - action:decision|GY-1393|2026-10-07T03:58:56.625Z and action:decision|GY-1394|…03:58:57.249Z —
 *   withdrawing a requirements decision the item no longer needed failed only because the
 *   decisions step's read deadline passed before its history answered; it is read again next
 *   cycle. The request path already treats one such late read as no fault (GY-1293).
 *
 * Each instance is replayed through the loop's own cycle. Against the base each records a decision
 * fault; against the candidate none, while a second late read in a row, or any other refusal, still
 * counts.
 */

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

test('manual:fault-class-decision — action:decision|GY-1387|2026-10-07T03:53:09.500Z: a decision refused because the item was delivered meanwhile is no fault', async () => {
  const work = item('GY-1387'), sent: string[] = [];
  const delivered = (id: string) => new RefusedResponse(`Graphyard refused work/${id}/decide (409): Delivered work is immutable; create a follow-up task`, 409, { error: 'Delivered work is immutable; create a follow-up task' });
  const state = emptyDaemonState(config());
  const result = await runCycle(config(), state, effects(work, { decide: async (target, action) => { sent.push(action); throw delivered(target.id); } }), () => clock);
  const recorded = result.actions.filter(action => action.kind === 'decision' && action.work === 'GY-1387');
  assert.deepEqual(sent, ['rework'], 'the loop asked for the rework the instance names');
  assert.deepEqual(decisionFaults(state), [], 'the refusal judged nothing: GY-1387 needed no decision');
  assert.ok(recorded.some(action => /Delivered work is immutable/.test(action.detail) && /was delivered after this cycle's snapshot/.test(action.detail)), JSON.stringify(recorded));

  // Any other refusal of the request still counts as a decision fault.
  const other = emptyDaemonState(config());
  await runCycle(config(), other, effects(work, { decide: async target => { throw new RefusedResponse(`Graphyard refused work/${target.id}/decide (409): Task revision is locked`, 409, { error: 'locked' }); } }), () => clock);
  assert.equal(decisionFaults(other).length, 1, 'a refusal on an item still open is a fault');
});

for (const [key, decision] of [['GY-1393', '5ade1f74-7c8e-4d81-a9fb-878f9974ed81'], ['GY-1394', '058d1dac-87c7-4352-bc8c-ddd7d4e5c844']] as const) {
  test(`manual:fault-class-decision — action:decision|${key}: a withdrawal whose history read only missed the step's deadline is no fault; the second in a row is`, async () => {
    const work = item(key, true), withdrawn: string[] = [];
    // The control plane is slow: the history read never answers inside the step's deadline.
    const fx = effects(work, { decisions: () => new Promise(() => {}), withdraw: async (_target, id) => { withdrawn.push(id); }, decisionReadDeadlineMs: 20 });
    const state = emptyDaemonState(config());
    state.approvals[`requirements:${work.id}:scope`] = approvalWatchSchema.parse({ work: key, action: 'requirements', decision, requestedAt: iso(-600_000) });
    const result = await runCycle(config(), state, fx, () => clock);
    const failed = result.actions.filter(action => action.kind === 'decision' && action.state === 'failed');
    assert.deepEqual(failed.map(action => action.detail), [`Could not withdraw requirements decision ${decision}, which ${key} no longer needs: the decisions step's 20 ms read deadline passed before ${key}'s decision history answered; it is read again next cycle`]);
    assert.deepEqual(withdrawn, [], 'nothing was withdrawn unread');
    assert.deepEqual(decisionFaults(state), [], 'one late read judged nothing');
    assert.ok(Object.values(state.approvals).some(watch => watch.decision === decision), 'the watch stays, so the withdrawal is tried next cycle');

    // The next cycle's read is late again: two in a row is a control plane that does not answer, and counts.
    await runCycle(config(), state, fx, () => clock + 60_000);
    assert.equal(decisionFaults(state).length, 1, 'the second late read in a row is a decision fault');
  });
}
