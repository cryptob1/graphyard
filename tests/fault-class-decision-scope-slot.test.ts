import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { decisionInput, masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, scopeBudget, type DaemonEffects } from '../src/master-daemon.js';
import { coveringStandingScopeWatch } from '../src/daemon/metrics.js';
import { standingCoversScopeAsk } from '../src/daemon/decisions.js';
import { scopeBlockedBudgetMs } from '../src/model/scope.js';
import { handFiledPatterns } from '../src/model/interventions.js';
import type { ScopeRequestState } from '../src/model/scope.js';
import { approvalWatchSchema } from '../src/daemon/state.js';
import { decisionKey } from '../src/daemon/reconcile.js';
import { scopeDecisionBinding } from '../src/model/scope.js';

/**
 * GY-1701 names this file for its proof: manual:fault-class-decision. The master loop filed 3
 * decision faults in 24 hours on 10–11 October 2026:
 *
 * - intervention-pattern|interventions|2026-10-10T23:16:36.002Z — 21 scope-widening interventions
 *   at the build stage in 7 days. Owned by delivered GY-1682/GY-1684 (hand-filed pattern item);
 *   GY-1689/GY-1693 verify the pattern stays under threshold post-deploy. Not this item's shared
 *   cause; the test below pins that a fault-class item quoting the pattern stands for it.
 *
 * - action:decision|GY-1700|2026-10-11T14:48:22.935Z — the loop threw while putting GY-1700's
 *   scope widening to an approver because requirements decision 9a6095d9… (a master's criteria
 *   rewrite, no `answers`) held the one-at-a-time slot, even though its plannedFiles already
 *   included the test the worker asked for.
 *
 * - action:escalation|escalation:scope-budget:blocked:GY-1700:4|2026-10-11T15:04:54.952Z — that
 *   ask then waited 17 minutes past the 15-minute blocked bound while the standing revision was
 *   approved and held until the attempt ended.
 *
 * Shared cause (instances 2 and 3): a foreign no-answers requirements decision starved the slot
 * and the blocked bound counted the wait. Against the base the throw and the breach reproduce;
 * against the candidate the covering standing revision is adopted and the bound does not run.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const config = (): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });

const askedAt = '2026-10-11T14:47:50.000Z';
const decisionAt = '2026-10-11T14:47:23.000Z';
const faultAt = '2026-10-11T14:48:22.935Z';
const breachAt = '2026-10-11T15:04:54.952Z';
const testFile = 'tests/webhook-soft-accept.test.ts';
const planned = ['src/server/routes/github.ts', 'src/server/main.ts', 'docs/protocol/github-webhook.md', testFile];
const standingId = '9a6095d9-c3e5-4357-93d6-48b8ccc61e5e';

/** GY-1700 as the loop saw it when the action:decision fault was recorded: open refused scope ask, live lease, master's no-answers revision standing. */
function gy1700(at: string, standingState: 'requested' | 'held' = 'requested'): Work {
  const request: ScopeRequestState = {
    epoch: 4, at: askedAt, paths: [testFile], reason: 'AC-0 needs the soft-accept test', requestedBy: 'graphyard-claude-1',
    decision: { state: 'refused', reason: 'No rule implies tests/webhook-soft-accept.test.ts', at: askedAt, decidedBy: 'graphyard', waitedMs: 0, paths: [testFile], requestedBy: 'graphyard-claude-1', requestedAt: askedAt, epoch: 4 },
  };
  return {
    id: '00000000-0000-4000-8000-000000001700', key: 'GY-1700', title: 'Webhook soft-accept', description: '', type: 'bug', priority: 2,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Soft-accept does not 5xx', proofs: ['unit:webhook-soft-accept-no-5xx'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: planned.slice(0, 3), stage: 'build', revision: 4, policyRevision: 2,
    createdAt: decisionAt, updatedAt: at, stageEnteredAt: decisionAt, ready: true, epoch: 4,
    lease: { owner: 'graphyard-claude-1', epoch: 4, expiresAt: new Date(Date.parse(at) + 60 * 60_000).toISOString() },
    workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null,
    blocker: null, gates: [{ name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }],
    violations: [], scopeRequest: request, carriedScopeRequest: null, scopeDecision: null,
    containmentQuarantine: standingState === 'held' ? { at: decisionAt, epoch: 4, owner: 'graphyard-claude-1', scope: { pid: 1, unit: 'u' }, leaseExpiresAt: new Date(Date.parse(at) + 60 * 60_000).toISOString(), settlementHash: 'a'.repeat(64), launchExpiresAt: decisionAt, launchAcknowledgedAt: decisionAt } : undefined,
  } as unknown as Work;
}

