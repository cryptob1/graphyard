import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { emptyDaemonState, runCycle, scopeBudget, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { scopeRoutineDecision } from '../src/daemon/decisions.js';
import {
  approvedResumePendingDetail, clearCoveringAdoptIfGone, coveringPlannedFiles, coveringStandingScopeWatch,
  discoverHeldScopeAskMarks, heldAdoptWatch, heldDecisionNamedIn, heldDecisionRefusal, markHeldScopeAsk, samePlannedFiles,
  staleRevisionDecideNote, staleRevisionDecideRefusal, standingRequirementsAnswersAsk, syncHeldScopeAskMarks,
} from '../src/daemon/metrics.js';
import { approvalWatchSchema } from '../src/daemon/state.js';
import { decisionKey } from '../src/daemon/reconcile.js';
import { scopeDecisionBinding } from '../src/model/scope.js';
import { decisionInput, masterConfigSchema, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { liveLeaseRevisionRefusal } from '../src/model/approval.js';
import { scopeBlockedBudgetMs } from '../src/model/scope.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// Fixture stamps are absolute 2026-10-11 instants the classifiers and harness receive as data; no wall-clock reading remains in this file.

/**
 * GY-1702. A requirements decision that stands requested or approved-and-held must be a wait, not a
 * per-cycle fault: adopt it, bind a matching scope ask, hold the scope-blocked breach while quarantine
 * holds the decision, and treat a stale-revision decide refuse as a re-compute — never a decision fault.
 */

const repository = 'owner/standing-held-wait';
const operator: Principal = { id: 'wait-operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'wait-implementer', role: 'worker', sessionKind: 'ai' };
const coordinator: Principal = { id: 'wait-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, implementer, coordinator].map(principal => ({ ...principal, token: `wait-${principal.id}-${'x'.repeat(32)}` }));
const master = { id: 'wait-master', token: `wait-master-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements'] };
const approver = { id: 'graphyard-approver-graphyard', token: `wait-approver-${'a'.repeat(32)}`, capabilities: ['decision:approve', 'policy:requirements'] };
const token = (principal: Principal) => credentials.find(entry => entry.id === principal.id)!.token;
const layout = 'src/widget/Layout.tsx', helper = 'src/widget/measure.ts', extra = 'src/widget/extra.ts', widgetDir = 'src/widget/';
const fixtureNow = '2026-10-11T15:00:00.000Z';

let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const call = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const result = await call(credential, method, path, body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const decisions = async (work: Work) => (await ok(master.token, 'GET', `work/${work.key}/decisions`)).decisions as any[];

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1702;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('standing-held-wait'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('standing_held_wait');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/standing_held_wait`); await store.init();
  engine = new Engine(store, 300, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  for (const agent of [master, approver])
    await ok(token(operator), 'POST', 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Standing/held wait fixture' });
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

async function claimed(title: string, paths = [layout]) {
  let work = await ok(master.token, 'POST', 'work', { title, plannedFiles: paths, criteria: [{ id: 'AC-1', text: 'The widget layout renders', proofs: ['unit:layout'] }], reason: 'Standing/held wait fixture' }) as Work;
  work = await ok(master.token, 'POST', `work/${work.id}/ready`, { expectedRevision: work.revision, reason: 'Ready' }) as Work;
  return engine.execute(implementer, 'claim', work.id, {}, randomUUID());
}

const loopConfig = () => masterConfigSchema.parse({
  version: 1, url, credentialFile: join(tmpdir(), 'standing-held-wait-coordinator.token'), cliPath: join(process.cwd(), 'bin/graphyard.mjs'),
  repository, baseBranch: 'main', githubAppId: 1702, hostId: 'wait-host', masterAgentName: 'graphyard-master-standing-held',
  workers: [{ name: 'worker', principal: implementer.id, agentName: 'graphyard-worker-wait', mode: 'existing' }],
}) as MasterConfig;

function harness(options: { resume?: DaemonEffects['resume'] } = {}) {
  const sessions: HerdrAgent[] = [], launched: string[] = [], resumes: string[] = [], decided: { key: string; action: string; reason: string; input: any }[] = [];
  const effects: DaemonEffects = {
    agents: () => sessions,
    herdr: () => ({ agents: sessions, available: true }),
    credentials: async () => ({}),
    snapshot: async () => { const snapshot = await ok(token(coordinator), 'GET', 'work-snapshot'); return { work: snapshot.work as Work[], now: snapshot.now }; },
    closeSession: pane => { sessions.splice(0, sessions.length, ...sessions.filter(agent => agent.pane_id !== pane)); },
    dispatch: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: fixtureNow, reason: 'no deployment endpoint', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    decideScope: (work, _nonRepository, treeRead) => ok(token(coordinator), 'POST', `work/${work.id}/autoscope`, { epoch: work.scopeRequest!.epoch, ...(treeRead ? { treeRead } : {}) }) as Promise<Work>,
    repositoryFiles: async () => new Set([layout, helper, extra]),
    reviewFindings: async () => [],
    basePaths: async () => new Set<string>(),
    widenScope: async () => ({}),
    decide: async (work, action, reason, input = {}) => {
      decided.push({ key: work.key, action, reason, input });
      return ok(master.token, 'POST', `work/${work.id}/decide`, { action, input: decisionInput(action, work, input), reason });
    },
    resume: options.resume ?? (async (work, decision) => {
      resumes.push(`${work.key}:${decision}`);
      return ok(master.token, 'POST', `work/${work.id}/decide`, { action: 'resume', decision });
    }),
    approver: async (work, decision) => {
      const agentName = `gy-approver-${decision.slice(0, 8)}`, pane = `pane-${launched.length + 1}`;
      launched.push(decision); sessions.push({ name: agentName, pane_id: pane, agent_status: 'working' } as HerdrAgent);
      return { agentName, pane };
    },
    decisions: work => ok(master.token, 'GET', `work/${encodeURIComponent(work.id)}/decisions`),
    withdraw: (work, decision, reason) => ok(master.token, 'POST', `work/${work.id}/decide`, { action: 'withdraw', decision, reason }),
    persist: async () => {},
  };
  return {
    effects, sessions, launched, resumes, decided,
    cycle: (state: DaemonState) => runCycle(loopConfig(), state, effects),
  };
}

// ---- Pure classifiers (AC-1 / AC-2 / AC-4 unit surface) ----------------------------------------

test('unit:standing-requirements-adopted-no-fault — a covering plannedFiles standing decision answers the scope ask; a held or stale-revision refuse is classified, not faulted', () => {
  const at = '2026-10-11T14:47:50.740Z';
  const decision = scopeRoutineDecision({
    key: 'GY-1700', stage: 'build', policyRevision: 2, plannedFiles: [layout],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:layout'] }],
    scopeRequest: { epoch: 4, at, paths: [helper], reason: 'needed', requestedBy: 'worker',
      decision: { state: 'refused', reason: 'No rule implies it', at, decidedBy: 'graphyard', treeRead: true } },
    lease: { owner: 'worker', epoch: 4, expiresAt: '2026-10-11T16:00:00.000Z' },
  } as Work, Date.parse('2026-10-11T14:48:00.000Z'), true)!;
  assert.equal(decision.action, 'requirements');
  assert.ok(decision.input?.answers, 'when the loop requests, input.answers names the ask');
  assert.deepEqual(decision.input!.answers, { epoch: 4, at });
  assert.ok(standingRequirementsAnswersAsk({ input: { plannedFiles: decision.input!.plannedFiles } }, decision), 'same plannedFiles with no answers still answers the ask');
  assert.ok(standingRequirementsAnswersAsk({ input: { plannedFiles: [...(decision.input!.plannedFiles as string[])].reverse() } }, decision), 'the same paths in another order still answer the ask');
  assert.ok(standingRequirementsAnswersAsk({ input: { plannedFiles: [layout, helper, extra] } }, decision), 'a covering superset answers the ask');
  assert.ok(standingRequirementsAnswersAsk({ input: { plannedFiles: [widgetDir] } }, decision), 'a broader directory entry that contains every asked path answers the ask');
  assert.ok(!standingRequirementsAnswersAsk({ input: { plannedFiles: [layout] } }, decision), 'a different file list that does not cover the ask does not');
  assert.ok(samePlannedFiles(decision.input!.plannedFiles, decision.input!.plannedFiles));
  assert.ok(samePlannedFiles([layout, helper], [helper, layout]), 'plannedFiles compare as a set, not by array order');
  assert.ok(!samePlannedFiles([layout, helper], [layout]));
  assert.ok(coveringPlannedFiles([layout, helper, extra], [layout, helper]));
  assert.ok(coveringPlannedFiles([widgetDir], [layout, helper]));
  assert.ok(!coveringPlannedFiles([layout], [layout, helper]));
  const held = new Error('Graphyard refused work/x/decide (409): Decision 9a6095d9-c3e5-4357-93d6-48b8ccc61e5e (requirements) on GY-1700 was approved by graphyard-approver-graphyard at 2026-10-11T14:49:13.944Z and is held (Task is quarantined); the control plane applies it in the transaction that ends the attempt, so it need not be requested again');
  assert.ok(heldDecisionRefusal(held));
  assert.equal(heldDecisionNamedIn(held), '9a6095d9-c3e5-4357-93d6-48b8ccc61e5e');
  assert.ok(staleRevisionDecideRefusal(new Error('Graphyard refused work/x/decide (409): Policy revision changed (now 3); reload and request again')));
  assert.ok(staleRevisionDecideRefusal(new Error('Policy revision changed; reload and request again')));
  assert.ok(!staleRevisionDecideRefusal(new Error('Policy revision changed; reload before revising')));
  assert.match(staleRevisionDecideNote, /moved past the revision/);
});

test('unit:scope-budget-holds-during-quarantine-held-decision — a routed ask answered by a quarantined held decision does not breach; quarantine alone, or a hold that does not answer the ask, does not pause', () => {
  const askedAt = '2026-10-11T14:47:50.740Z';
  const later = Date.parse(askedAt) + scopeBlockedBudgetMs + 60_000;
  const request = { epoch: 4, at: askedAt, paths: [helper], reason: 'needed', requestedBy: 'worker',
    decision: { state: 'refused' as const, reason: 'No rule', at: askedAt, decidedBy: 'graphyard' as const, treeRead: true } };
  const base = {
    id: 'work-1700', key: 'GY-1700', stage: 'build' as const, plannedFiles: [layout],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:layout'] }],
    lease: { owner: 'worker', epoch: 4, expiresAt: new Date(later + 60_000).toISOString() },
    scopeRequest: request,
  };
  const held = { ...base, containmentQuarantine: { owner: 'worker', epoch: 4, at: askedAt, settlementHash: 'a'.repeat(64), leaseExpiresAt: new Date(later + 60_000).toISOString() } } as unknown as Work;
  const free = { ...base, containmentQuarantine: null } as unknown as Work;
  const measured: [] = [];
  // Quarantine alone is not enough: without a held decision answering this ask, the bound still breaches.
  assert.equal(scopeBudget([held], measured, later, true).breaches.length, 1, 'quarantine with no matching held decision still breaches');
  markHeldScopeAsk(measured, 'GY-1700', 4, askedAt);
  const paused = scopeBudget([held], measured, later, true);
  assert.equal(paused.open.length, 1);
  assert.equal(paused.open[0].heldByQuarantine, true);
  assert.equal(paused.breaches.length, 0, 'matching held decision under quarantine holds the breach clock; the wait is still recorded');
  assert.ok(paused.open[0].waitedMs > scopeBlockedBudgetMs);
  const resumed = scopeBudget([free], measured, later, true);
  assert.equal(resumed.breaches.length, 1, 'once the hold ends without settling the ask, the recorded wait can breach');
  assert.match(resumed.breaches[0].detail, /with the independent approver/);
});

test('unit:scope-budget-holds-during-quarantine-held-decision — cold start discovers a history-held match before the budget measures, so an empty approvals map does not breach', async () => {
  const askedAt = '2026-10-11T14:47:50.740Z';
  const later = Date.parse(askedAt) + scopeBlockedBudgetMs + 60_000;
  const request = { epoch: 4, at: askedAt, paths: [helper], reason: 'needed', requestedBy: 'worker',
    decision: { state: 'refused' as const, reason: 'No rule', at: askedAt, decidedBy: 'graphyard' as const, treeRead: true } };
  const item = {
    id: 'work-1700-cold', key: 'GY-1700', stage: 'build' as const, plannedFiles: [layout],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:layout'] }],
    lease: { owner: 'worker', epoch: 4, expiresAt: new Date(later + 60_000).toISOString() },
    scopeRequest: request,
    containmentQuarantine: { owner: 'worker', epoch: 4, at: askedAt, settlementHash: 'a'.repeat(64), leaseExpiresAt: new Date(later + 60_000).toISOString() },
  } as unknown as Work;
  const measured: [] = [];
  // Empty approvals (daemon restart): sync alone leaves the ask unmarked.
  syncHeldScopeAskMarks(measured, []);
  assert.equal(scopeBudget([item], measured, later, true, {}).breaches.length, 1, 'without discovery an old routed ask breaches');
  await discoverHeldScopeAskMarks(measured, [item], later, true, async () => ({
    decisions: [{ action: 'requirements', state: 'held', input: { plannedFiles: [layout, helper] } }],
  }));
  assert.equal(scopeBudget([item], measured, later, true, {}).breaches.length, 0, 'discovery marks the ask before measuring');
  // A non-covering hold must not pause the bound.
  const other: [] = [];
  await discoverHeldScopeAskMarks(other, [item], later, true, async () => ({
    decisions: [{ action: 'requirements', state: 'held', input: { plannedFiles: [layout] } }],
  }));
  assert.equal(scopeBudget([item], other, later, true, {}).breaches.length, 1, 'a hold that does not answer the ask still breaches');
});

test('unit:scope-budget-holds-during-quarantine-held-decision — a cold-start history read failure keeps the ask unknown through the budget so it does not false-breach; a later successful empty read resumes the bound', async () => {
  const askedAt = '2026-10-11T14:47:50.740Z';
  const later = Date.parse(askedAt) + scopeBlockedBudgetMs + 60_000;
  const request = { epoch: 4, at: askedAt, paths: [helper], reason: 'needed', requestedBy: 'worker',
    decision: { state: 'refused' as const, reason: 'No rule', at: askedAt, decidedBy: 'graphyard' as const, treeRead: true } };
  const item = {
    id: 'work-1700-unread', key: 'GY-1700', stage: 'build' as const, plannedFiles: [layout],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:layout'] }],
    lease: { owner: 'worker', epoch: 4, expiresAt: new Date(later + 60_000).toISOString() },
    scopeRequest: request,
    containmentQuarantine: { owner: 'worker', epoch: 4, at: askedAt, settlementHash: 'a'.repeat(64), leaseExpiresAt: new Date(later + 60_000).toISOString() },
  } as unknown as Work;
  const measured: [] = [];
  syncHeldScopeAskMarks(measured, []);
  await discoverHeldScopeAskMarks(measured, [item], later, true, async () => { throw new Error('Simulated: transient decision history read failure'); });
  assert.equal(scopeBudget([item], measured, later, true, {}).breaches.length, 0, 'unknown history must not record a scope-budget breach');
  await discoverHeldScopeAskMarks(measured, [item], later, true, async () => ({ decisions: [] }));
  assert.equal(scopeBudget([item], measured, later, true, {}).breaches.length, 1, 'once history is known empty the recorded wait can breach');
});

test('unit:standing-requirements-adopted-no-fault — held adoption preserves a carried registry session until close succeeds', () => {
  const askedAt = '2026-10-11T14:47:50.740Z';
  const item = { key: 'GY-1700', scopeRequest: { epoch: 4, at: askedAt, paths: [helper], reason: 'needed', requestedBy: 'worker' } };
  const decision = {
    action: 'requirements' as const, binding: 'scope:4', input: { plannedFiles: [layout, helper] },
    scope: { epoch: 4, at: askedAt, paths: [helper], requestedBy: 'worker' }, reason: 'widen',
  };
  const carried = approvalWatchSchema.parse({
    work: 'GY-1700', action: 'requirements', decision: '9a6095d9-c3e5-4357-93d6-48b8ccc61e5e',
    requestedAt: askedAt, settledAt: null, session: 'approver:orphan-session', agentName: 'gy-approver-gy-1700',
    closeAttempts: 1, launches: 1,
  });
  const { watch, bound } = heldAdoptWatch(item, {
    id: '9a6095d9-c3e5-4357-93d6-48b8ccc61e5e', approvedBy: 'graphyard-approver',
    outcome: 'Task is quarantined', input: { plannedFiles: [layout, helper] },
  }, decision, carried, askedAt);
  assert.ok(bound);
  assert.equal(watch.session, 'approver:orphan-session');
  assert.equal(watch.agentName, 'gy-approver-gy-1700');
});

test('unit:stale-revision-decide-classified-transient — the decisions-step classifier matches the plane\'s decide refuse and not the requirements revise wording', () => {
  assert.equal(staleRevisionDecideRefusal(new Error('Policy revision changed (now 3); reload and request again')), true);
  assert.equal(staleRevisionDecideRefusal(new Error('Policy revision changed; reload before revising')), false);
  assert.equal(heldDecisionNamedIn(new Error('nope')), null);
  assert.match(approvedResumePendingDetail('GY-1702', 'requirements', '9a6095d9-c3e5-4357-93d6-48b8ccc61e5e', 'graphyard-approver'), /watch stays live and resume is tried again next cycle/);
});

test('integration:approved-resume-race-no-decision-fault — resume returning still-approved keeps a live watch and records done, then resumes again', { timeout: 120_000 }, async () => {
  let work = await claimed('approved resume race');
  const requested = await ok(master.token, 'POST', `work/${work.id}/decide`, {
    action: 'requirements',
    input: decisionInput('requirements', work, { plannedFiles: [layout, helper] }),
    reason: 'Pending requirements decision adds the helper the criterion needs',
  });
  await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: [helper], reason: 'AC-1 needs the measuring helper' });
  await ok(token(coordinator), 'POST', `work/${work.id}/autoscope`, { epoch: work.epoch });
  work = await reload(work.id);
  let resumes = 0;
  const loop = harness({
    resume: async (_target, decision) => {
      resumes += 1;
      return { id: decision, state: 'approved', approvedBy: 'graphyard-approver-graphyard', approvedAt: '2026-10-11T16:00:00.000Z', outcome: null };
    },
  });
  // History reports the standing decision as approved so the loop resumes it; the stub keeps returning approved (lane-rework race).
  const realDecisions = loop.effects.decisions!;
  loop.effects.decisions = async (item) => {
    const body = await realDecisions(item);
    return {
      decisions: body.decisions.map((entry: any) => entry.id === requested.id
        ? { ...entry, state: 'approved', approvedBy: 'graphyard-approver-graphyard', approvedAt: '2026-10-11T16:00:00.000Z' }
        : entry),
    };
  };
  const state = emptyDaemonState(loopConfig());
  await loop.cycle(state);
  const pending = Object.values(state.actions).filter(action => action.work === work.key && action.kind === 'decision' && /watch stays live and resume is tried again next cycle/.test(action.detail ?? ''));
  assert.ok(pending.length >= 1, `expected approved-resume pending detail, got: ${Object.values(state.actions).filter(a => a.work === work.key).map(a => `${a.state}:${a.detail}`).join(' | ')}`);
  assert.ok(pending.every(action => action.state === 'done'), 'the race is recorded done, not failed');
  assert.equal(Object.values(state.actions).filter(action => action.work === work.key && action.kind === 'decision' && action.state === 'failed').length, 0);
  const watch = Object.values(state.approvals).find(entry => entry.decision === requested.id);
  assert.ok(watch && !watch.settledAt, 'the watch stays live');
  const before = resumes;
  assert.ok(before >= 1, 'resume was attempted');
  await loop.cycle(state);
  assert.ok(resumes > before, 'the next cycle resumes again from the live watch');
});

// ---- Integration: held resume / standing adopt / ask settlement / post-apply revision ----------

test('integration:held-decision-no-per-cycle-resume-409 — an approved-and-held requirements decision is a wait (no resume/fault); a non-widening hold does not bind the ask, and when it fails the ask is requested', { timeout: 120_000 }, async () => {
  let work = await claimed('held no resume');
  // A non-widening revision under a live lease settles held (GY-1687); the control plane applies it when the attempt ends.
  const revision = { expectedPolicyRevision: work.policyRevision, criteria: [{ id: 'AC-1', text: 'Works, as the deploy shows', proofs: ['unit:layout'] }], dependencies: [], plannedFiles: work.plannedFiles, exclusiveResources: [] };
  const requested = await ok(master.token, 'POST', `work/${work.id}/decide`, { action: 'requirements', input: revision, reason: 'AC-1 can only be judged on the release' });
  const settled = await ok(approver.token, 'POST', `work/${work.id}/approve`, { decision: requested.id, reason: 'Judged on the release' });
  assert.equal(settled.state, 'held', JSON.stringify(settled));
  assert.match(settled.outcome, new RegExp(liveLeaseRevisionRefusal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // A routed scope ask would otherwise request a second requirements decision; the non-widening hold stands in the way without binding the ask.
  await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: [helper], reason: 'AC-1 needs the measuring helper' });
  await ok(token(coordinator), 'POST', `work/${work.id}/autoscope`, { epoch: work.epoch });
  const loop = harness(), state = emptyDaemonState(loopConfig());
  for (let i = 0; i < 3; i++) await loop.cycle(state);
  assert.deepEqual(loop.resumes, [], 'no resume of a held decision');
  assert.deepEqual(loop.decided.filter(entry => entry.key === work.key), [], 'no second decide while the held one stands');
  const failed = Object.values(state.actions).filter(action => action.work === work.key && action.kind === 'decision' && action.state === 'failed');
  assert.deepEqual(failed, [], `no decision fault: ${failed.map(action => action.detail).join(' | ')}`);
  const adopted = Object.values(state.actions).filter(action => action.work === work.key && /is approved .* and held/.test(action.detail ?? ''));
  assert.ok(adopted.length >= 1, 'the held decision was adopted as a wait');
  assert.ok(adopted.some(action => /does not widen for this scope ask/.test(action.detail ?? '')), 'the non-widening hold is not bound to the ask');
  assert.ok(!Object.values(state.approvals).some(watch => watch.decision === requested.id && watch.scope), 'the ask is not attached to the non-widening hold');
  assert.equal((await decisions(work)).find(entry => entry.id === requested.id)?.state, 'held');

  // End the attempt: the non-widening hold applies; reclaim and re-ask so the loop must request a
  // widening (proving no settled non-widening watch stuck on the ask's binding).
  await engine.execute(implementer, 'release', work.id, { epoch: work.epoch }, randomUUID());
  work = await reload(work.id);
  assert.equal((await decisions(work)).find(entry => entry.id === requested.id)?.state, 'applied');
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: [helper], reason: 'AC-1 still needs the measuring helper after the hold' });
  await ok(token(coordinator), 'POST', `work/${work.id}/autoscope`, { epoch: work.epoch });
  loop.decided.length = 0;
  await loop.cycle(state);
  assert.ok(loop.decided.some(entry => entry.key === work.key && entry.action === 'requirements'), 'after the non-widening hold settled, the still-needed ask is requested');
});

test('integration:routed-ask-settled-by-standing-requirements — a standing same-plannedFiles decision is the ask\'s pending answer and settles the ask when it applies', { timeout: 120_000 }, async () => {
  let work = await claimed('standing answers ask');
  // Master requests the widening without answers (as GY-1700's operator did) before the worker asks.
  const requested = await ok(master.token, 'POST', `work/${work.id}/decide`, {
    action: 'requirements',
    input: decisionInput('requirements', work, { plannedFiles: [layout, helper] }),
    reason: 'Pending requirements decision adds the helper the criterion needs',
  });
  assert.equal(requested.state, 'requested');
  assert.equal(requested.input?.answers, undefined);
  await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: [helper], reason: 'AC-1 needs the measuring helper' });
  await ok(token(coordinator), 'POST', `work/${work.id}/autoscope`, { epoch: work.epoch });
  work = await reload(work.id);
  assert.equal(work.scopeRequest?.decision?.decidedBy, 'graphyard');

  const loop = harness(), state = emptyDaemonState(loopConfig());
  await loop.cycle(state);
  // The standing decision is adopted for the ask — not rejected as "answers no scope request".
  assert.ok(!Object.values(state.actions).some(action => action.work === work.key && /answers no scope request/.test(action.detail ?? '')));
  assert.ok(!loop.decided.some(entry => entry.key === work.key), 'nothing new was requested; the standing one was adopted');
  const watch = Object.values(state.approvals).find(entry => entry.decision === requested.id);
  assert.ok(watch, 'the standing decision is on a watch');
  assert.ok(watch!.scope, 'the watch binds the scope ask');
  assert.equal(watch!.scope!.at, work.scopeRequest!.at);

  await ok(approver.token, 'POST', `work/${work.id}/approve`, { decision: requested.id, reason: 'The helper is the layout criterion spelled out' });
  await loop.cycle(state);
  work = await reload(work.id);
  assert.ok(work.plannedFiles.includes(helper), 'the standing decision applied the widening');
  assert.equal(work.scopeRequest, null, 'the ask settled without a hand master scope');
  assert.equal(work.scopeDecision?.state, 'approved');
  assert.ok(work.lease, 'the attempt kept its lease; settlement did not wait for the attempt to end');
});

