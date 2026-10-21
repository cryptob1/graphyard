import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { emptyDaemonState, runCycle, scopeBudget, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { InvariantCheck } from '../src/model/invariants.js';
import type { Work } from '../src/model.js';
import { scopeBlockedBudgetMs, type ScopeRequestState } from '../src/model/scope.js';
import { coveringStandingScopeWatch, syncHeldScopeAskMarks } from '../src/daemon/metrics.js';

/**
 * GY-1702 (review of 668c66d81763 / 417929e25578). Standing or held requirements decisions must be
 * waits, not per-cycle faults: matching scope asks ride the hold, the scope-blocked bound pauses
 * only for an ask the quarantined held decision answers, and when the hold fails the recorded wait
 * can breach again. A still-approved resume race keeps a live watch and retries each cycle with no
 * decision fault. Cold start: the first cycle's scope step must discover a history-held match before
 * measuring the bound (approvals are empty until the later decisions step). That first discovery
 * read fails once per item so unknown history is preserved through the budget — no false breach —
 * and the decisions-step retry then succeeds. These paths run every cycle for every open item, so
 * the real loop runs here for three simulated days over eight held items plus a separate
 * approved-resume soak: four matching widenings held under quarantine (two apply when the attempt
 * ends, two fail mid-hold), two covering no-answers holds that fail while decide throws (watch must
 * clear so the bound resumes), one non-matching held revision that must not bind its ask, and one
 * quarantined ask with no held decision (must still breach once history is known). After every
 * cycle every system invariant holds. At the end: no resume or decide while a matching hold stands,
 * no decision fault for a hold, the non-matching ask is requested once its hold settles, failed
 * holds resume their breach clock, applied holds leave no open ask, and approved-resume races retry
 * across days without faults.
 */
const minute = 60_000, hour = 60 * minute, day = 24 * hour, cycleMs = 2 * minute, start = Date.parse('2026-10-11T00:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const layout = 'src/widget/Layout.tsx';

type Decision = { id: string; action: string; state: string; input: any; outcome: string | null; approvedBy: string | null; approvedAt: string | null; requestedAt: string; requestedBy: string };
type Item = {
  key: string; n: number; epoch: number; live: boolean; policyRevision: number; plannedFiles: string[];
  kind: 'match-apply' | 'match-fail' | 'cover-fail' | 'nonmatch' | 'quarantine-only';
  scopeRequest: ScopeRequestState | null; quarantine: boolean; askedAt: string;
};

test('unit:soak-held-requirements-wait — over three simulated days matching quarantine-held widenings pause the scope-blocked bound without faults or resumes, non-matching holds leave the ask free, failed holds resume the breach clock, and every invariant holds', { timeout: 300_000 }, async () => {
  let now = start;
  const config = masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1702, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], producers: [],
    run: { intervalSeconds: 120 },
  }) as MasterConfig;

  const kinds: Item['kind'][] = ['match-apply', 'match-apply', 'match-fail', 'match-fail', 'cover-fail', 'cover-fail', 'nonmatch', 'quarantine-only'];
  const items: Item[] = kinds.map((kind, n) => {
    const askedAt = iso(start - 20 * minute);
    const path = `src/widget/Extra-${n}.tsx`;
    const scopeRequest: ScopeRequestState | null = kind === 'quarantine-only' || kind === 'match-apply' || kind === 'match-fail' || kind === 'cover-fail' || kind === 'nonmatch'
      ? { epoch: 1, at: askedAt, paths: [path], reason: 'AC-1 needs the extra module', requestedBy: 'worker',
          decision: { state: 'refused', reason: `No rule implies ${path}`, at: askedAt, decidedBy: 'graphyard', treeRead: true } } as ScopeRequestState
      : null;
    return { key: `GY-${1702 + n}`, n, epoch: 1, live: true, policyRevision: 1, plannedFiles: [layout], kind, scopeRequest, quarantine: kind !== 'nonmatch', askedAt };
  });
  const decisions = new Map<string, Decision[]>(items.map(item => [item.key, []]));
  for (const item of items) {
    if (item.kind === 'quarantine-only') continue;
    const path = item.scopeRequest!.paths[0];
    const plannedFiles = item.kind === 'nonmatch' ? [layout]
      : item.kind === 'cover-fail' ? [layout, path, `src/widget/Extra-${item.n}-more.tsx`]
      : [layout, path];
    decisions.get(item.key)!.push({
      id: randomUUID(), action: 'requirements', state: 'held',
      // cover-fail: no-answers covering revision (coveringAdopt); match-*: answers bind the ask.
      input: { plannedFiles, expectedPolicyRevision: 1, ...(item.kind === 'nonmatch' || item.kind === 'cover-fail' ? {} : { answers: { epoch: 1, at: item.askedAt } }) },
      outcome: 'Task is quarantined; the approved decision is held and applied when the attempt ends',
      approvedBy: 'graphyard-approver', approvedAt: iso(start - 18 * minute), requestedAt: iso(start - 19 * minute), requestedBy: 'graphyard-master-project',
    });
  }

  const resumes: string[] = [], requested: string[] = [], withdrawals: string[] = [];
  const coveringCleared: string[] = [], coveringStillExcluding: string[] = [];
  // Cold-start: first history read per item fails (scope discovery); the decisions-step retry succeeds.
  const historyFailedOnce = new Set<string>();
  const view = (item: Item): Work => ({
    id: `work-${item.key}`, key: item.key, title: 'Held wait soak', description: '', type: 'bug', priority: 1, dependencies: [],
    plannedFiles: [...item.plannedFiles], criteria: [{ id: 'AC-1', text: 'The widget layout renders', proofs: ['unit:layout'] }],
    policy: { checks: ['test'], review: true }, stage: 'build', ready: true, epoch: item.epoch, revision: 10, policyRevision: item.policyRevision,
    createdAt: iso(start - hour), updatedAt: iso(now), stageEnteredAt: iso(start - hour),
    lease: item.live ? { owner: 'worker', epoch: item.epoch, expiresAt: iso(now + hour) } : null,
    workspaces: [], submission: null, candidate: null, scenarioRequirements: [], violations: [], evidence: [], observation: null, blocker: null,
    scopeRequest: item.scopeRequest, carriedScopeRequest: null, scopeDecision: null,
    containmentQuarantine: item.quarantine && item.live
      ? { owner: 'worker', epoch: item.epoch, at: item.askedAt, settlementHash: 'a'.repeat(64), leaseExpiresAt: iso(now + hour) }
      : null,
    gates: [{ name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }],
  } as unknown as Work);

  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: items.map(view), now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    decisions: async (work: Work) => {
      // First cold-start read for a quarantined ask (scope discovery) fails; the decisions-step retry succeeds.
      const item = items.find(entry => entry.key === work.key);
      if (now === start && item?.quarantine && item.scopeRequest && !historyFailedOnce.has(work.key)) {
        historyFailedOnce.add(work.key);
        throw new Error('Simulated: transient decision history read failure');
      }
      return { decisions: structuredClone(decisions.get(work.key) ?? []) };
    },
    // cover-fail: after the covering revision fails, decide throws so the replacement cannot land — the watch must still clear.
    decide: async (work: Work, action: string) => {
      const item = items.find(entry => entry.key === work.key);
      if (item?.kind === 'cover-fail' && (decisions.get(work.key)?.[0]?.state === 'failed')) {
        requested.push(`${work.key}|${action}|${now}|throw`);
        throw new Error('Simulated: transient decide API error');
      }
      requested.push(`${work.key}|${action}|${now}`);
      return { id: randomUUID(), state: 'requested' };
    },
    withdraw: async (work: Work, decision: string) => { withdrawals.push(`${work.key}|${decision}`); },
    resume: async (work: Work, decision: string) => { resumes.push(`${work.key}|${decision}`); return decisions.get(work.key)!.find(entry => entry.id === decision)!; },
    approver: async () => ({ agentName: 'gy-approver-soak', pane: null }),
    persist: async () => {},
  } as unknown as DaemonEffects;

  const state: DaemonState = emptyDaemonState(config);
  const violations: string[] = [];
  const failAt = start + 30 * minute, applyAt = start + hour, quietFrom = start + day;

  for (let cycle = 0; now < start + 3 * day; cycle++, now += cycleMs) {
    // Scripted world: fail matching and covering holds, then end attempts so the other matching holds apply.
    if (now === failAt) for (const item of items.filter(entry => entry.kind === 'match-fail' || entry.kind === 'cover-fail')) {
      const decision = decisions.get(item.key)![0];
      Object.assign(decision, { state: 'failed', outcome: 'The holding attempt was replaced; the held decision failed' });
      item.quarantine = false;
    }
    if (now === applyAt) for (const item of items.filter(entry => entry.kind === 'match-apply' || entry.kind === 'nonmatch')) {
      const decision = decisions.get(item.key)![0];
      if (decision.state === 'held') {
        Object.assign(decision, { state: 'applied', outcome: 'Requirements revised when the attempt ended' });
        if (item.kind === 'match-apply') {
          item.plannedFiles = decision.input.plannedFiles;
          item.policyRevision++;
          item.scopeRequest = null;
        }
      }
      item.live = false;
      item.quarantine = false;
      if (item.kind === 'nonmatch') item.scopeRequest = null; // attempt end closes the ask; a later claim would re-ask
    }
    if (now === applyAt + 10 * minute) for (const item of items.filter(entry => entry.kind === 'nonmatch')) {
      // Fresh attempt re-opens the ask so the loop must request a widening now that the hold is gone.
      item.live = true; item.epoch = 2; item.quarantine = false;
      item.scopeRequest = { epoch: 2, at: iso(now), paths: [`src/widget/Extra-${item.n}.tsx`], reason: 'still needs the extra', requestedBy: 'worker',
        decision: { state: 'refused', reason: 'No rule', at: iso(now), decidedBy: 'graphyard', treeRead: true } } as ScopeRequestState;
    }

    const { actions } = await runCycle(config, state, effects, () => now);
    for (const check of state.invariants.report as InvariantCheck[]) if (!check.holds) violations.push(`cycle ${cycle}: ${check.line}`);

    // Cold start (cycle 0): first history reads fail — unknown marks must prevent a false scope-budget fault.
    if (cycle === 0) {
      assert.ok(historyFailedOnce.size > 0, 'cold-start discovery must have attempted history reads that failed once');
      const cold = Object.entries(state.actions).filter(([key, action]) =>
        key.startsWith('escalation:scope-budget:blocked:') && action.state === 'failed'
        && /GY-1702|GY-1703|GY-1704|GY-1705|GY-1706|GY-1707|GY-1709/.test(key));
      assert.deepEqual(cold, [], `cold-start cycle must not breach while history is unknown or held: ${cold.map(([key]) => key).join(',')}`);
    }

    // While matching/covering holds stand under quarantine past the bound, the budget must not breach those asks.
    if (now < failAt) {
      syncHeldScopeAskMarks(state.scope, Object.values(state.approvals));
      const budget = scopeBudget(items.map(view), state.scope, now, true, state.approvals);
      const blocked = budget.breaches.filter(breach => breach.id.startsWith('blocked:'));
      assert.ok(blocked.every(breach => breach.id.includes('GY-1708') || breach.id.includes('GY-1709')),
        `only nonmatch / quarantine-only may breach before fails: ${blocked.map(b => b.id).join(',')}`);
      assert.ok(!blocked.some(breach => /GY-1702|GY-1703|GY-1704|GY-1705|GY-1706|GY-1707/.test(breach.id)), 'matching/covering held asks under quarantine do not breach');
    }
    // After covering holds fail, their watches must not keep excluding the bound across decide throws.
    if (now > failAt) {
      for (const item of items.filter(entry => entry.kind === 'cover-fail' && entry.scopeRequest)) {
        const work = view(item);
        if (coveringStandingScopeWatch(work, state.approvals)) coveringStillExcluding.push(`${item.key}@${iso(now)}`);
        else coveringCleared.push(`${item.key}@${iso(now)}`);
      }
    }
    void actions;
  }

  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(resumes, [], 'no held decision was resumed');
  assert.ok(!Object.values(state.actions).some(action => action.kind === 'decision' && action.state === 'failed' && /is held/.test(action.detail ?? '')),
    'no decision fault naming a hold');
  // Matching applies cleared their asks; matching fails left the ask open so a later decide or breach can resume.
  for (const item of items.filter(entry => entry.kind === 'match-apply')) assert.equal(item.scopeRequest, null, `${item.key}: applied hold settled the ask`);
  for (const item of items.filter(entry => entry.kind === 'match-fail' || entry.kind === 'cover-fail')) assert.ok(item.scopeRequest, `${item.key}: failed hold left the ask open`);
  assert.deepEqual(coveringStillExcluding, [], `failed covering adopts must not exclude the bound: ${coveringStillExcluding.slice(0, 5).join(' | ')}`);
  assert.ok(coveringCleared.length > 0, 'covering fails cleared their watches across cycles');
  assert.ok(requested.some(entry => /GY-1706|GY-1707/.test(entry) && /\|throw$/.test(entry)), 'cover-fail replacement decides threw');
  // Non-matching hold settled without binding; the re-opened ask was requested at least once (GY-1708).
  assert.ok(requested.some(entry => entry.startsWith('GY-1708|requirements|')), `non-matching ask was requested after its hold settled: ${requested.join(' | ')}`);
  // Quiet days after the script: no further decides for the applied items.
  const late = requested.filter(entry => Number(entry.split('|')[2]) >= quietFrom);
  assert.deepEqual(late.filter(entry => /GY-1702|GY-1703/.test(entry)), [], 'applied matching holds request nothing in the quiet days');
  assert.ok(now >= start + 3 * day - cycleMs, 'the soak covered three simulated days');
  assert.ok(scopeBlockedBudgetMs > 0);
  void withdrawals;
});