type Ledgered = { id: string; action: string; state: string; input: any; reason: string; outcome: string | null; approvedBy: string | null; approvedAt: string | null; refusal: null; requestedAt: string };
function plane(effects: DaemonEffects, work: Work, standing: Ledgered) {
  const ledger = new Map<string, Ledgered[]>([[work.key, [standing]]]);
  const requests: { action: string; input: any }[] = [], withdrawn: string[] = [], launches: string[] = [];
  Object.assign(effects, {
    herdr: () => ({ available: true, agents: [] }),
    decisions: async (item: Work) => ({ decisions: structuredClone(ledger.get(item.key) ?? []) }),
    decide: async (_item: Work, action: string, _reason: string, input: Record<string, unknown> = {}) => {
      const id = '00000000-0000-4000-8000-00000000scope';
      const entry: Ledgered = { id, action, state: 'requested', input: decisionInput(action, work, input), reason: _reason, outcome: null, approvedBy: null, approvedAt: null, refusal: null, requestedAt: new Date().toISOString() };
      requests.push({ action, input: entry.input });
      ledger.set(work.key, [...(ledger.get(work.key) ?? []), entry]);
      return { id, state: 'requested' };
    },
    withdraw: async (item: Work, decision: string) => {
      withdrawn.push(`${item.key}:${decision}`);
      const entry = ledger.get(item.key)?.find(each => each.id === decision);
      if (entry) entry.state = 'withdrawn';
    },
    approver: async (_item: Work, decision: string) => { launches.push(decision); return { agentName: 'graphyard-approver', pane: 'pane-1' }; },
  });
  return { ledger, requests, withdrawn, launches };
}

function effectsOf(work: Work): DaemonEffects {
  return {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [work], now: work.updatedAt, jobs: [] }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: work.updatedAt, reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async () => ({ id: 'unused' }), decisions: async () => ({ decisions: [] }),
    approver: async () => ({ agentName: 'graphyard-approver', pane: 'pane-1' }), persist: async () => {},
  };
}

const masterStanding = (state: 'requested' | 'held', files = planned): Ledgered => ({
  id: standingId, action: 'requirements', state, reason: 'Add AC-0 and post-deploy proofs', outcome: state === 'held' ? 'held for live attempt' : null,
  approvedBy: state === 'held' ? 'graphyard-approver' : null, approvedAt: state === 'held' ? faultAt : null, refusal: null, requestedAt: decisionAt,
  input: decisionInput('requirements', gy1700(faultAt), {
    criteria: [
      { id: 'AC-0', text: 'Soft-accept does not 5xx', proofs: ['unit:webhook-soft-accept-no-5xx'] },
      { id: 'AC-1', text: 'Delivered soft-accept', proofs: ['manual:post-deploy/webhook-soft-accept'] },
    ],
    plannedFiles: files, expectedPolicyRevision: 2,
  }),
});

test('manual:fault-class-decision — intervention-pattern|interventions|2026-10-10T23:16:36.002Z is owned by a hand-filed fault-class item quoting the pattern, not re-filed beside it', () => {
  const owner = {
    title: 'Recurring scope-widening interventions at the build stage',
    description: '21 scope-widening interventions at the build stage in 7 days crossed the threshold of 3',
    origin: { faultClass: { class: 'decision' as const, count: 3, threshold: 3, windowHours: 24, detectedAt: '2026-10-10T23:16:36.002Z', instances: [] } },
  };
  assert.deepEqual(handFiledPatterns(owner), [{ kind: 'scope-widening', stage: 'build' }]);
});

test('manual:fault-class-decision — action:decision|GY-1700|2026-10-11T14:48:22.935Z: a covering no-answers standing revision is adopted, not thrown as a decision fault', async () => {
  assert.equal(standingCoversScopeAsk({ input: { plannedFiles: planned } }, [testFile]), true);
  assert.equal(standingCoversScopeAsk({ input: { plannedFiles: planned.slice(0, 3) } }, [testFile]), false);

  const work = gy1700(faultAt, 'requested');
  const fx = effectsOf(work);
  const { requests, withdrawn, launches } = plane(fx, work, masterStanding('requested'));
  const state = emptyDaemonState(config());
  await runCycle(config(), state, fx, () => Date.parse(faultAt));

  const failed = Object.values(state.actions).filter(action => action.kind === 'decision' && action.state === 'failed' && /left to its requester/.test(action.detail));
  assert.deepEqual(failed, [], 'the covering standing revision is not left to its requester');
  assert.deepEqual(requests, [], 'nothing is requested while the covering revision stands');
  assert.deepEqual(withdrawn, [], 'the covering revision is not withdrawn');
  assert.deepEqual(launches, [], 'no approver is launched for a request the loop did not make');
  assert.ok(Object.values(state.actions).some(action => action.work === 'GY-1700' && action.state === 'done' && /already plans the paths/.test(action.detail)),
    `expected covering-adopt detail, got ${JSON.stringify(Object.values(state.actions).map(a => a.detail))}`);
  assert.deepEqual(state.faults.instances.filter(instance => instance.faultClass === 'decision'), [], 'no decision fault on the covering adopt');
});

