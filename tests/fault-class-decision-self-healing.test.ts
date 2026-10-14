import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { Launcher } from '../src/daemon/cycle.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Observation, Work } from '../src/model.js';

/**
 * GY-1505 names this file for its proof: manual:fault-class-decision. The master loop filed 3
 * decision faults in 24 hours on 8 October 2026, each a failure the decisions step heals itself on
 * its next cycle, which judged nothing:
 *
 * - action:decision|GY-1488|2026-10-08T00:05:57.107Z — the rework's approver launch stopped at a
 *   workspace-trust prompt although its launch records the folder trusted (the GY-1152 race: a
 *   session sharing the account's config rewrote it after GY-1306's read-back). The watch stayed,
 *   the next cycle relaunched it, and that approver carried GY-1488 to delivery.
 * - action:decision|GY-1491|2026-10-08T01:00:16.787Z and action:decision|GY-1497|…01:00:46.849Z —
 *   the rework put met its 30 s timeout ("The operation was aborted due to timeout"), 30 s apart in
 *   one cycle: the control plane did not answer (GY-1344's plane silence), and the next cycle asks again.
 *
 * Each instance is replayed through the loop's own cycle. Against the base each records a decision
 * fault; against the candidate none, while the same failure again on the item's next cycle counts.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2026-10-08T00:05:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const sha = 'c'.repeat(40), base = 'b'.repeat(40);
const config = (): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });

/** An item whose reviewer requested changes on its candidate, so the loop requests a rework and puts it to an approver. */
function item(key: string): Work {
  const candidate = { sha, baseSha: base, pr: 42, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' };
  const observation = {
    clockOffset: { min: 0, max: 0 }, candidate, checks: [{ name: 'test', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'independent-reviewer', sha, state: 'CHANGES_REQUESTED' }],
    protected: true, mergeable: true, merged: false, mergeSha: null, files: ['src/loop.ts'], scopeFiles: [], at: iso(-20_000),
  } as Observation;
  return {
    id: `00000000-0000-4000-8000-${key.replace(/\D/g, '').padStart(12, '0')}`, key, title: key, description: '', type: 'bug', priority: 2,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:loop'] }], policy: { checks: ['test'], review: true },
    plannedFiles: ['src/loop.ts'], stage: 'review', revision: 5, policyRevision: 1, createdAt: iso(-3_600_000), updatedAt: iso(0),
    stageEnteredAt: iso(-1_800_000), ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: 42 },
    candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null, violations: [],
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }],
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
const faultsOf = (state: ReturnType<typeof emptyDaemonState>, faultClass: string) => state.faults.instances.filter(instance => instance.faultClass === faultClass);
const planeFaults = (state: ReturnType<typeof emptyDaemonState>) => state.faults.instances.filter(instance => instance.kind === 'plane-unavailable');
/** The control plane holds the rework once it is requested, as `requested` until an approver judges it. */
const holding = (id: string, requested: string[]): Partial<DaemonEffects> => ({
  decide: async () => { requested.push(id); return { id }; },
  decisions: async () => ({ decisions: requested.length ? [{ id, action: 'rework', state: 'requested', input: {}, approvedBy: null }] : [] }),
} as Partial<DaemonEffects>);
/** The error a launch that lost the folder-trust race throws (src/master/launch.ts, GY-1152). */
const trustRace = () => new Error('the claude runtime stopped at a workspace-trust prompt in pane w1:p7 although its launch records the folder trusted, so the launch failed rather than holding the lease for a human: "Do you trust the files in this folder?"');
/** The error fetch's `AbortSignal.timeout` rejects with when the control plane does not answer a put in time. */
const putTimeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