test('integration:covering-requested-requirements-answers-ask — a standing no-answers revision that covers the ask (superset) is adopted with no decision fault and settles the ask when it applies', { timeout: 120_000 }, async () => {
  let work = await claimed('covering requested answers ask');
  const requested = await ok(master.token, 'POST', `work/${work.id}/decide`, {
    action: 'requirements',
    input: decisionInput('requirements', work, { plannedFiles: [layout, helper, extra] }),
    reason: 'Pending requirements decision covers the helper and an extra companion',
  });
  assert.equal(requested.input?.answers, undefined);
  await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: [helper], reason: 'AC-1 needs the measuring helper' });
  await ok(token(coordinator), 'POST', `work/${work.id}/autoscope`, { epoch: work.epoch });
  work = await reload(work.id);
  const loop = harness(), state = emptyDaemonState(loopConfig());
  await loop.cycle(state);
  assert.equal(Object.values(state.actions).filter(action => action.work === work.key && action.kind === 'decision' && action.state === 'failed').length, 0,
    `no decision fault for a covering standing revision: ${Object.values(state.actions).filter(a => a.work === work.key).map(a => `${a.state}:${a.detail}`).join(' | ')}`);
  assert.ok(!loop.decided.some(entry => entry.key === work.key), 'the covering standing decision is adopted, not re-requested');
  const watch = Object.values(state.approvals).find(entry => entry.decision === requested.id);
  assert.ok(watch?.scope, 'the covering requested decision binds the ask');
  await ok(approver.token, 'POST', `work/${work.id}/approve`, { decision: requested.id, reason: 'The covering revision answers the helper ask' });
  await loop.cycle(state);
  work = await reload(work.id);
  assert.ok(work.plannedFiles.includes(helper) && work.plannedFiles.includes(extra), 'the covering revision applied');
  assert.equal(work.scopeRequest, null, 'the ask settled from the covering revision');
});