test('manual:fault-class-decision — action:escalation|escalation:scope-budget:blocked:GY-1700:4|2026-10-11T15:04:54.952Z: a covering held revision does not breach the blocked bound', async () => {
  // The cycle clock is snapshot.now: first adopt the covering hold while the ask is still inside the
  // bound (as at 14:49Z once the master's revision was held), then advance past fifteen minutes.
  const work = gy1700(faultAt, 'held');
  const fx = effectsOf(work);
  plane(fx, work, masterStanding('held'));
  const state = emptyDaemonState(config());
  await runCycle(config(), state, fx, () => Date.parse(faultAt));

  const watch = Object.values(state.approvals).find(entry => entry.decision === standingId);
  assert.ok(watch?.settledAt, 'the held covering revision is adopted');
  assert.ok(watch?.scope, 'the watch names the scope ask so the blocked bound can leave it out');
  assert.equal(coveringStandingScopeWatch(work, state.approvals), true);
  assert.equal(Object.keys(state.actions).filter(key => key.startsWith('escalation:scope-budget:')).length, 0);

  const later = Date.parse(breachAt);
  const live = { ...work, lease: { ...work.lease!, expiresAt: new Date(later + 60_000).toISOString() }, updatedAt: new Date(later).toISOString() };
  const without = scopeBudget([live], [], later, true);
  assert.equal(without.breaches.length, 1, 'against the base behaviour (no covering watch) the 17-minute wait breaches');
  assert.match(without.breaches[0].detail, /GY-1700 has been blocked on its scope request for 17 minutes/);

  const withCover = scopeBudget([live], [], later, true, state.approvals);
  assert.deepEqual(withCover.breaches, [], 'with the covering watch the blocked bound does not run');
  assert.deepEqual(withCover.open, [], 'the ask is not counted as open against the loop');

  // A cycle at the instance's breach instant still records no scope-budget escalation.
  fx.snapshot = async () => ({ work: [live], now: new Date(later).toISOString(), jobs: [] });
  await runCycle(config(), state, fx, () => later);
  assert.equal(Object.keys(state.actions).filter(key => key.startsWith('escalation:scope-budget:')).length, 0);
});

test('manual:fault-class-decision — a requested foreign revision that does not cover the ask is still left to its requester (GY-1687)', async () => {
  const work = gy1700(faultAt, 'requested');
  const fx = effectsOf(work);
  const { requests, withdrawn } = plane(fx, work, masterStanding('requested', planned.slice(0, 3)));
  const state = emptyDaemonState(config());
  await runCycle(config(), state, fx, () => Date.parse(faultAt));
  assert.deepEqual(withdrawn, [], 'a non-covering master revision is not withdrawn for the live ask');
  assert.deepEqual(requests, [], 'the live widening is not requested while it stands');
  assert.ok(Object.values(state.actions).some(action => action.kind === 'decision' && action.state === 'failed' && /left to its requester/.test(action.detail)),
    'the loop still names the standing revision until it settles');
});

test('unit:covering-standing-scope-watch — only a settled watch that names this ask defers the blocked bound', () => {
  const work = gy1700(faultAt);
  const binding = scopeDecisionBinding(work.scopeRequest!);
  const key = decisionKey(work, { action: 'requirements', binding });
  const approvals = {
    [key]: approvalWatchSchema.parse({
      work: work.key, action: 'requirements', decision: standingId, requestedAt: faultAt, settledAt: faultAt,
      scope: { epoch: 4, at: askedAt, requestedBy: 'graphyard-claude-1', paths: [testFile] },
    }),
  };
  assert.equal(coveringStandingScopeWatch(work, approvals), true);
  assert.equal(coveringStandingScopeWatch(work, { [key]: { ...approvals[key], scope: null } }), false);
  assert.equal(coveringStandingScopeWatch(work, { [key]: { ...approvals[key], settledAt: null } }), false);
});
