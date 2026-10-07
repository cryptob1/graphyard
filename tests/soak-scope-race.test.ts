import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { maxDecisionRequests } from '../src/daemon/decisions.js';
import type { InvariantCheck } from '../src/model/invariants.js';
import type { Work } from '../src/model.js';

/**
 * GY-1484 (review B3). A routed scope ask whose approved widening keeps failing because its request
 * closed before the application is no longer counted toward `maxDecisionRequests`, so the loop asks
 * again until an approval lands. That bound used to cap the repetition, so the loop runs here for two
 * simulated days over one item whose worker's ask is routed to the approver: one approval fails for
 * a counted reason, the next `races` fail only because the request closed (more than the bound), the
 * re-request after one of them is refused by the control plane for a few cycles, and the last
 * approval applies. After every cycle every system invariant holds and the watch's count never
 * reaches the bound. At the end: one decision and one approver launch per judged decision, never one
 * per cycle; each closed-request failure given back exactly once; nothing escalated; and once the
 * widening applied, nothing more requested for the rest of the days.
 */
const minute = 60_000, hour = 60 * minute, day = 24 * hour, start = Date.parse('2026-10-08T00:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const layout = 'src/widget/Layout.tsx', daemon = 'src/daemon/cycle-widget.ts', races = maxDecisionRequests + 2;
const closedOutcomes = ['The scope request this widening answers is no longer open', 'Epoch 1, which asked for this scope, no longer holds the lease'];

test('unit:soak-invariants-hold — over two simulated days a routed scope ask whose approval keeps losing its closed request is re-asked once per failed decision past the request bound, never per cycle, with every invariant holding, nothing escalated, and nothing asked once the widening applies', { timeout: 300_000 }, async () => {
  let now = start;
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], producers: [], run: { intervalSeconds: 600 } }) as MasterConfig;

  // The world: one item in build whose live attempt asked for a file the widening rule refused, and
  // its decisions as the control plane keeps them. The approver judges at its launch.
  const asked = { epoch: 1, at: iso(start - 5 * minute), paths: [daemon], reason: 'AC-1 needs the research worktree, which only the cycle module creates', requestedBy: 'worker',
    decision: { state: 'refused' as const, reason: 'No rule implies src/daemon/cycle-widget.ts', at: iso(start - 4 * minute), decidedBy: 'graphyard' } };
  let plannedFiles = [layout], scopeRequest: typeof asked | null = asked, scopeDecision: unknown = null, judged = 0, refusedDecides = 0;
  const decisions: { id: string; action: string; state: string; input: any; outcome: string | null; approvedBy: string | null; refusal: null; requestedAt: string }[] = [];
  const launches: string[] = [], decideAt: number[] = [];
  const work = (): Work => ({
    id: 'work-GY-1600', key: 'GY-1600', title: 'Widget research', description: '', type: 'feature', priority: 1, dependencies: [], plannedFiles: [...plannedFiles],
    criteria: [{ id: 'AC-1', text: 'The widget layout renders', proofs: ['unit:layout'] }], policy: { checks: ['test'], review: true },
    stage: 'build', ready: true, epoch: 1, revision: 10 + decisions.length, policyRevision: 2 + (scopeRequest ? 0 : 1),
    createdAt: iso(start - hour), updatedAt: iso(now), stageEnteredAt: iso(start - hour), lease: { owner: 'worker', epoch: 1, expiresAt: iso(now + 10 * minute) },
    workspaces: [], submission: null, candidate: null, scenarioRequirements: [], blocker: null, violations: [], evidence: [], observation: null,
    scopeRequest, scopeDecision, gates: [{ name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }],
  } as unknown as Work);

  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), snapshot: async () => ({ work: [work()], now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}), wakeObservation: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    decisions: async () => ({ decisions }),
    decide: async (item: Work, action: string, _reason: string, input?: Record<string, unknown>) => {
      assert.equal(action, 'requirements', `only the routed widening is asked for, not ${action}`);
      assert.deepEqual((input as any).answers, { epoch: asked.epoch, at: asked.at }, 'every request answers the same ask');
      // After the second race the control plane refuses the re-request for a few cycles (a deploy): the watch waits on the retry interval.
      if (judged === 3 && refusedDecides < 3) { refusedDecides++; throw new Error('503 Service Unavailable'); }
      assert.ok(!decisions.some(entry => entry.state === 'requested' || entry.state === 'approved'), 'no request stands while another is asked');
      const id = randomUUID();
      decideAt.push(now);
      decisions.push({ id, action, state: 'requested', input, outcome: null, approvedBy: null, refusal: null, requestedAt: iso(now) });
      return { id, state: 'requested' };
    },
    withdraw: async (_item: Work, decision: string) => { const entry = decisions.find(each => each.id === decision); if (entry?.state === 'requested') entry.state = 'withdrawn'; },
    // The approver approves every time. The first application fails on a policy revision (counted);
    // the next `races` fail only because the ask closed under them; the last applies.
    approver: async (_item: Work, decision: string) => {
      const entry = decisions.find(each => each.id === decision)!;
      launches.push(decision);
      judged++;
      Object.assign(entry, { approvedBy: 'graphyard-approver' });
      if (judged === 1) Object.assign(entry, { state: 'failed', outcome: 'Policy revision changed (now 3); reload and request again' });
      else if (judged <= races + 1) Object.assign(entry, { state: 'failed', outcome: closedOutcomes[judged % 2] });
      else {
        Object.assign(entry, { state: 'applied', outcome: 'Requirements revised' });
        plannedFiles = [layout, daemon];
        scopeDecision = { state: 'approved', reason: 'Additive and required by AC-1', at: iso(now), decidedBy: 'graphyard-approver', paths: [daemon], requestedBy: asked.requestedBy, requestedAt: asked.at, epoch: asked.epoch, waitedMs: now - Date.parse(asked.at) };
        scopeRequest = null;
      }
      return { agentName: `gy-approver-${decision.slice(0, 8)}`, pane: null };
    },
    persist: async () => {},
  } as unknown as DaemonEffects;

  const state: DaemonState = emptyDaemonState(config);
  const escalations: string[] = [], violations: string[] = [], counts: number[] = [], requestsOf = new Map<string, number>(), refusedWindow = new Set<string | null>();
  let settledAt: number | null = null;
  for (let cycle = 0; now < start + 2 * day; cycle++, now += 2 * minute) {
    const result = await runCycle(config, state, effects, () => now);
    for (const action of result.actions) if (action.kind === 'escalation') escalations.push(action.detail ?? '');
    for (const check of state.invariants.report as InvariantCheck[]) if (!check.holds) violations.push(`cycle ${cycle}: ${check.line}`);
    for (const watch of Object.values(state.approvals).filter(entry => entry.work === 'GY-1600' && entry.action === 'requirements')) {
      assert.ok(watch.requests < maxDecisionRequests, `cycle ${cycle}: the watch counts ${watch.requests} requests, reaching the bound`);
      assert.equal(watch.exhaustedAt, null, `cycle ${cycle}: the watch was never exhausted`);
      counts.push(watch.requests);
      if (!requestsOf.has(watch.decision)) requestsOf.set(watch.decision, watch.requests);
      // While the re-request is refused, the failed decision's watch stays and is read again each cycle.
      if (refusedDecides && refusedDecides < 3) refusedWindow.add(watch.givenBack);
    }
    if (settledAt === null && !scopeRequest) settledAt = now;
  }

  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  // The refused re-request waits the widening retry interval of any refused action, so the widening applies within hours, not days.
  assert.ok(settledAt !== null && settledAt < start + 4 * hour, `the widening applied within four hours, at ${settledAt && iso(settledAt)}`);
  assert.deepEqual(plannedFiles, [layout, daemon]);
  assert.equal(judged, races + 2, `${judged} judgements: one counted failure, ${races} closed-request races, one application`);
  // One decision and one approver launch per judged decision: the re-request is once per failure, never per cycle.
  assert.equal(decisions.length, judged, `${decisions.length} decisions requested`);
  assert.deepEqual(launches, decisions.map(entry => entry.id), 'one approver launch per decision, in order');
  assert.equal(refusedDecides, 3, 'the refused re-request was retried on its interval');
  // Each closed-request failure is given back once, whatever the cycles in between: the count stays at
  // the counted failure plus the request standing, through the refused re-requests too.
  const raced = decisions.filter(entry => closedOutcomes.includes(entry.outcome ?? '')).map(entry => entry.id);
  assert.deepEqual(decisions.map(entry => requestsOf.get(entry.id)), [1, ...decisions.slice(1).map(() => 2)], 'every request after the counted failure counts two: each race was given back once, none twice');
  assert.deepEqual([...refusedWindow], [raced[1]], 'through the refused re-requests the watch kept the one failure it gave back');
  assert.ok(counts.every(count => count >= 1 && count <= 2), `the count never drops under the standing request nor grows per race: ${[...new Set(counts)].join(', ')}`);
  assert.equal(counts.at(-1), 2, 'the counted failure still counts at the end');
  // The scope-liveness line names the wait while the ask stands (one action, its detail kept current); no decision is escalated as unjudged or spent.
  assert.deepEqual(escalations.filter(detail => /GY-1600/.test(detail) && !/blocked on its scope request for \d+ minutes/.test(detail)), [], 'no decision was escalated for the item');
  assert.ok(Object.keys(state.actions).filter(key => key.startsWith('escalation:') && key.includes('work-GY-1600')).every(key => !/decision/.test(key)), 'no decision escalation stands');
  assert.ok(decideAt.every(at => at <= settledAt!), 'nothing was asked once the widening applied');
});