test('integration:covering-held-requirements-binds-ask — a held covering revision binds the ask so quarantine pauses the scope-blocked bound', { timeout: 120_000 }, async () => {
  let work = await claimed('covering held binds ask');
  const requested = await ok(master.token, 'POST', `work/${work.id}/decide`, {
    action: 'requirements',
    input: decisionInput('requirements', work, { plannedFiles: [layout, helper, extra] }),
    reason: 'Covering held revision adds the helper and extra under quarantine',
  });
  await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: [helper], reason: 'AC-1 needs the measuring helper while the covering hold stands' });
  await ok(token(coordinator), 'POST', `work/${work.id}/autoscope`, { epoch: work.epoch });
  work = await reload(work.id);
  // History reports the covering revision as held (quarantine race); the loop must bind the ask, not leave a scope-less watch.
  const loop = harness(), state = emptyDaemonState(loopConfig());
  const realDecisions = loop.effects.decisions!;
  loop.effects.decisions = async (item) => {
    const body = await realDecisions(item);
    return {
      decisions: body.decisions.map((entry: any) => entry.id === requested.id
        ? { ...entry, state: 'held', approvedBy: 'graphyard-approver-graphyard', approvedAt: fixtureNow,
            outcome: 'Task is quarantined; the approved decision is held and applied when the attempt ends' }
        : entry),
    };
  };
  await loop.cycle(state);
  const watch = Object.values(state.approvals).find(entry => entry.decision === requested.id);
  assert.ok(watch && !watch.settledAt, 'the covering held decision stays on a live watch');
  assert.ok(watch!.scope, 'the covering hold binds the ask');
  assert.ok(watch!.ended?.some(entry => entry.includes('held: waiting for the attempt to end')), 'the hold marker is recorded for the budget pause');
  assert.equal(Object.values(state.actions).filter(action => action.work === work.key && action.kind === 'decision' && action.state === 'failed').length, 0,
    `no decision fault: ${Object.values(state.actions).filter(a => a.work === work.key).map(a => `${a.state}:${a.detail}`).join(' | ')}`);
  // Budget pause: quarantine + the held-ask mark from the bound watch.
  markHeldScopeAsk(state.scope, work.key, watch!.scope!.epoch, watch!.scope!.at);
  const quarantined = {
    ...work,
    containmentQuarantine: { owner: implementer.id, epoch: work.epoch, at: work.scopeRequest!.at, settlementHash: 'b'.repeat(64),
      leaseExpiresAt: new Date(Date.parse(work.scopeRequest!.at) + scopeBlockedBudgetMs + 120_000).toISOString() },
  } as Work;
  const later = Date.parse(work.scopeRequest!.at) + scopeBlockedBudgetMs + 60_000;
  assert.equal(scopeBudget([quarantined], state.scope, later, true).breaches.length, 0, 'covering held ask under quarantine does not breach');
});

