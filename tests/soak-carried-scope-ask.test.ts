import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { InvariantCheck } from '../src/model/invariants.js';
import type { Work } from '../src/model.js';
import { scopeRefusalBlocker, type ScopeRequestState } from '../src/model/scope.js';

/**
 * GY-1568 (review). GY-1520's worker asked for a file, the rule refused, the loop routed the ask —
 * and the worker submitted seconds later. The ended attempt carried the ask, but the loop read only
 * live asks, withdrew the routed decision as one the item had moved past, and a master widened by
 * hand: a scope-widening intervention. The carried ask is now routed every cycle on every open item,
 * so the real loop runs here for three simulated days over several items whose attempts ended with
 * their ask still with the approver: one already had its decision requested while the attempt lived
 * (GY-1520's order), the others are routed only after the attempt ended. The approver judges each a
 * few minutes after its launch — approving all but two, which it refuses. Three items are claimed by
 * a fresh attempt before the approver answers (review on 4eceac56): the claim inherits the ask under
 * its own epoch, and the routed decision must still be the one standing. After every cycle every
 * system invariant holds. At the end: exactly one decision and one approver launch per ask, never a
 * withdrawal and never a re-request; every approved ask widened by its decision and the refused ones
 * left unplanned; the loop never widened on its own; and nothing asked once every ask was answered.
 */
