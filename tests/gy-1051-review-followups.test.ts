import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { decisionInput, masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';
import { loopAttested, unproducedManualProofs } from '../src/model/unproduced-attestation.js';
import { loopAttestations } from '../src/cli/hand-actions.js';

// GY-1051: follow-ups from the approved review of GY-521 (PR #281), the loop's own attestation of
// `manual:` proofs no producer may run.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const first = 'manual:fault-class-configuration', second = 'manual:fault-class-containment';
const sha = 'a'.repeat(40), baseSha = 'b'.repeat(40), moved = 'c'.repeat(40);
const refusal = (id: string, proof: string) => `${id}: ${proof} needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy`;

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [] });
}
function item(head = sha, proofs = [first, second], overrides: Partial<Work> = {}): Work {
  const candidate = { pr: 374, sha: head, baseSha };
  return {
    id: 'work-374', key: 'GY-374', title: 'Fault classes', description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: proofs.map((proof, index) => ({ id: `AC-${index + 1}`, text: `The ${proof} fault class no longer recurs`, proofs: [proof] })), producerProofs: [],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'acceptance', revision: 20, policyRevision: 2,
    createdAt: iso(-3 * 60 * 60_000), updatedAt: iso(0), stageEnteredAt: iso(-2 * 60 * 60_000), ready: true, epoch: 1, lease: null, workspaces: [],
    submission: { epoch: 1, pr: 374, sha: head }, candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [],
    observation: { at: iso(-30_000), candidate, prState: 'open', draft: false, mergeable: true, protected: true, checks: [], reviews: [] },
    gates: [
      { name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] },
      { name: 'test', passed: true, reasons: [] }, { name: 'acceptance', passed: false, reasons: proofs.map((proof, index) => refusal(`AC-${index + 1}`, proof)) }, { name: 'merge', passed: true, reasons: [] },
    ],
    autoDispatch: { review: null, producers: [], history: [] }, containmentQuarantine: null, escalations: [], ...overrides,
  } as unknown as Work;
}

type Decided = { id: string; action: string; reason: string; input: Record<string, any>; state: string };
function loopEffects(current: () => Work, decided: Decided[], approvers: string[], closed: string[]) {
  return {
    agents: () => [], herdr: () => ({ agents: approvers.map(decision => ({ name: `graphyard-approver-gy-374-${decision}`, pane_id: `pane-${decision}`, agent_status: 'working' })), available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [current()], now: iso(0), jobs: [] }),
    closeSession: (pane: string) => { closed.push(pane); }, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    // The production binding (src/master/autonomy.ts decisionInput), as effects.ts sends it: the mock adds nothing to it.
    decide: async (work: Work, action: string, reason: string, input: Record<string, unknown> = {}) => {
      const id = `d-${decided.length + 1}`;
      decided.push({ id, action, reason, input: decisionInput(action, work, input), state: 'requested' });
      return { id };
    },
    decisions: async () => ({ decisions: decided.map(entry => ({ id: entry.id, action: entry.action, state: entry.state, input: entry.input, approvedBy: null,
      refusal: entry.state === 'refused' ? { approver: 'graphyard-approver-graphyard', reason: 'the criterion does not hold on this head' } : null })) }),
    withdraw: async (_work: Work, decision: string) => { decided.find(entry => entry.id === decision)!.state = 'withdrawn'; },
    approver: async (_work: Work, decision: string) => { approvers.push(decision); return { agentName: `graphyard-approver-gy-374-${decision}`, pane: `pane-${decision}` }; },
    persist: async () => {},
  } as unknown as DaemonEffects;
}

test('manual:review-followups-triaged GY-1051.1: an inherited bootstrap obligation is never the loop\'s to attest (findings 1, 4, 22, 21, 25)', () => {
  const now = new Date(clock), inherited = 'manual:bootstrap-obligation';
  // The acceptance gate refuses on an inherited obligation no criterion of the item names: the
  // control plane would refuse its attest decision, so it stays the operator's escalation.
  const held = item(sha, [first], { gates: item(sha, [first]).gates.map(gate => gate.name === 'acceptance' ? { ...gate, reasons: [refusal('bootstrap', inherited)] } : gate) } as Partial<Work>);
  const declaring = { ...item(sha, [first]), id: 'work-9', key: 'GY-9', stage: 'build', plannedFiles: ['src/daemon/'],
    criteria: [{ id: 'AC-1', text: 'deferred', proofs: [inherited], bootstrap: { reason: 'deferred', contractPaths: ['src/'] } }] } as unknown as Work;
  const all = [held, declaring];
  assert.equal(loopAttested(held, inherited, now), false);
  assert.deepEqual(unproducedManualProofs(held, all, now), []);
  assert.deepEqual(loopAttestations({ work: all, now: iso(0) }), []);
  // Nor is a proof only a bootstrap criterion of the item itself names (it defers that proof).
  const deferring = item(sha, [first], { criteria: [{ id: 'AC-1', text: 'deferred', proofs: [first], bootstrap: { reason: 'later', until: 'GY-2' } }] } as unknown as Partial<Work>);
  assert.equal(loopAttested(deferring, first, now), false);
  // The item's own criterion still is.
  assert.equal(loopAttested(item(sha, [first]), first, now), true);
});