test('integration:post-apply-decide-uses-applied-revision — after a held decision applies, a stale-revision decide refuse is done (not faulted) and the next cycle re-computes', { timeout: 120_000 }, async () => {
  let work = await claimed('stale after apply');
  const revision = { expectedPolicyRevision: work.policyRevision, criteria: [{ id: 'AC-1', text: 'Works, as the deploy shows', proofs: ['unit:layout'] }], dependencies: [], plannedFiles: work.plannedFiles, exclusiveResources: [] };
  const requested = await ok(master.token, 'POST', `work/${work.id}/decide`, { action: 'requirements', input: revision, reason: 'AC-1 is a live-install reading' });
  // Hold on the live lease, then end the attempt so the hold applies.
  const settled = await ok(approver.token, 'POST', `work/${work.id}/approve`, { decision: requested.id, reason: 'The criterion names the deployed behaviour' });
  assert.equal(settled.state, 'held');
  assert.match(settled.outcome, new RegExp(liveLeaseRevisionRefusal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await engine.execute(implementer, 'release', work.id, { epoch: work.epoch }, randomUUID());
  work = await reload(work.id);
  assert.equal(work.policyRevision, 2, 'the held decision applied when the attempt ended');
  const [applied] = await decisions(work);
  assert.equal(applied.state, 'applied');

  // A loop that still carries the pre-apply revision in its decide input is refused stale; that is no fault.
  const loop = harness(), state = emptyDaemonState(loopConfig());
  // Force a decide against the old revision by posting one the history will refuse as stale when the loop asks again for a new widening.
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: [helper], reason: 'needs helper after the revision' });
  await ok(token(coordinator), 'POST', `work/${work.id}/autoscope`, { epoch: work.epoch });
  // Poison the decide effect once with a stale-revision refuse, as the post-apply retry did on GY-1700.
  let poisoned = false;
  const realDecide = loop.effects.decide!;
  loop.effects.decide = async (item, action, reason, input) => {
    if (!poisoned && action === 'requirements') {
      poisoned = true;
      const err = new Error(`Graphyard refused work/${item.id}/decide (409): Policy revision changed (now ${item.policyRevision}); reload and request again`);
      throw err;
    }
    return realDecide(item, action, reason, input);
  };
  await loop.cycle(state);
  const staleAction = Object.values(state.actions).find(action => action.work === work.key && action.kind === 'decision' && /reload and request again/.test(action.detail ?? ''));
  assert.ok(staleAction, 'the stale-revision refuse was recorded');
  assert.equal(staleAction!.state, 'done', 'not a decision fault');
  assert.match(staleAction!.detail, new RegExp(staleRevisionDecideNote));
  assert.ok(!Object.values(state.actions).some(action => action.work === work.key && action.kind === 'decision' && action.state === 'failed'));

  // Next cycle re-computes against the applied revision and requests cleanly.
  await loop.cycle(state);
  assert.ok(loop.decided.some(entry => entry.key === work.key && entry.action === 'requirements'), 'a fresh request is made against the current revision');
});