const minute = 60_000, hour = 60 * minute, day = 24 * hour, start = Date.parse('2026-10-08T00:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const layout = 'src/widget/Layout.tsx';
const judgeAfter = 6 * minute;

type Decision = { id: string; action: string; state: string; input: any; outcome: string | null; approvedBy: string | null; refusal: string | null; requestedAt: string; requestedBy: string };
// `asked` is the ask attempt 1 made; `open` while no answer applied; `claimAt` when attempt 2 claims the item, inheriting the ask.
type Item = { key: string; plannedFiles: string[]; asked: ScopeRequestState; open: boolean; scopeDecision: any; policyRevision: number; refuse: boolean; claimAt: number | null };

test('unit:soak-carried-scope-ask — over three simulated days asks carried past their attempts\' end keep one routed decision and one approver launch each, never withdrawn or re-asked, with every invariant holding, until the approver answers each', { timeout: 300_000 }, async () => {
  let now = start;
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], producers: [], run: { intervalSeconds: 600 } }) as MasterConfig;

  // The world: items in build whose attempt 1 asked for a file the widening rule refused and then
  // ended (submitted or released) before any approver judged it, so the ask is carried to the item.
  const ask = (n: number): ScopeRequestState => ({ epoch: 1, at: iso(start - (5 + n) * minute), paths: [`src/daemon/cycle-widget-${n}.ts`], reason: 'AC-1 needs the cycle module', requestedBy: 'worker',
    decision: { state: 'refused', reason: `No rule implies src/daemon/cycle-widget-${n}.ts`, at: iso(start - (4 + n) * minute), decidedBy: 'graphyard' } } as ScopeRequestState);
  // GY-1605..1607 are claimed by attempt 2 two minutes in, after the loop routed their ask and before the approver judges it.
  const items: Item[] = [0, 1, 2, 3, 4, 5, 6, 7].map(n => ({ key: `GY-${1600 + n}`, plannedFiles: [layout], asked: ask(n), open: true, scopeDecision: null, policyRevision: 2, refuse: n === 3 || n === 6, claimAt: n >= 5 ? start + 2 * minute : null }));
  const decisions = new Map<string, Decision[]>(items.map(item => [item.key, []]));
  // GY-1520's order: the loop routed GY-1600's and GY-1607's ask while the attempt lived, then the worker submitted.
  for (const item of [items[0], items[7]]) decisions.get(item.key)!.push({ id: randomUUID(), action: 'requirements', state: 'requested', input: { answers: { epoch: 1, at: item.asked.at }, plannedFiles: [layout, item.asked.paths[0]], expectedPolicyRevision: 2 },
    outcome: null, approvedBy: null, refusal: null, requestedAt: iso(start - 4 * minute), requestedBy: 'graphyard-master-project' });
  const claimed = (item: Item) => item.claimAt !== null && now >= item.claimAt;
  // A claim inherits the carried ask as its own, keeping the epoch that asked it (engine inheritedScopeRequest).
  const inherited = (item: Item): ScopeRequestState => ({ ...item.asked, epoch: 2, askedEpoch: 1,
    decision: item.open ? { ...item.asked.decision!, epoch: 2 } : { ...item.scopeDecision, epoch: 2 } } as ScopeRequestState);

  const launches: { key: string; decision: string; at: number }[] = [], requested: { key: string; at: number }[] = [], withdrawals: string[] = [], widened: string[] = [];
  const view = (item: Item): Work => ({
    id: `work-${item.key}`, key: item.key, title: 'Widget research', description: '', type: 'feature', priority: 1, dependencies: [], plannedFiles: [...item.plannedFiles],
    criteria: [{ id: 'AC-1', text: 'The widget layout renders', proofs: ['unit:layout'] }], policy: { checks: ['test'], review: true },
    stage: 'build', ready: true, epoch: claimed(item) ? 2 : 1, revision: 10 + (decisions.get(item.key)!.length), policyRevision: item.policyRevision,
    createdAt: iso(start - hour), updatedAt: iso(now), stageEnteredAt: iso(start - hour), lease: claimed(item) ? { owner: 'worker-2', epoch: 2, expiresAt: iso(now + hour) } : null,
    workspaces: [], submission: null, candidate: null, scenarioRequirements: [], violations: [], evidence: [], observation: null,
    // An approved ask is cleared; a refused one an attempt holds stays its request, carrying the refusal and its blocker.
    blocker: claimed(item) && !item.open && item.refuse ? `${scopeRefusalBlocker} by the independent approver graphyard-approver: Not implied by the criteria` : null,
    scopeRequest: claimed(item) && (item.open || item.refuse) ? inherited(item) : null, carriedScopeRequest: !claimed(item) && item.open ? item.asked : null, scopeDecision: item.scopeDecision, gates: [{ name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }],
  } as unknown as Work);
  // Each approver session is working until it has judged its decision, as herdr reports it.
  const working = () => launches.filter(launch => decisions.get(launch.key)!.find(each => each.id === launch.decision)?.state === 'requested')
    .map(launch => ({ name: `gy-approver-${launch.decision.slice(0, 8)}`, agent_status: 'working' }));
  const of = (work: Work) => items.find(item => item.key === work.key)!;
  // The approver judges a decision a few minutes after its launch, as an approver session does.
  const judge = () => {
    for (const launch of launches) {
      const item = items.find(entry => entry.key === launch.key)!, entry = decisions.get(item.key)!.find(each => each.id === launch.decision)!;
      if (entry.state !== 'requested' || now < launch.at + judgeAfter) continue;
      // The control plane attaches an answer only to the ask it names (server answerScopeRequest, engine requirements).
      assert.deepEqual(entry.input.answers, { epoch: 1, at: item.asked.at }, `${item.key}: the decision answers the ask attempt 1 made`);
      const answered = { reason: item.refuse ? 'Not implied by the criteria' : 'Additive and required by AC-1', at: iso(now), decidedBy: 'graphyard-approver', paths: item.asked.paths, requestedBy: 'worker', requestedAt: item.asked.at, epoch: claimed(item) ? 2 : 1, waitedMs: now - Date.parse(item.asked.at) };
      item.open = false;
      if (item.refuse) { Object.assign(entry, { state: 'refused', refusal: 'Not implied by the criteria' }); item.scopeDecision = { state: 'refused', ...answered }; continue; }
      Object.assign(entry, { state: 'applied', approvedBy: 'graphyard-approver', outcome: 'Requirements revised' });
      item.plannedFiles = entry.input.plannedFiles; item.policyRevision++;
      item.scopeDecision = { state: 'approved', ...answered };
    }
  };

  const effects = {
    agents: () => [], herdr: () => ({ agents: working(), available: true }), credentials: async () => ({}), snapshot: async () => { judge(); return { work: items.map(view), now: iso(now) }; },
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}), wakeObservation: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    decisions: async (work: Work) => ({ decisions: decisions.get(work.key) ?? [] }),
    decide: async (work: Work, action: string, _reason: string, input?: Record<string, unknown>) => {
      assert.equal(action, 'requirements', `only the routed widening is asked for, not ${action}`);
      const item = of(work);
      assert.ok(item.open, `${work.key}: a decision is asked only while its ask stands`);
      assert.deepEqual((input as any).answers, { epoch: 1, at: item.asked.at }, 'the request answers the ask attempt 1 made, carried or inherited');
      const id = randomUUID();
      requested.push({ key: work.key, at: now });
      decisions.get(work.key)!.push({ id, action, state: 'requested', input, outcome: null, approvedBy: null, refusal: null, requestedAt: iso(now), requestedBy: 'graphyard-master-project' });
      return { id, state: 'requested' };
    },
    withdraw: async (work: Work, decision: string, reason: string) => { withdrawals.push(`${work.key}: ${reason}`); const entry = decisions.get(work.key)!.find(each => each.id === decision); if (entry?.state === 'requested') entry.state = 'withdrawn'; },
    approver: async (work: Work, decision: string) => { launches.push({ key: work.key, decision, at: now }); return { agentName: `gy-approver-${decision.slice(0, 8)}`, pane: null }; },
    widenScope: async (work: Work) => { widened.push(work.key); return {}; },
    persist: async () => {},
  } as unknown as DaemonEffects;

  const state: DaemonState = emptyDaemonState(config);
  const violations: string[] = [];
  let answeredAt: number | null = null;
  for (let cycle = 0; now < start + 3 * day; cycle++, now += 2 * minute) {
    await runCycle(config, state, effects, () => now);
    for (const check of state.invariants.report as InvariantCheck[]) if (!check.holds) violations.push(`cycle ${cycle}: ${check.line}`);
    if (answeredAt === null && items.every(item => !item.open)) answeredAt = now;
  }

  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(withdrawals, [], 'no routed decision of a carried ask was withdrawn as one the item moved past');
  assert.deepEqual(widened, [], 'the loop never widened a carried ask itself: the approver judges it');
  // One decision per ask: GY-1600's stood from before its attempt ended, the others were routed once each.
  for (const item of items) assert.equal(decisions.get(item.key)!.length, 1, `${item.key}: ${decisions.get(item.key)!.length} decisions for one ask`);
  assert.deepEqual(requested.map(entry => entry.key).sort(), ['GY-1601', 'GY-1602', 'GY-1603', 'GY-1604', 'GY-1605', 'GY-1606'], 'the asks carried before any decision were each routed once; GY-1600 and GY-1607 kept their standing one');
  for (const entry of requested.filter(each => ['GY-1605', 'GY-1606'].includes(each.key))) assert.ok(entry.at < start + 2 * minute, `${entry.key} was routed before attempt 2 claimed it, so the claim had a decision to keep`);
  assert.deepEqual(launches.map(entry => entry.key).sort(), items.map(item => item.key).sort(), 'one approver launch per ask, never one per cycle');
  assert.ok(answeredAt !== null && answeredAt < start + hour, `every carried ask was answered within the hour, at ${answeredAt && iso(answeredAt)}`);
  for (const item of items) {
    const [decision] = decisions.get(item.key)!;
    if (item.refuse) {
      assert.deepEqual([decision.state, item.plannedFiles], ['refused', [layout]], `${item.key}: the refused ask stays unplanned`);
      assert.equal((item.scopeDecision as any)?.state, 'refused');
    } else {
      assert.equal(decision.state, 'applied', `${item.key}: its approval applied as the late answer`);
      assert.deepEqual(item.plannedFiles, [layout, item.asked.paths[0]], `${item.key}: widened by the approver's decision`);
      assert.equal((item.scopeDecision as any)?.decidedBy, 'graphyard-approver');
    }
  }
  assert.ok(requested.every(entry => entry.at <= answeredAt!), 'nothing was asked once every ask was answered');
});
