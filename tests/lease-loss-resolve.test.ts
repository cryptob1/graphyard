import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, routineDecision, runCycle, supersededLeaseLoss, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';

// GY-161, 2026-09-24: the first worker (epoch 1) exited five minutes in, its lease lapsed and the
// control plane raised a lease-loss; the loop dispatched epoch 2, but nothing settled the standing
// escalation, so the merge gate would refuse until a master session asked for the resolution.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const lost = { at: iso(-10 * 60_000), actor: 'graphyard', trigger: 'lease-loss', reason: 'Worker graphyard-claude-2 lost lease epoch 1' };

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

test('unit:lease-loss-resolve-routine — a control-plane lease-loss a newer attempt superseded is a routine resolve, bound to that escalation', () => {
  const superseded = decide(item());
  assert.equal(superseded?.action, 'resolve');
  assert.deepEqual(superseded?.input, { trigger: 'lease-loss' });
  assert.equal(superseded?.binding, `lease-loss:1:${lost.at}`, 'one request per escalation, stable across cycles and heartbeats');
  assert.equal(decide(item({ revision: 60 } as Partial<Work>))?.binding, superseded?.binding);
  assert.match(superseded!.reason, /epoch 2 is held by graphyard-opencode-1/);
  assert.match(superseded!.reason, /decides no gate and ships nothing/);

  // The lost epoch's own fence still stands: it has not been shown stopped, so nothing is asked.
  assert.equal(decide(item({ containmentQuarantine: { owner: 'graphyard-claude-2', epoch: 1, at: iso(-9 * 60_000), settlementHash: 'b'.repeat(64) } } as Partial<Work>)), null);
  // Its own epoch still holds the lease: the lease-loss is not the current attempt's to settle.
  assert.equal(decide(item({ epoch: 1, lease: { owner: 'graphyard-claude-2', epoch: 1, expiresAt: iso(60_000) }, containmentQuarantine: null } as Partial<Work>)), null);
  // Between attempts with no fence and no lease: this host's stopped-worker verification is the grounds.
  const idle = decide(item({ epoch: 1, lease: null, containmentQuarantine: null } as Partial<Work>));
  assert.equal(idle?.action, 'resolve');
  assert.match(idle!.reason, /The previous worker is stopped/);

  // Other triggers, and a lease-loss a lead raised, stay for the master.
  for (const other of [{ ...lost, trigger: 'security-concern', reason: 'a credential' }, { ...lost, actor: 'slice-lead' }]) {
    assert.equal(supersededLeaseLoss(item({ escalation: other, escalations: [other] } as Partial<Work>)), null, `${other.trigger} by ${other.actor}`);
    assert.equal(decide(item({ escalation: other, escalations: [other] } as Partial<Work>)), null);
  }
  // Delivered work is immutable: the control plane refuses any resolve there.
  assert.equal(supersededLeaseLoss(item({ stage: 'done' } as Partial<Work>)), null);
});

test('unit:lease-loss-resolve-requested — the loop requests the resolve with its trigger and launches an approver, once', async () => {
  const decided: { action: string; reason: string; input?: Record<string, unknown> }[] = [], approvers: string[] = [];
  const work = item();
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [work], now: iso(0), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async (_work: Work, action: string, reason: string, input?: Record<string, unknown>) => { decided.push({ action, reason, input }); return { id: '5d8a8b9e-0000-4000-8000-0000000001a1' }; },
    // The server lists the request as standing until an approver judges it.
    decisions: async () => ({ decisions: decided.map(entry => ({ id: '5d8a8b9e-0000-4000-8000-0000000001a1', action: entry.action, state: 'requested', input: { ...entry.input, expectedRevision: 51 }, approvedBy: null })) }),
    approver: async (_work: Work, decision: string) => { approvers.push(decision); return { agentName: 'graphyard-approver-gy-161', pane: 'pane-1' }; },
    persist: async () => {},
  } as unknown as DaemonEffects;
  const state = emptyDaemonState(config());
  await runCycle(config(), state, effects, () => clock);
  assert.equal(decided.length, 1);
  assert.equal(decided[0].action, 'resolve');
  assert.deepEqual(decided[0].input, { trigger: 'lease-loss' });
  assert.deepEqual(approvers, ['5d8a8b9e-0000-4000-8000-0000000001a1']);
  // The next cycle supervises the same request rather than asking again.
  await runCycle(config(), state, effects, () => clock + 30_000);
  assert.equal(decided.length, 1);
});