for (const key of ['GY-1491', 'GY-1497']) {
  test(`manual:fault-class-decision — action:decision|${key}: a decision put the control plane did not answer in time is no fault; the next cycle asks again`, async () => {
    const work = item(key), sent: string[] = [];
    let answers = false;
    const fx = effects(work, { decide: async (_target, action) => { sent.push(action); if (!answers) throw putTimeout(); return { id: 'decision-1' }; } });
    const state = emptyDaemonState(config());
    const result = await runCycle(config(), state, fx, () => clock);
    const failed = result.actions.filter(action => action.kind === 'decision' && action.state === 'failed');
    assert.deepEqual(sent, ['rework'], 'the loop asked for the rework the instance names');
    assert.deepEqual(failed.map(action => action.detail), [`Could not put the rework decision for ${key} to an approver: The operation was aborted due to timeout`]);
    assert.deepEqual(faultsOf(state, 'decision'), [], 'a put the control plane never answered judged nothing');
    assert.deepEqual(planeFaults(state), [], 'one unanswered put alone is no plane outage either');

    // The next cycle asks again without waiting out the retry backoff, and the decision is put.
    answers = true;
    await runCycle(config(), state, fx, () => clock + 30_000);
    assert.deepEqual(sent, ['rework', 'rework'], 'the next cycle requested the rework again');
    assert.ok(Object.values(state.approvals).some(watch => watch.decision === 'decision-1'), 'the decision is put to an approver');
    assert.deepEqual(faultsOf(state, 'decision'), []);
  });
}

test('manual:fault-class-decision — the same unanswered put on the item\'s next cycle is a plane that does not answer, and counts', async () => {
  const work = item('GY-1491');
  const fx = effects(work, { decide: async () => { throw putTimeout(); } });
  const state = emptyDaemonState(config());
  await runCycle(config(), state, fx, () => clock);
  await runCycle(config(), state, fx, () => clock + 30_000);
  assert.equal(planeFaults(state).length, 1, 'the second unanswered put in a row is a plane-unavailable fault');
  assert.deepEqual(faultsOf(state, 'decision'), [], 'the decision step judged nothing either time');

  // Any other refusal of the put is still the decision step's own fault.
  const other = emptyDaemonState(config());
  await runCycle(config(), other, effects(work, { decide: async () => { throw new Error('Graphyard refused work/x/decide (409): Task revision is locked'); } }), () => clock);
  assert.equal(faultsOf(other, 'decision').length, 1);
});

test('manual:fault-class-decision — action:decision|GY-1488|2026-10-08T00:05:57.107Z: an approver launch that lost the folder-trust race is no fault; the relaunch carries the decision', async () => {
  const work = item('GY-1488'), launches: string[] = [];
  let raced = true;
  const fx = effects(work, { ...holding('decision-1488', []), approver: async (_target, decision) => { launches.push(decision); if (raced) throw trustRace(); return { agentName: 'graphyard-approver', pane: 'pane-1' }; } });
  const state = emptyDaemonState(config());
  const result = await runCycle(config(), state, fx, () => clock);
  const failed = result.actions.filter(action => action.kind === 'decision' && action.state === 'failed');
  assert.deepEqual(launches, ['decision-1488']);
  assert.ok(failed.some(action => /stopped at a workspace-trust prompt/.test(action.detail)), JSON.stringify(failed));
  assert.deepEqual(faultsOf(state, 'decision'), [], 'a launch that lost the trust race judged nothing');

  // The watch stayed: the next cycle relaunches the approver, which starts.
  raced = false;
  await runCycle(config(), state, fx, () => clock + 60_000);
  assert.deepEqual(launches, ['decision-1488', 'decision-1488'], 'the next cycle relaunched the approver');
  assert.equal(Object.values(state.approvals).find(watch => watch.decision === 'decision-1488')?.agentName, 'graphyard-approver');
  assert.deepEqual(faultsOf(state, 'decision'), []);
});

test('manual:fault-class-decision — GY-1488 under the loop\'s own launcher: the launch that lost the trust race is no fault; losing it again on the next cycle counts', async () => {
  const work = item('GY-1488');
  const fx = effects(work, { ...holding('decision-1488', []), approver: async () => { throw trustRace(); } });
  const state = emptyDaemonState(config()), loop = new Launcher();
  await runCycle(config(), state, fx, () => clock, loop); await loop.idle();
  assert.ok(Object.values(state.actions).some(action => action.state === 'failed' && /stopped at a workspace-trust prompt/.test(action.detail)), JSON.stringify(state.actions));
  assert.deepEqual(faultsOf(state, 'decision'), [], 'one lost trust race judged nothing');

  // The race again on the item's next cycle is a trust step that does not take: the decision step's fault.
  await runCycle(config(), state, fx, () => clock + 60_000, loop); await loop.idle();
  await runCycle(config(), state, fx, () => clock + 120_000, loop); await loop.idle();
  assert.equal(faultsOf(state, 'decision').length, 1, 'a repeated trust failure is a decision fault');
});