test('manual:review-followups-triaged GY-1051.2: several unproduced proofs are attested one at a time, the second requested as the first settles (findings 2, 5, 7, 19, 23, 32)', async () => {
  const decided: Decided[] = [], approvers: string[] = [], closed: string[] = [];
  const work = item();
  const effects = loopEffects(() => work, decided, approvers, closed);
  const state = emptyDaemonState(config());

  await runCycle(config(), state, effects, () => clock);
  assert.deepEqual(decided.map(entry => entry.input.proof), [first], 'only the first proof is requested: the control plane holds one attest decision per item');
  assert.deepEqual(approvers, ['d-1']);

  const waiting = await runCycle(config(), state, effects, () => clock + 30_000);
  assert.equal(decided.length, 1, 'the second proof waits while the first is judged');
  assert.ok(!waiting.actions.some(action => action.state === 'failed'), 'waiting is not a failed step');

  // The first is refused: the loop does not ask again, and requests the second within the same cycle.
  decided[0].state = 'refused';
  await runCycle(config(), state, effects, () => clock + 60_000);
  assert.deepEqual(decided.map(entry => entry.input.proof), [first, second]);
  assert.deepEqual(approvers, ['d-1', 'd-2']);
  assert.ok(closed.includes('pane-d-1'), 'the refused decision\'s approver is closed');
});

test('manual:review-followups-triaged GY-1051.3: an attest for another proof standing on the head is a quiet wait, not a failed step (findings 11, 29, 31, 36)', async () => {
  // A hand request for the second proof stands; the loop wants the first.
  const decided: Decided[] = [], approvers: string[] = [], closed: string[] = [];
  const work = item();
  decided.push({ id: 'd-hand', action: 'attest', reason: 'by hand', input: decisionInput('attest', work, { proof: second }), state: 'requested' });
  const effects = loopEffects(() => work, decided, approvers, closed);
  const state = emptyDaemonState(config());

  const once = await runCycle(config(), state, effects, () => clock);
  const recorded = once.actions.filter(action => action.kind === 'decision' && action.work === 'GY-374');
  assert.ok(recorded.length >= 1);
  assert.ok(!recorded.some(action => action.state === 'failed'), 'no failed decision step');
  assert.match(recorded.map(action => action.detail).join('\n'), /waits: attest decision d-hand is requested for manual:fault-class-containment/);
  assert.equal(decided.length, 1, 'nothing more is requested while it stands');
  assert.equal(decided[0].state, 'requested', 'and it is not withdrawn: it binds this head');

  const again = await runCycle(config(), state, effects, () => clock + 30_000);
  assert.ok(!again.actions.some(action => action.kind === 'decision' && action.work === 'GY-374' && /waits/.test(action.detail)), 'the unchanged wait is not recorded again');
  assert.ok(!again.actions.some(action => action.state === 'failed'));
});

test('manual:review-followups-triaged GY-1051.4: the request carries the production binding, and a head change launches the new approver and closes the old (findings 9, 17)', async () => {
  const decided: Decided[] = [], approvers: string[] = [], closed: string[] = [];
  let work = item(sha, [first]);
  const effects = loopEffects(() => work, decided, approvers, closed);
  const state = emptyDaemonState(config());

  await runCycle(config(), state, effects, () => clock);
  assert.equal(decided.length, 1);
  assert.deepEqual({ proof: decided[0].input.proof, sha: decided[0].input.sha, baseSha: decided[0].input.baseSha, policyRevision: decided[0].input.policyRevision, result: decided[0].input.result },
    { proof: first, sha, baseSha, policyRevision: 2, result: 'pass' }, 'decisionInput binds the proof to the exact head, base and policy revision');

  work = item(moved, [first]);
  await runCycle(config(), state, effects, () => clock + 60_000);
  assert.equal(decided[0].state, 'withdrawn');
  const fresh = decided.find(entry => entry.input.sha === moved);
  assert.ok(fresh, 'the new head is asked afresh');
  assert.ok(approvers.includes(fresh.id), 'an approver is launched for the new head');
  assert.ok(closed.includes('pane-d-1'), 'the old head\'s approver is closed');
});

test('manual:review-followups-triaged GY-1051.5: master status names a settled loop attestation as refused and the operator\'s to answer (findings 3, 6, 10, 12, 18, 34, 38)', () => {
  const work = item(sha, [first]);
  const key = `decision:attest:work-374:${first}:${sha}:${baseSha}:2`;
  const [row] = loopAttestations({ work: [work], now: iso(0) }, [
    { key: 'decision:attest:other', work: 'GY-9', action: 'attest', decision: 'd-9', settledAt: null },
    { key, work: 'GY-374', action: 'attest', decision: 'd-1', agentName: 'graphyard-approver-gy-374-d-1', settledAt: iso(-1000) },
  ]);
  assert.equal(row.state, 'refused');
  assert.equal(row.decision, 'd-1');
  assert.match(row.detail, /was refused/);
  assert.match(row.detail, /operator's/);
  assert.match(row.detail, /graphyard master decisions GY-374/);
});