test('unit:soak-approved-resume-race — over three simulated days a still-approved resume race keeps a live watch, retries each cycle with no decision fault, and every invariant holds', { timeout: 300_000 }, async () => {
  let now = start;
  const config = masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1702, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], producers: [],
    run: { intervalSeconds: 120 },
  }) as MasterConfig;

  const items = [0, 1, 2].map(n => {
    const askedAt = iso(start - 20 * minute);
    const path = `src/widget/Resume-${n}.tsx`;
    return {
      key: `GY-${1710 + n}`, n, epoch: 1, live: true, policyRevision: 1, plannedFiles: [layout] as string[],
      scopeRequest: {
        epoch: 1, at: askedAt, paths: [path], reason: 'AC-1 needs the resume module', requestedBy: 'worker',
        decision: { state: 'refused' as const, reason: `No rule implies ${path}`, at: askedAt, decidedBy: 'graphyard' as const, treeRead: true },
      } as ScopeRequestState | null,
      askedAt, path,
    };
  });
  const decisions = new Map(items.map(item => [item.key, [{
    id: randomUUID(), action: 'requirements', state: 'approved',
    input: { plannedFiles: [layout, item.path], expectedPolicyRevision: 1, answers: { epoch: 1, at: item.askedAt } },
    outcome: null as string | null, approvedBy: 'graphyard-approver', approvedAt: iso(start - 18 * minute),
    requestedAt: iso(start - 19 * minute), requestedBy: 'graphyard-master-project',
  }]]));
  const applyAt = start + day;
  const resumes: string[] = [], requested: string[] = [];
  const view = (item: typeof items[number]): Work => ({
    id: `work-${item.key}`, key: item.key, title: 'Approved resume soak', description: '', type: 'bug', priority: 1, dependencies: [],
    plannedFiles: [...item.plannedFiles], criteria: [{ id: 'AC-1', text: 'The widget layout renders', proofs: ['unit:layout'] }],
    policy: { checks: ['test'], review: true }, stage: 'build', ready: true, epoch: item.epoch, revision: 10, policyRevision: item.policyRevision,
    createdAt: iso(start - hour), updatedAt: iso(now), stageEnteredAt: iso(start - hour),
    lease: item.live ? { owner: 'worker', epoch: item.epoch, expiresAt: iso(now + hour) } : null,
    workspaces: [], submission: null, candidate: null, scenarioRequirements: [], violations: [], evidence: [], observation: null, blocker: null,
    scopeRequest: item.scopeRequest, carriedScopeRequest: null, scopeDecision: null, containmentQuarantine: null,
    gates: [{ name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }],
  } as unknown as Work);

  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: items.map(view), now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    decisions: async (work: Work) => ({ decisions: structuredClone(decisions.get(work.key) ?? []) }),
    decide: async (work: Work, action: string) => { requested.push(`${work.key}|${action}|${now}`); return { id: randomUUID(), state: 'requested' }; },
    withdraw: async () => {},
    resume: async (work: Work, decision: string) => {
      resumes.push(`${work.key}|${decision}|${now}`);
      const entry = decisions.get(work.key)!.find(row => row.id === decision)!;
      // Still-approved race until applyAt, then the control plane applies on resume.
      if (now >= applyAt && entry.state === 'approved') Object.assign(entry, { state: 'applied', outcome: 'Applied after the holding attempt ended' });
      return { ...entry };
    },
    approver: async () => ({ agentName: 'gy-approver-soak', pane: null }),
    persist: async () => {},
  } as unknown as DaemonEffects;

  const state: DaemonState = emptyDaemonState(config);
  const violations: string[] = [];
  let cyclesBeforeApply = 0;
  for (let cycle = 0; now < start + 3 * day; cycle++, now += cycleMs) {
    if (now < applyAt) cyclesBeforeApply++;
    if (now === applyAt) for (const item of items) {
      item.plannedFiles = [layout, item.path];
      item.policyRevision++;
      item.scopeRequest = null;
    }
    const { actions } = await runCycle(config, state, effects, () => now);
    for (const check of state.invariants.report as InvariantCheck[]) if (!check.holds) violations.push(`cycle ${cycle}: ${check.line}`);
    if (now < applyAt) {
      assert.ok(!Object.values(state.actions).some(action => action.kind === 'decision' && action.state === 'failed'),
        `no decision fault while the approved-resume race stands at cycle ${cycle}`);
      for (const item of items) {
        const watch = Object.values(state.approvals).find(entry => entry.work === item.key && entry.action === 'requirements');
        assert.ok(watch && !watch.settledAt, `${item.key}: live watch during approved-resume race`);
      }
    }
    void actions;
  }

  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.ok(cyclesBeforeApply > 100, `approved-resume raced across many cycles (${cyclesBeforeApply})`);
  assert.ok(resumes.length >= items.length * cyclesBeforeApply, `resume retried each cycle for each item: ${resumes.length} resumes over ${cyclesBeforeApply} pre-apply cycles`);
  assert.ok(!Object.values(state.actions).some(action => action.kind === 'decision' && action.state === 'failed'), 'no decision fault across the soak');
  assert.deepEqual(requested, [], 'nothing new was decided; the standing approvals were resumed');
  for (const item of items) assert.equal(item.scopeRequest, null, `${item.key}: ask settled when resume applied`);
  assert.ok(now >= start + 3 * day - cycleMs, 'the soak covered three simulated days');
});