test('unit:scope-budget-holds-during-quarantine-held-decision — a failed covering adopt clears its watch so a deferred replacement request cannot keep excluding the blocked bound', async () => {
  const askedAt = '2026-10-11T14:47:50.740Z';
  const standingId = '9a6095d9-c3e5-4357-93d6-48b8ccc61e5e';
  const later = Date.parse(askedAt) + scopeBlockedBudgetMs + 60_000;
  const cfg = masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1702, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [],
  }) as MasterConfig;
  const scope = { epoch: 4, at: askedAt, requestedBy: 'worker', paths: [helper], reason: 'needs helper',
    decision: { state: 'refused' as const, reason: 'No rule', at: askedAt, decidedBy: 'graphyard' as const, treeRead: true } };
  const work = {
    id: 'work-1702', key: 'GY-1702', stage: 'build' as const, plannedFiles: [layout], policyRevision: 1, epoch: 4,
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:layout'] }], title: 't', description: '', type: 'bug' as const, priority: 1,
    dependencies: [], policy: { checks: ['test'], review: true }, revision: 1, ready: true, createdAt: askedAt, updatedAt: askedAt,
    stageEnteredAt: askedAt, lease: { owner: 'worker', epoch: 4, expiresAt: new Date(later + 60_000).toISOString() },
    workspaces: [], submission: null, candidate: null, scenarioRequirements: [], violations: [], evidence: [], observation: null,
    blocker: null, scopeRequest: scope, carriedScopeRequest: null, scopeDecision: null, containmentQuarantine: null,
    gates: [{ name: 'build', passed: false, reasons: ['Worker has not submitted'] }],
  } as unknown as Work;
  const key = decisionKey(work, { action: 'requirements', binding: scopeDecisionBinding(scope) });
  const state = emptyDaemonState(cfg);
  state.approvals[key] = approvalWatchSchema.parse({
    work: work.key, action: 'requirements', decision: standingId, requestedAt: askedAt, coveringAdopt: true, settledAt: null,
    scope: { epoch: 4, at: askedAt, requestedBy: 'worker', paths: [helper] },
  });
  assert.equal(clearCoveringAdoptIfGone(state.approvals, state.scope, key, state.approvals[key], work, { state: 'failed' }, later), true);
  assert.equal(state.approvals[key], undefined);
  assert.equal(coveringStandingScopeWatch(work, state.approvals), false);
  assert.equal(scopeBudget([work], state.scope, later, true, state.approvals).breaches.length, 1);

  // Multi-cycle: held covering adopt → fail → decide throws → watch stays cleared across deferred retries.
  const live = { ...work, updatedAt: new Date(later).toISOString() } as Work;
  const ledger = [{
    id: standingId, action: 'requirements', state: 'held', input: { plannedFiles: [layout, helper, extra], expectedPolicyRevision: 1 },
    outcome: 'held', approvedBy: 'graphyard-approver', approvedAt: askedAt, refusal: null, requestedAt: askedAt, requestedBy: 'graphyard-master',
  }];
  let decideCalls = 0;
  const ask = () => ({ epoch: 4, at: askedAt, requestedBy: 'worker', paths: [helper], reason: 'needs helper',
    decision: { state: 'refused' as const, reason: 'No rule', at: askedAt, decidedBy: 'graphyard' as const, treeRead: true } });
  const at = (clock: number) => ({ ...live, updatedAt: new Date(clock).toISOString(), lease: { ...live.lease!, expiresAt: new Date(clock + 60_000).toISOString() }, scopeRequest: ask() }) as Work;
  const fx = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [at(later)], now: new Date(later).toISOString(), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(later).toISOString(), reason: 'n/a', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    decisions: async () => ({ decisions: structuredClone(ledger) }),
    decide: async () => { decideCalls += 1; throw new Error('Simulated: transient decide API error'); },
    withdraw: async () => {}, resume: async () => ledger[0],
    approver: async () => ({ agentName: 'gy-approver', pane: null }), persist: async () => {},
  } as unknown as DaemonEffects;
  const loop = emptyDaemonState(cfg);
  await runCycle(cfg, loop, fx, () => later);
  assert.equal(coveringStandingScopeWatch(at(later), loop.approvals), true, 'held covering adopt excludes the bound while it stands');
  ledger[0].state = 'failed';
  ledger[0].outcome = 'The holding attempt was replaced';
  const afterFail = later + 120_000;
  fx.snapshot = async () => ({ work: [at(afterFail)], now: new Date(afterFail).toISOString(), jobs: [] });
  await runCycle(cfg, loop, fx, () => afterFail);
  assert.equal(coveringStandingScopeWatch(at(afterFail), loop.approvals), false, 'failed covering adopt no longer excludes the bound');
  assert.ok(!Object.values(loop.approvals).some(watch => watch.work === live.key && watch.coveringAdopt), 'no coveringAdopt watch remains');
  assert.ok(decideCalls >= 1, 'a replacement was attempted');
  const retryAt = afterFail + 120_000;
  fx.snapshot = async () => ({ work: [at(retryAt)], now: new Date(retryAt).toISOString(), jobs: [] });
  await runCycle(cfg, loop, fx, () => retryAt);
  assert.equal(coveringStandingScopeWatch(at(retryAt), loop.approvals), false, 'a failed decide leaves no covering exclusion');
  syncHeldScopeAskMarks(loop.scope, Object.values(loop.approvals));
  const budget = scopeBudget([at(retryAt)], loop.scope, retryAt, true, loop.approvals);
  assert.equal(budget.open.some(entry => entry.key === live.key && !entry.heldByQuarantine), true, 'the ask is open again without a quarantine hold mark');
  assert.equal(budget.breaches.length, 1, 'the ask breaches across deferred replacement retries');
});
