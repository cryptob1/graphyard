import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';
import { actionAccount, humanNeededActions } from '../src/model/next-action.js';
import { attestationOwner, unproducedManualProofs } from '../src/model/unproduced-attestation.js';
import { accountOutcome, stalledItems } from '../src/model/action-account.js';
import { loopAttestations } from '../src/cli/hand-actions.js';

// GY-521, 2026-09-26: GY-374 (manual:fault-class-configuration) and GY-393 sat in acceptance for over
// two hours with an approved review and passing CI. No producer session may run their proof, so only
// a two-party attestation satisfies it — and the loop logged a human step every cycle and requested nothing.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const proof = 'manual:fault-class-configuration';
const sha = 'a'.repeat(40), baseSha = 'b'.repeat(40), moved = 'c'.repeat(40);
const refusal = `AC-1: ${proof} needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy`;

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [] });
}
function item(head = sha, overrides: Partial<Work> = {}): Work {
  const candidate = { pr: 374, sha: head, baseSha };
  return {
    id: 'work-374', key: 'GY-374', title: 'Fault class: configuration', description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'The configuration fault class no longer recurs', proofs: [proof] }], producerProofs: [],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'acceptance', revision: 20, policyRevision: 2,
    createdAt: iso(-3 * 60 * 60_000), updatedAt: iso(0), stageEnteredAt: iso(-2 * 60 * 60_000), ready: true, epoch: 1, lease: null, workspaces: [],
    submission: { epoch: 1, pr: 374, sha: head }, candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [],
    observation: { at: iso(-30_000), candidate, prState: 'open', draft: false, mergeable: true, protected: true, checks: [], reviews: [] },
    gates: [
      { name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] },
      { name: 'test', passed: true, reasons: [] }, { name: 'acceptance', passed: false, reasons: [refusal] }, { name: 'merge', passed: true, reasons: [] },
    ],
    autoDispatch: { review: null, producers: [], history: [] }, containmentQuarantine: null, escalations: [], ...overrides,
  } as unknown as Work;
}

