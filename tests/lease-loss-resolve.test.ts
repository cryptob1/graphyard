import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, routineDecision, runCycle, withheldDecision, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { endedLeaseLoss, leaseLossSettleMs, settleableLeaseLoss, type Escalation, type Work } from '../src/model.js';

// GY-161, 2026-09-24: the first worker (epoch 1) exited five minutes in, its lease lapsed and the
// control plane raised a lease-loss; the loop dispatched epoch 2, but nothing settled the standing
// escalation, so the merge gate would refuse until a master session asked for the resolution. The
// loop then asked for it as a routine two-party resolve; GY-1393 found 28 such approver rounds in
// 7 days confirming only what the record held, so reconciliation settles it on the record instead.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const lost: Escalation = { at: iso(-10 * 60_000), actor: 'graphyard', trigger: 'lease-loss', reason: 'Worker graphyard-claude-2 lost lease epoch 1' };

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [] });
}
function item(overrides: Partial<Work> = {}): Work {
  return {
    id: 'work-161', key: 'GY-161', title: 'Dashboard', description: '', type: 'feature', priority: 1, dependencies: [], criteria: [],
    policy: { checks: ['test'], review: true }, plannedFiles: ['web/'], stage: 'build', revision: 51, policyRevision: 3,
    createdAt: iso(-60 * 60_000), updatedAt: iso(0), stageEnteredAt: iso(-5 * 60_000), ready: true, epoch: 2,
    lease: { owner: 'graphyard-opencode-1', epoch: 2, expiresAt: iso(5 * 60_000) }, workspaces: [], candidate: null, submission: null,
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [],
    containmentQuarantine: { owner: 'graphyard-opencode-1', epoch: 2, at: iso(-5 * 60_000), settlementHash: 'a'.repeat(64) },
    escalation: lost, escalations: [lost], ...overrides,
  } as unknown as Work;
}
const decide = (work: Work) => routineDecision(work, { autoMerge: true }, clock);

test('unit:lease-loss-resolve-routine — a control-plane lease-loss whose lost attempt cannot act is settled on the record, bound to that escalation', () => {
  const at = Date.parse(lost.at) + leaseLossSettleMs;
  const settle = (work: Work) => settleableLeaseLoss(work, [], at).map(entry => ({ cause: entry.cause, at: entry.escalation.at, note: entry.note }));
  const [superseded] = settle(item());
  assert.equal(superseded?.cause, 'superseded');
  assert.equal(superseded.at, lost.at, 'it settles exactly the escalation it judged');
  assert.match(superseded.note, /epoch 2 is held by graphyard-opencode-1/);
  assert.match(superseded.note, /^auto-settled: superseded — epoch 2 is held by graphyard-opencode-1, so nothing from epoch 1 can act or merge$/);

  // The lost epoch's own fence still stands: it has not been shown stopped, so nothing settles.
  assert.deepEqual(settle(item({ containmentQuarantine: { owner: 'graphyard-claude-2', epoch: 1, at: iso(-9 * 60_000), settlementHash: 'b'.repeat(64) } } as Partial<Work>)), []);
  // Its own epoch still holds the lease: the lease-loss is not the current attempt's to settle.
  assert.deepEqual(settle(item({ epoch: 1, lease: { owner: 'graphyard-claude-2', epoch: 1, expiresAt: iso(60_000) }, containmentQuarantine: null } as Partial<Work>)), []);
  // Between attempts with no fence and no lease: every attempt has ended.
  assert.equal(settle(item({ epoch: 1, lease: null, containmentQuarantine: null } as Partial<Work>))[0]?.cause, 'ended');
  // A superseded one settles at once (GY-1390); an ended one only once it has stood its bound.
  assert.equal(settleableLeaseLoss(item())[0]?.cause, 'superseded');
  assert.deepEqual(settleableLeaseLoss(item({ epoch: 1, lease: null, containmentQuarantine: null } as Partial<Work>), [], at - 1), []);

  // Only the latest attempt's own submission shows supersession. Epoch 2 submitted, rework moved the
  // item to epoch 3, and epoch 3 lapsed (its lease-loss a suppressed repeat of epoch 1's): the epoch-2
  // submission vouches for nothing after it, but with no lease and no fence every attempt has ended.
  const submission = { epoch: 2, pr: 157, sha: 'c'.repeat(40) };
  const stale = endedLeaseLoss(item({ epoch: 3, lease: null, containmentQuarantine: null, submission } as Partial<Work>), lost);
  assert.equal(stale?.cause, 'ended');
  assert.match(stale!.evidence, /every attempt from epoch 1 to epoch 3 has ended/);
  const submitted = endedLeaseLoss(item({ epoch: 2, lease: null, containmentQuarantine: null, submission } as Partial<Work>), lost);
  assert.equal(submitted?.cause, 'superseded');
  assert.match(submitted!.evidence, /epoch 2 submitted PR #157/);
  // A later attempt holding the lease still supersedes every earlier one.
  assert.equal(endedLeaseLoss(item({ epoch: 3, lease: { owner: 'graphyard-opencode-1', epoch: 3, expiresAt: iso(60_000) }, containmentQuarantine: null, submission } as Partial<Work>), lost)?.cause, 'superseded');

  // Other triggers, and a lease-loss a lead raised, stay for the master.
  for (const other of [{ ...lost, trigger: 'security-concern', reason: 'a credential' }, { ...lost, actor: 'slice-lead' }])
    assert.deepEqual(settle(item({ escalation: other, escalations: [other] } as Partial<Work>)), [], `${other.trigger} by ${other.actor}`);
  // Delivered work is immutable.
  assert.equal(endedLeaseLoss(item({ stage: 'done' } as Partial<Work>), lost), null);
});

test('unit:lease-loss-resolve-requested — the loop asks no approver to resolve a control-plane lease-loss', async () => {
  for (const work of [item(), item({ epoch: 1, lease: null, containmentQuarantine: null } as Partial<Work>)]) {
    assert.equal(decide(work), null);
    assert.equal(withheldDecision(work, { autoMerge: true }, clock), null);
  }
  const decided: { action: string; reason: string; input?: Record<string, unknown> }[] = [], approvers: string[] = [];
  const state = emptyDaemonState(config());
  await runCycle(config(), state, loopEffects(item(), decided, approvers, () => []), () => clock);
  assert.deepEqual(decided, []);
  assert.deepEqual(approvers, []);
});

function loopEffects(work: Work, decided: { action: string; reason: string; input?: Record<string, unknown> }[], approvers: string[], standing: () => unknown[]) {
  return {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [work], now: iso(0), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async (_work: Work, action: string, reason: string, input?: Record<string, unknown>) => { decided.push({ action, reason, input }); return { id: '5d8a8b9e-0000-4000-8000-0000000001a1' }; },
    decisions: async () => ({ decisions: standing() }),
    approver: async (_work: Work, decision: string) => { approvers.push(decision); return { agentName: 'graphyard-approver-gy-161', pane: 'pane-1' }; },
    persist: async () => {},
  } as unknown as DaemonEffects;
}
