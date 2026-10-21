import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { decisionInput, masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, scopeBudget, type DaemonEffects } from '../src/master-daemon.js';
import { coveringAdoptLeftAskOpen, coveringScopeAdoptWatch, coveringStandingScopeWatch, standingCoversScopeAsk } from '../src/daemon/metrics.js';
import { scopeBlockedBudgetMs, unplannedPaths } from '../src/model/scope.js';
import { handFiledPatterns, type Intervention } from '../src/model/interventions.js';
import { detectPatterns } from '../src/interventions.js';
import type { ScopeRequestState } from '../src/model/scope.js';
import { approvalWatchSchema } from '../src/daemon/state.js';
import { decisionKey } from '../src/daemon/reconcile.js';
import { scopeDecisionBinding } from '../src/model/scope.js';

/**
 * GY-1701 names this file for its proof: manual:fault-class-decision. The master loop filed 3
 * decision faults in 24 hours on 10–11 October 2026:
 *
 * - intervention-pattern|interventions|2026-10-10T23:16:36.002Z — 21 scope-widening interventions
 *   at the build stage in 7 days. Against a fleet with no hand-filed owner the pattern stands for
 *   nobody (base); with GY-1682 quoting the fault it stands and master attention raises nothing.
 *
 * - action:decision|GY-1700|2026-10-11T14:48:22.935Z — the loop threw while putting GY-1700's
 *   scope widening to an approver because requirements decision 9a6095d9… (a master's criteria
 *   rewrite, no `answers`) held the one-at-a-time slot, even though its plannedFiles already
 *   included the test the worker asked for. Base rule pinned below; candidate adopts.
 *
 * - action:escalation|escalation:scope-budget:blocked:GY-1700:4|2026-10-11T15:04:54.952Z — that
 *   ask then waited 17 minutes past the 15-minute blocked bound. Base `scopeBudget` (no covering
 *   watch) breaches; candidate covering watch excludes the ask.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const config = (): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });

const askedAt = '2026-10-11T14:47:50.000Z';
const decisionAt = '2026-10-11T14:47:23.000Z';
const faultAt = '2026-10-11T14:48:22.935Z';
const breachAt = '2026-10-11T15:04:54.952Z';
const patternAt = '2026-10-10T23:16:36.002Z';
const testFile = 'tests/webhook-soft-accept.test.ts';
const planned = ['src/server/routes/github.ts', 'src/server/main.ts', 'docs/protocol/github-webhook.md', testFile];
const standingId = '9a6095d9-c3e5-4357-93d6-48b8ccc61e5e';
const uuid = (name: string) => { const hex = createHash('sha256').update(name).digest('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`; };

/**
 * Base rule at a14965e4ad (cycle-decisions.ts:134-140): a no-answers standing revision always
 * starves the widening — there is no covering-adopt branch — and the throw is recorded as the
 * action:decision fault GY-1700 saw.
 */
function baseStarvesCoveringAsk(standing: { id: string; state: string; input?: { plannedFiles?: readonly string[] | null; answers?: unknown } | null }, ask: { plannedFiles: readonly string[] }) {
  if (standing.input?.answers) return null;
  const other = JSON.stringify(standing.input?.plannedFiles) !== JSON.stringify(ask.plannedFiles) ? 'another planned-files revision' : 'a widening that answers no scope request';
  return `requirements decision ${standing.id} is ${standing.state} for ${other}, not the widening GY-1700's scope request asks for; it is left to its requester, and the control plane holds one at a time, so this one is requested once it settles: graphyard master decisions GY-1700`;
}

/**
 * Base `scopeBudget` at a14965e4ad (metrics.ts:46-65): every open ask counts; there is no
 * `approvals` argument and no covering-watch exclusion.
 */
function baseScopeBudget(work: Work[], now: number, routes = false) {
  const open = work.flatMap(item => {
    const request = item.scopeRequest;
    const routed = routes && request?.decision?.decidedBy === 'graphyard';
    return request && (!request.decision || routed) ? [{ key: item.key, epoch: request.epoch, waitedMs: Math.max(0, now - Date.parse(request.at)), routed }] : [];
  }).sort((a, b) => b.waitedMs - a.waitedMs);
  return {
    open, breaches: open.filter(entry => entry.waitedMs > scopeBlockedBudgetMs)
      .map(entry => ({ id: `blocked:${entry.key}:${entry.epoch}`,
        detail: `${entry.key} has been blocked on its scope request for ${Math.round(entry.waitedMs / 60_000)} minutes, above the ${scopeBlockedBudgetMs / 60_000}-minute bound; ${entry.routed
          ? `its requirements decision is with the independent approver: read it with graphyard master decisions ${entry.key}` : `decide it with graphyard master scope ${entry.key} REASON`}` })),
  };
}