test('unit:unproduced-manual-proof-owned-by-loop — the wait is the loop\'s attestation request, never a human step', () => {
  const work = item(), now = new Date(clock);
  assert.deepEqual(unproducedManualProofs(work, [work], now), [proof]);
  const account = actionAccount(work, [work], now);
  assert.equal(account.action, null, 'no escalation to a person');
  assert.equal(account.wait?.kind, 'session');
  assert.equal(account.wait?.on, attestationOwner);
  assert.match(account.wait!.detail, /loop's two-party attestation request for manual:fault-class-configuration/);
  assert.equal(accountOutcome(account), 'waiting-on');
  // Not needs-human, and not a stall however long it holds the gate.
  const stored = { ...work, nextAction: account.action } as Work;
  assert.deepEqual(humanNeededActions([stored], now), []);
  assert.deepEqual(stalledItems([stored], now, 0), []);
  // master status lists it under the loop's pending decisions, with what the loop does next.
  const [row] = loopAttestations({ work: [work], now: iso(0) });
  assert.deepEqual({ key: row.key, proof: row.proof, state: row.state }, { key: 'GY-374', proof, state: 'to-request' });
  const judging = loopAttestations({ work: [work], now: iso(0) }, [{ key: `decision:attest:work-374:${proof}:${sha}:${baseSha}:2`, work: 'GY-374', action: 'attest', decision: 'd-1', agentName: 'graphyard-approver-gy-374-d1', settledAt: null }]);
  assert.equal(judging[0].state, 'judging');
  assert.match(judging[0].detail, /graphyard-approver-gy-374-d1/);

  // What stays a person's: a producer-runnable manual proof, a failed attestation, and anything else still refusing.
  assert.deepEqual(unproducedManualProofs(item(sha, { producerProofs: [proof] } as Partial<Work>), [], now), []);
  const failed = item(sha, { evidence: [{ proof, result: 'fail', executed: 1, skipped: 0, sha, baseSha, policyRevision: 2, trusted: true, producer: 'graphyard-approver', at: iso(-60_000) }] } as unknown as Partial<Work>);
  assert.deepEqual(unproducedManualProofs(failed, [failed], now), []);
  const mixed = item(sha, { gates: item().gates.map(gate => gate.name === 'acceptance' ? { ...gate, reasons: [refusal, 'AC-2: unit:other needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy'] } : gate) } as Partial<Work>);
  assert.deepEqual(unproducedManualProofs(mixed, [mixed], now), []);
  const unreviewed = item(sha, { gates: item().gates.map(gate => gate.name === 'review' ? { ...gate, passed: false, reasons: ['Independent approval of the current commit is required'] } : gate) } as Partial<Work>);
  assert.deepEqual(unproducedManualProofs(unreviewed, [unreviewed], now), []);
});

type Decided = { id: string; action: string; reason: string; input?: Record<string, unknown> };
function loopEffects(current: () => Work, decided: Decided[], approvers: string[], withdrawn: string[]) {
  return {
    agents: () => [], herdr: () => ({ agents: approvers.map(decision => ({ name: `graphyard-approver-gy-374-${decision}`, pane_id: `pane-${decision}`, agent_status: 'working' })), available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [current()], now: iso(0), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async (work: Work, action: string, reason: string, input?: Record<string, unknown>) => {
      const id = `d-${decided.length + 1}`;
      decided.push({ id, action, reason, input: { ...input, sha: work.candidate!.sha, baseSha: work.candidate!.baseSha, policyRevision: work.policyRevision } });
      return { id };
    },
    // The server lists a request as standing until an approver judges it or its requester withdraws it.
    decisions: async () => ({ decisions: decided.map(entry => ({ id: entry.id, action: entry.action, state: withdrawn.includes(entry.id) ? 'withdrawn' : 'requested', input: entry.input, approvedBy: null })) }),
    withdraw: async (_work: Work, decision: string) => { withdrawn.push(decision); },
    approver: async (_work: Work, decision: string) => { approvers.push(decision); return { agentName: `graphyard-approver-gy-374-${decision}`, pane: `pane-${decision}` }; },
    persist: async () => {},
  } as unknown as DaemonEffects;
}

test('unit:unproduced-manual-proof-attestation-requested — requested once with its approver, never twice, withdrawn on a head change', async () => {
  const decided: Decided[] = [], approvers: string[] = [], withdrawn: string[] = [];
  let work = item();
  const effects = loopEffects(() => work, decided, approvers, withdrawn);
  const state = emptyDaemonState(config());

  const first = await runCycle(config(), state, effects, () => clock);
  assert.equal(decided.length, 1, 'one attestation decision for the one unproduced proof');
  assert.ok(!first.actions.some(action => action.kind === 'escalation' && action.detail.includes(proof)), 'the proof the loop attests is not escalated to an operator as well');
  assert.equal(decided[0].action, 'attest');
  assert.deepEqual(decided[0].input, { proof, sha, baseSha, policyRevision: 2 }, 'names the proof, the exact head, base and policy revision');
  assert.match(decided[0].reason, /manual:fault-class-configuration/);
  assert.match(decided[0].reason, /aaaaaaaaaaaa/);
  assert.deepEqual(approvers, ['d-1'], 'an independent approver is launched for it within the cycle');

  // The next cycle supervises the open request: no second request for the same proof and head.
  await runCycle(config(), state, effects, () => clock + 30_000);
  assert.equal(decided.length, 1);
  assert.deepEqual(approvers, ['d-1']);
  assert.equal(withdrawn.length, 0);

  // A new head moves the binding: the request nobody judged is withdrawn, and the new head is asked afresh.
  work = item(moved);
  await runCycle(config(), state, effects, () => clock + 60_000);
  assert.ok(withdrawn.includes('d-1'), 'the decision for the old head is withdrawn');
  assert.equal(decided.at(-1)?.input?.sha, moved);
  assert.equal(decided.filter(entry => entry.input?.sha === moved).length, 1);
});