/** GY-1700 as the loop saw it when the action:decision fault was recorded. */
function gy1700(at: string, standingState: 'requested' | 'held' = 'requested'): Work {
  const request: ScopeRequestState = {
    epoch: 4, at: askedAt, paths: [testFile], reason: 'AC-0 needs the soft-accept test', requestedBy: 'graphyard-claude-1',
    decision: { state: 'refused', reason: 'No rule implies tests/webhook-soft-accept.test.ts', at: askedAt, decidedBy: 'graphyard', treeRead: true, waitedMs: 0, paths: [testFile], requestedBy: 'graphyard-claude-1', requestedAt: askedAt, epoch: 4 },
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

type Ledgered = { id: string; action: string; state: string; input: any; reason: string; outcome: string | null; approvedBy: string | null; approvedAt: string | null; refusal: { approver: string; reason: string; at: string } | null; requestedAt: string };
function plane(effects: DaemonEffects, work: Work, standing: Ledgered) {
  const ledger = new Map<string, Ledgered[]>([[work.key, [standing]]]);
  const requests: { action: string; input: any }[] = [], withdrawn: string[] = [], launches: string[] = [];
  Object.assign(effects, {
    herdr: () => ({ available: true, agents: [] }),
    decisions: async (item: Work) => ({ decisions: structuredClone(ledger.get(item.key) ?? []) }),
    decide: async (_item: Work, action: string, _reason: string, input: Record<string, unknown> = {}) => {
      const id = '00000000-0000-4000-8000-00000000scope';
      const entry: Ledgered = { id, action, state: 'requested', input: decisionInput(action, work, input), reason: _reason, outcome: null, approvedBy: null, approvedAt: null, refusal: null, requestedAt: work.updatedAt };
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
    closeSession: () => {}, dispatch: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: work.updatedAt, reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    decide: async () => ({ id: 'unused' }), decisions: async () => ({ decisions: [] }),
    approver: async () => ({ agentName: 'graphyard-approver', pane: 'pane-1' }), persist: async () => {},
  };
}

const masterStanding = (state: 'requested' | 'held' | 'refused', files = planned): Ledgered => ({
  id: standingId, action: 'requirements', state, reason: 'Add AC-0 and post-deploy proofs', outcome: state === 'held' ? 'held for live attempt' : state === 'refused' ? 'refused' : null,
  approvedBy: state === 'held' ? 'graphyard-approver' : null, approvedAt: state === 'held' ? faultAt : null,
  refusal: state === 'refused' ? { approver: 'graphyard-approver', reason: 'criteria rewrite not needed', at: breachAt } : null, requestedAt: decisionAt,
  input: decisionInput('requirements', gy1700(faultAt), {
    criteria: [
      { id: 'AC-0', text: 'Soft-accept does not 5xx', proofs: ['unit:webhook-soft-accept-no-5xx'] },
      { id: 'AC-1', text: 'Delivered soft-accept', proofs: ['manual:post-deploy/webhook-soft-accept'] },
    ],
    plannedFiles: files, expectedPolicyRevision: 2,
  }),
});

// ---- intervention-pattern|interventions|2026-10-10T23:16:36.002Z --------------------------------

test('manual:fault-class-decision — intervention-pattern|interventions|2026-10-10T23:16:36.002Z: against the base no item stands; on the candidate the hand-filed owner stands and the pattern is not re-filed', () => {
  // 21 widenings strictly before the fault's instant (detectPatterns excludes requestedAt >= now).
  const interventions: Intervention[] = Array.from({ length: 21 }, (_, index) => ({
    id: `scope-widening:${uuid(`i-${index}`)}:${index}`, kind: 'scope-widening', source: 'ledger',
    work: { id: uuid(`w-${index}`), key: `GY-${1600 + index}`, title: `Item ${index}` }, stage: 'build',
    blocked: 'files outside plannedFiles', trigger: 'operator-widening',
    requestedAt: new Date(Date.parse(patternAt) - (index + 1) * 60_000).toISOString(),
    resolvedAt: new Date(Date.parse(patternAt) - (index + 1) * 60_000).toISOString(), waitedMs: 0, resolvedBy: 'graphyard-master', resolution: 'widened',
    sources: [{ seq: index, kind: 'requirements' }],
  }));
  const policy = { threshold: 3, windowDays: 7 };
  // Base: no hand-filed fault-class owner — the pattern crosses with nobody standing (the 23:16Z fault).
  const base = detectPatterns(interventions, [], policy, patternAt).find(row => row.kind === 'scope-widening' && row.stage === 'build')!;
  assert.equal(base.count, 21, `base fold counts every instance in the window (got ${base.count})`);
  assert.ok(base.unlinked.length >= policy.threshold, 'against the base 21 unlinked widenings cross the threshold of 3');
  assert.equal(base.item, null, 'against the base no item stands for the pattern');
  assert.equal(base.unlinked.length, 21);

  // Candidate: GY-1682 quotes the fault line, so handFiledPatterns owns the pair and the scan opens nothing beside it.
  const owner = {
    id: uuid('GY-1682'), key: 'GY-1682', stage: 'build' as const, type: 'bug' as const, priority: 1,
    title: 'Scope-widening build-stage interventions crossed the pattern threshold (21 in 7 days) and no item stands for the pattern',
    description: 'Evidence: intervention-pattern fault 2026-10-10T23:16:36.002Z records 21 scope-widening interventions at the build stage in 7 days, past the threshold of 3, with no item standing for the pattern and the server promising to open one within a minute.',
    origin: { faultClass: { class: 'decision' as const, count: 3, instances: [], threshold: 3, windowHours: 24, detectedAt: patternAt } },
  } as unknown as Work;
  assert.deepEqual(handFiledPatterns(owner), [{ kind: 'scope-widening', stage: 'build' }]);
  const owned = detectPatterns(interventions, [owner], policy, patternAt).find(row => row.kind === 'scope-widening' && row.stage === 'build')!;
  assert.equal(owned.item?.key, 'GY-1682', 'on the candidate the hand-filed owner stands for the pattern');
  assert.equal(owned.unlinked.length, 21, 'the fold still counts every instance; ownership does not hide them');
  assert.ok(owned.unlinked.length >= policy.threshold, 'the threshold still judges the count; the owner prevents a second filing beside it');
});

// ---- action:decision|GY-1700|2026-10-11T14:48:22.935Z -------------------------------------------

test('manual:fault-class-decision — action:decision|GY-1700|2026-10-11T14:48:22.935Z: base starves a covering no-answers revision; candidate adopts it unsettled', async () => {
  assert.equal(standingCoversScopeAsk({ input: { plannedFiles: planned } }, [testFile]), true);
  assert.equal(unplannedPaths(planned, [testFile]).length, 0);

  // Base: the covering revision still throws the exact starvation GY-1700 recorded.
  const baseThrow = baseStarvesCoveringAsk({ id: standingId, state: 'requested', input: { plannedFiles: planned } }, { plannedFiles: [...planned.slice(0, 3), testFile] });
  assert.match(baseThrow!, /requirements decision 9a6095d9-c3e5-4357-93d6-48b8ccc61e5e is requested for a widening that answers no scope request/);
  assert.match(baseThrow!, /left to its requester/);

  const work = gy1700(faultAt, 'requested');
  const fx = effectsOf(work);
  const { requests, withdrawn, launches, ledger } = plane(fx, work, masterStanding('requested'));
  const state = emptyDaemonState(config());
  await runCycle(config(), state, fx, () => Date.parse(faultAt));

  const failed = Object.values(state.actions).filter(action => action.kind === 'decision' && action.state === 'failed' && /left to its requester/.test(action.detail));
  assert.deepEqual(failed, [], 'the covering standing revision is not left to its requester');
  assert.deepEqual(requests, [], 'nothing is requested while the covering revision stands');
  assert.deepEqual(withdrawn, [], 'the covering revision is not withdrawn');
  assert.deepEqual(launches, [], 'no approver is launched for a request the loop did not make');
  assert.ok(Object.values(state.actions).some(action => action.work === 'GY-1700' && action.state === 'done' && /already plans the paths/.test(action.detail)),
    `expected covering-adopt detail, got ${JSON.stringify(Object.values(state.actions).map(a => a.detail))}`);
  const watch = Object.values(state.approvals).find(entry => entry.decision === standingId);
  assert.ok(watch?.scope, 'the watch names the scope ask');
  assert.equal(watch?.coveringAdopt, true, 'the watch is marked coveringAdopt, not an ordinary widening');
  assert.equal(watch?.settledAt, null, 'a requested covering revision stays under supervision until held, applied or refused');
  assert.equal(coveringStandingScopeWatch(work, state.approvals), true);
  assert.deepEqual(state.faults.instances.filter(instance => instance.faultClass === 'decision'), [], 'no decision fault on the covering adopt');
  assert.equal(ledger.get('GY-1700')![0].state, 'requested');
});

// ---- action:escalation|escalation:scope-budget:blocked:GY-1700:4|... -----------------------------

test('manual:fault-class-decision — action:escalation|escalation:scope-budget:blocked:GY-1700:4|2026-10-11T15:04:54.952Z: base scopeBudget breaches; candidate covering watch does not', async () => {
  const work = gy1700(faultAt, 'held');
  const later = Date.parse(breachAt);
  const live = { ...work, lease: { ...work.lease!, expiresAt: new Date(later + 60_000).toISOString() }, updatedAt: new Date(later).toISOString() };

  // Base: pinned scopeBudget with no covering exclusion — the 17-minute wait breaches exactly as recorded.
  const base = baseScopeBudget([live], later, true);
  assert.equal(base.breaches.length, 1, 'against the base the 17-minute wait breaches');
  assert.match(base.breaches[0].detail, /GY-1700 has been blocked on its scope request for 17 minutes/);

  const fx = effectsOf(work);
  plane(fx, work, masterStanding('held'));
  const state = emptyDaemonState(config());
  await runCycle(config(), state, fx, () => Date.parse(faultAt));

  const watch = Object.values(state.approvals).find(entry => entry.decision === standingId);
  assert.equal(watch?.settledAt, null, 'held covering stays unsettled so status keeps the covering decision until apply');
  assert.ok(watch?.scope, 'the watch names the scope ask so the blocked bound can leave it out');
  assert.equal(watch?.coveringAdopt, true);
  assert.equal(coveringStandingScopeWatch(work, state.approvals), true);
  assert.equal(Object.keys(state.actions).filter(key => key.startsWith('escalation:scope-budget:')).length, 0);

  const withCover = scopeBudget([live], [], later, true, state.approvals);
  assert.deepEqual(withCover.breaches, [], 'with the covering watch the blocked bound does not run');
  assert.deepEqual(withCover.open, [], 'the ask is not counted as open against the loop');

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

test('manual:fault-class-decision — a refused covering revision clears the adopted watch so the ask is not stranded', async () => {
  const work = gy1700(faultAt, 'requested');
  const fx = effectsOf(work);
  const { ledger } = plane(fx, work, masterStanding('requested'));
  const state = emptyDaemonState(config());
  await runCycle(config(), state, fx, () => Date.parse(faultAt));
  const watch = Object.values(state.approvals).find(entry => entry.decision === standingId)!;
  assert.equal(watch.settledAt, null);
  assert.equal(coveringStandingScopeWatch(work, state.approvals), true);

  // Approver refuses the master's covering revision before the next cycle's clock so the outcome is not pending.
  const refusedAt = '2026-10-11T15:00:00.000Z';
  const later = Date.parse(breachAt);
  ledger.get('GY-1700')![0].state = 'refused';
  ledger.get('GY-1700')![0].refusal = { approver: 'graphyard-approver', reason: 'criteria rewrite not needed', at: refusedAt };
  ledger.get('GY-1700')![0].outcome = 'refused';
  assert.equal(coveringAdoptLeftAskOpen(watch, work, ledger.get('GY-1700')![0], later), true);

  const live = { ...work, lease: { ...work.lease!, expiresAt: new Date(later + 60_000).toISOString() }, updatedAt: new Date(later).toISOString() };
  fx.snapshot = async () => ({ work: [live], now: new Date(later).toISOString(), jobs: [] });
  // Herdr lists the hand approver so supervise can bind and see the refusal.
  fx.herdr = () => ({ available: true, agents: [{ name: 'graphyard-approver', agent_status: 'done', pane_id: 'pane-1' }] });
  Object.assign(watch, { agentName: 'graphyard-approver' });
  await runCycle(config(), state, fx, () => later);

  assert.equal(state.approvals[decisionKey(work, { action: 'requirements', binding: scopeDecisionBinding(work.scopeRequest!) })], undefined,
    'the covering watch is cleared after refusal');
  assert.equal(coveringStandingScopeWatch(live, state.approvals), false);
  // Past the blocked bound with no covering watch, the base breach shape is visible again until a fresh widening is requested.
  assert.equal(baseScopeBudget([live], later, true).breaches.length, 1);
});

test('unit:covering-standing-scope-watch — only a coveringAdopt watch that names this ask defers the blocked bound', () => {
  const work = gy1700(faultAt);
  const binding = scopeDecisionBinding(work.scopeRequest!);
  const key = decisionKey(work, { action: 'requirements', binding });
  const scope = { epoch: 4, at: askedAt, requestedBy: 'graphyard-claude-1', paths: [testFile] };
  const ordinary = {
    [key]: approvalWatchSchema.parse({
      work: work.key, action: 'requirements', decision: '00000000-0000-4000-8000-00000000scope', requestedAt: faultAt, settledAt: null, scope,
    }),
  };
  assert.equal(coveringStandingScopeWatch(work, ordinary), false, 'an ordinary widening watch with scope does not suppress the bound');
  const unsettled = {
    [key]: approvalWatchSchema.parse({
      work: work.key, action: 'requirements', decision: standingId, requestedAt: faultAt, settledAt: null, coveringAdopt: true, scope,
    }),
  };
  assert.equal(coveringStandingScopeWatch(work, unsettled), true, 'requested covering adopt excludes the bound while supervised');
  assert.equal(coveringStandingScopeWatch(work, { [key]: { ...unsettled[key], settledAt: faultAt } }), true, 'held covering adopt excludes the bound');
  assert.equal(coveringStandingScopeWatch(work, { [key]: { ...unsettled[key], scope: null } }), false);
  const cover = coveringScopeAdoptWatch(work, { id: standingId, state: 'requested', input: { plannedFiles: planned } },
    { action: 'requirements', scope, input: { answers: { epoch: 4, at: askedAt } } }, faultAt);
  assert.equal(cover?.settledAt, null);
  assert.equal(cover?.coveringAdopt, true);
  assert.equal(coveringScopeAdoptWatch(work, { id: standingId, state: 'held', approvedBy: 'a', approvedAt: faultAt, input: { plannedFiles: planned } },
    { action: 'requirements', scope, input: { answers: { epoch: 4, at: askedAt } } }, faultAt)?.settledAt, null,
    'held covering adopts stay unsettled for status and supervise');
});

test('manual:fault-class-decision — closing the scope ask drops the covering watch without withdrawing the master revision', async () => {
  const work = gy1700(faultAt, 'requested');
  const fx = effectsOf(work);
  const { withdrawn, ledger } = plane(fx, work, masterStanding('requested'));
  const state = emptyDaemonState(config());
  await runCycle(config(), state, fx, () => Date.parse(faultAt));
  assert.ok(Object.values(state.approvals).some(entry => entry.decision === standingId && entry.coveringAdopt && !entry.settledAt));

  // Worker resolves the ask while the master's covering revision is still requested.
  const closed = { ...work, scopeRequest: null, updatedAt: breachAt, lease: { ...work.lease!, expiresAt: new Date(Date.parse(breachAt) + 60_000).toISOString() } };
  fx.snapshot = async () => ({ work: [closed], now: breachAt, jobs: [] });
  await runCycle(config(), state, fx, () => Date.parse(breachAt));

  assert.deepEqual(withdrawn, [], 'the master covering revision is not withdrawn because the ask ended');
  assert.equal(ledger.get('GY-1700')![0].state, 'requested', 'the foreign revision still stands for its own requester');
  assert.equal(Object.values(state.approvals).find(entry => entry.decision === standingId), undefined, 'the covering watch is dropped');
});
