import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { emptyDaemonState, runCycle, scopeBudget, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { approverSessionName, masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { InvariantCheck } from '../src/model/invariants.js';
import type { Work } from '../src/model.js';
import { liveLeaseRevisionRefusal } from '../src/model/approval.js';
import type { ScopeRequestState } from '../src/model/scope.js';
import { coveringStandingScopeWatch } from '../src/daemon/metrics.js';
import { scopeBlockedBudgetMs } from '../src/model/scope.js';

/**
 * GY-1687 (review of 086e327d7695). A requirements decision approved while its item holds a live attempt is `held`
 * by the control plane and applied by the transaction that ends the attempt. The loop reads that state on every
 * cycle, on both watch kinds: the hand watch of a `master approver` session (cycle-approvers.ts), and the loop's own
 * request path when a routine `requirements` decision — a routed scope ask — finds the held one standing
 * (cycle-decisions.ts); the step's own `held` branch (decisions.ts approvalStep) is reached by no routed request, since the
 * loop requests only widenings, which are never held, and is pinned by the unit test instead. Repeated per cycle, per item
 * and per head, that handling must stay bounded, so the real
 * loop runs here for three simulated days over eight items whose attempts each hold a decision, end in every way
 * (a completed head, a release, a lapse), and are claimed and held again on a second head; one is widened by hand
 * while held, so its hold settles stale. After every cycle every system invariant holds. At the end: no request,
 * approver launch, withdrawal or resume was ever made for a held decision; every hand-launched approver session
 * was closed once, within three cycles of its hold, and none lingers; each attempt's decision settled exactly
 * once; and the two quiet days after the last attempt ended performed no work at all.
 *
 * GY-1701 (reviews of a09e087ac2e6 and 1e97d2a529) adds a second soak below: covering scope asks
 * whose standing no-answers revision already plans the asked path — adoption, budget exclusion,
 * settlement, clear-on-refusal, and ask closure that drops the covering watch without withdrawing
 * the foreign revision.
 */
const minute = 60_000, hour = 60 * minute, day = 24 * hour, cycleMs = 2 * minute, start = Date.parse('2026-10-11T00:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const judgeAfter = 6 * minute;
const layout = 'src/widget/Layout.tsx';
const sha = (n: number, epoch: number) => `${n}${epoch}`.padEnd(40, 'f');

type Decision = { id: string; action: string; state: string; input: any; outcome: string | null; approvedBy: string | null; approvedAt: string | null; approvalReason: string | null; refusal: string | null; requestedAt: string; requestedBy: string; held: { reason: string; at: string; application: unknown } | null; race?: unknown };
type Ending = 'submit' | 'release' | 'lapse';
type Item = { key: string; n: number; epoch: number; live: boolean; policyRevision: number; text: string; plannedFiles: string[]; stage: 'build' | 'review'; submission: { epoch: number; pr: number } | null; candidate: { sha: string; baseSha: string; pr: number; branch: string; author: string } | null; reworkRequested: boolean; scopeRequest: ScopeRequestState | null };
type Step = { at: number; key: string; run: () => void };

test('unit:soak-invariants-hold — over three simulated days, decisions held through two attempts of eight items are neither requested again, relaunched, withdrawn nor resumed; each settles once when its attempt ends, every hand approver is closed within three cycles of its hold, the quiet days perform no work, and every invariant holds', { timeout: 300_000 }, async () => {
  let now = start;
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], producers: [], run: { intervalSeconds: 600 } }) as MasterConfig;

  // ---- The world: eight items in build, each attempt holding a master-requested, non-widening requirements decision ----
  const items: Item[] = [0, 1, 2, 3, 4, 5, 6, 7].map(n => ({ key: `GY-${1690 + n}`, n, epoch: 1, live: true, policyRevision: 1, text: 'The widget layout renders', plannedFiles: [layout], stage: 'build', submission: null, candidate: null, reworkRequested: false, scopeRequest: null }));
  const decisions = new Map<string, Decision[]>(items.map(item => [item.key, []]));
  // The approver sessions Herdr lists: launched by hand with `master approver`, named for the item and decision.
  const sessions: { name: string; pane: string; status: 'working' | 'done'; key: string; decision: string }[] = [];
  const closes: { pane: string; at: number }[] = [], heldAt = new Map<string, number>(), settled = new Map<string, { kind: string; at: number }[]>();
  const of = (work: Work) => items.find(item => item.key === work.key)!;
  const standing = (item: Item) => decisions.get(item.key)!.find(decision => ['requested', 'held'].includes(decision.state));
  const revision = (item: Item) => ({ expectedPolicyRevision: item.policyRevision, criteria: [{ id: 'AC-1', text: `The widget layout renders, as release ${item.policyRevision + 1} shows`, proofs: ['unit:layout'] }], dependencies: [], plannedFiles: [...item.plannedFiles], exclusiveResources: [] });
  const ending = (item: Item, kind: Ending) => kind === 'lapse' ? `attempt ${item.epoch}'s lease lapsed` : `${kind} ended attempt ${item.epoch}`;
  /** The master requests the non-widening revision and launches its approver by hand. */
  const request = (item: Item) => {
    assert.ok(item.live && !standing(item), `${item.key}: one decision per attempt`);
    const id = randomUUID();
    decisions.get(item.key)!.push({ id, action: 'requirements', state: 'requested', input: revision(item), outcome: null, approvedBy: null, approvedAt: null, approvalReason: null, refusal: null, requestedAt: iso(now), requestedBy: 'graphyard-master-project', held: null });
    sessions.push({ name: approverSessionName(item, id), pane: `pane-${id.slice(0, 8)}`, status: 'working', key: item.key, decision: id });
  };
  /** The approver approves; the control plane refuses the revision for the live lease and records the decision held. */
  const approve = (item: Item) => {
    const decision = standing(item)!;
    assert.equal(decision.state, 'requested');
    const reason = `${liveLeaseRevisionRefusal}; the approved decision is held and applied when the attempt ends`;
    Object.assign(decision, { state: 'held', approvedBy: 'graphyard-approver', approvedAt: iso(now), approvalReason: 'The criterion names the deployed behaviour', outcome: reason,
      held: { reason, at: iso(now), application: { actor: { id: 'graphyard-master-project', role: 'admin', sessionKind: 'ai' }, reason: 'Judged on the release [decision approved]' } } });
    heldAt.set(decision.id, now);
    sessions.find(session => session.decision === decision.id)!.status = 'done';
  };
  /** The worker asks for a file the widening rule refused: the loop would route it to the approver as a `requirements` decision. */
  const ask = (item: Item) => {
    item.scopeRequest = { epoch: item.epoch, at: iso(now), paths: [`src/daemon/cycle-widget-${item.n}.ts`], reason: 'AC-1 needs the cycle module', requestedBy: 'worker',
      decision: { state: 'refused', reason: `No rule implies src/daemon/cycle-widget-${item.n}.ts`, at: iso(now + 1_000), decidedBy: 'graphyard', treeRead: true } } as ScopeRequestState;
  };
  /** A hand widening while the decision is held: the revision moves first, so the hold settles stale when the attempt ends. */
  const widen = (item: Item) => { item.plannedFiles = [...item.plannedFiles, `src/widget/Extra-${item.n}.tsx`]; item.policyRevision++; };
  /** The attempt ends: the same transaction applies the held decision at its recorded revision, or settles it stale. */
  const end = (item: Item, kind: Ending) => {
    assert.ok(item.live, `${item.key}: an attempt is live to end`);
    const decision = standing(item);
    if (decision) {
      assert.equal(decision.state, 'held', `${item.key}: the decision was held when the attempt ended`);
      const expected = decision.input.expectedPolicyRevision as number;
      if (expected === item.policyRevision) {
        item.policyRevision++; item.text = decision.input.criteria[0].text;
        Object.assign(decision, { state: 'applied', outcome: `Requirements revised to policy revision ${item.policyRevision} when ${ending(item, kind)}${kind === 'submit' ? `; the submitted head is re-reviewed on revision ${item.policyRevision}` : ''}` });
      } else Object.assign(decision, { state: 'stale', outcome: `Policy revision changed (now ${item.policyRevision}); the held decision was approved against revision ${expected} and was not applied when ${ending(item, kind)}`, race: { expected: { policyRevision: expected }, current: { policyRevision: item.policyRevision } } });
      settled.set(decision.id, [...(settled.get(decision.id) ?? []), { kind: decision.state, at: now }]);
    }
    item.live = false; item.scopeRequest = null;
    if (kind === 'submit') { item.stage = 'review'; item.submission = { epoch: item.epoch, pr: 1600 + item.n }; item.candidate = { sha: sha(item.n, item.epoch), baseSha: 'b'.repeat(40), pr: 1600 + item.n, branch: `graphyard/${item.key.toLowerCase()}-${item.epoch}`, author: 'worker' }; item.reworkRequested = false; }
  };
  /** The reviewer requested changes on the head and the master sent it back: the next attempt starts on a new head. */
  const rework = (item: Item) => { item.stage = 'build'; item.reworkRequested = true; };
  const claim = (item: Item) => { assert.ok(!item.live); item.epoch++; item.live = true; item.stage = 'build'; };

  // ---- The script: each item's two attempts, staggered over the first day; days two and three are quiet ----
  const steps: Step[] = [];
  const at = (when: number, item: Item, run: () => void) => steps.push({ at: when, key: item.key, run });
  const endings: Ending[] = ['submit', 'release', 'lapse'];
  for (const item of items) {
    const n = item.n, first = endings[n % 3], requested = start + n * minute;
    at(requested, item, () => request(item));
    at(requested + judgeAfter, item, () => approve(item));
    // GY-1692 asks after its decision is held; GY-1695 asks while the master's decision is still with the approver, and the loop
    // routes the ask (after the bound it settles one in) once the decision is held: either way the held one stands in its place.
    if (n === 2) at(requested + judgeAfter + 4 * minute, item, () => ask(item));
    if (n === 5) at(requested + 2 * minute, item, () => ask(item));
    if (n === 7) at(requested + judgeAfter + 10 * minute, item, () => widen(item));
    const ended = start + hour + n * 20 * minute;
    at(ended, item, () => end(item, first));
    if (first === 'submit') at(ended + 30 * minute, item, () => rework(item));
    const claimed = ended + 40 * minute;
    at(claimed, item, () => claim(item));
    at(claimed + 5 * minute, item, () => request(item));
    at(claimed + 5 * minute + judgeAfter, item, () => approve(item));
    at(claimed + 90 * minute, item, () => end(item, n === 1 ? 'release' : 'submit'));
  }
  steps.sort((a, b) => a.at - b.at);
  const lastStep = steps.at(-1)!.at;
  let next = 0;
  const advance = () => { for (; next < steps.length && steps[next].at <= now; next++) steps[next].run(); };

  const view = (item: Item): Work => ({
    id: `work-${item.key}`, key: item.key, title: 'Widget research', description: '', type: 'feature', priority: 1, dependencies: [], plannedFiles: [...item.plannedFiles],
    criteria: [{ id: 'AC-1', text: item.text, proofs: ['unit:layout'] }], policy: { checks: ['test'], review: true },
    stage: item.stage, ready: true, epoch: item.epoch, revision: 10 + decisions.get(item.key)!.length + item.policyRevision, policyRevision: item.policyRevision,
    createdAt: iso(start - hour), updatedAt: iso(now), stageEnteredAt: iso(start - hour), lease: item.live ? { owner: `worker-${item.n % 3}`, epoch: item.epoch, expiresAt: iso(now + hour) } : null,
    workspaces: [], submission: item.submission, candidate: item.candidate, reworkRequested: item.reworkRequested, scenarioRequirements: [], violations: [], evidence: [], observation: null, blocker: null,
    scopeRequest: item.scopeRequest, carriedScopeRequest: null, scopeDecision: null,
    gates: item.stage === 'build' ? [{ name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }]
      : [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['A new independent approval after the requirement-review baseline is required'] }],
  } as unknown as Work);

  const launches: string[] = [], requested: string[] = [], withdrawals: string[] = [], resumes: string[] = [], widened: string[] = [];
  let reads = 0;
  const effects = {
    agents: () => [], herdr: () => ({ agents: sessions.map(session => ({ name: session.name, agent_status: session.status, pane_id: session.pane })), available: true }), credentials: async () => ({}),
    snapshot: async () => { advance(); return { work: items.map(view), now: iso(now) }; },
    closeSession: (pane: string) => { closes.push({ pane, at: now }); const index = sessions.findIndex(session => session.pane === pane); assert.ok(index >= 0, `the loop closes a pane Herdr lists: ${pane}`); sessions.splice(index, 1); },
    dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}), wakeObservation: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    decisions: async (work: Work) => { reads++; return { decisions: structuredClone(decisions.get(work.key) ?? []) }; },
    decide: async (work: Work, action: string, reason: string) => { requested.push(`${work.key}: ${action}: ${reason}`); return { id: randomUUID(), state: 'requested' }; },
    withdraw: async (work: Work, decision: string, reason: string) => { withdrawals.push(`${work.key}: ${decision}: ${reason}`); },
    resume: async (work: Work, decision: string) => { resumes.push(`${work.key}: ${decision}`); return decisions.get(work.key)!.find(entry => entry.id === decision)!; },
    approver: async (work: Work, decision: string) => { launches.push(`${work.key}: ${decision}`); return { agentName: `gy-approver-${decision.slice(0, 8)}`, pane: null }; },
    widenScope: async (work: Work) => { widened.push(work.key); return {}; },
    persist: async () => {},
  } as unknown as DaemonEffects;

  const state: DaemonState = emptyDaemonState(config);
  const violations: string[] = [], readsPerCycle: number[] = [], performedPerCycle: { at: number; count: number; reads: number }[] = [];
  let quietFrom: number | null = null;
  for (let cycle = 0; now < start + 3 * day; cycle++, now += cycleMs) {
    reads = 0;
    const { actions } = await runCycle(config, state, effects, () => now);
    readsPerCycle.push(reads);
    performedPerCycle.push({ at: now, count: actions.length, reads });
    for (const check of state.invariants.report as InvariantCheck[]) if (!check.holds) violations.push(`cycle ${cycle}: ${check.line}`);
    // Quiet from three cycles after the last attempt ended: by then the loop has read every settlement and closed every session.
    if (quietFrom === null && now > lastStep + 3 * cycleMs) quietFrom = now;
  }

  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.equal(next, steps.length, 'the whole script ran');
  assert.deepEqual(requested, [], 'the loop requested nothing: not a held decision again, and not the routed widening of a scope ask while one stood');
  assert.deepEqual(launches, [], 'the loop launched no approver for a held decision: its judgement is made');
  assert.deepEqual(withdrawals, [], 'no held decision was withdrawn as one the item moved past');
  assert.deepEqual(resumes, [], 'no held decision was resumed as an approval left without an outcome');
  assert.deepEqual(widened, [], 'the loop never widened a scope ask itself');
  // Each attempt's decision: two per item, each settled exactly once, when its attempt ended, as the ending allows.
  for (const item of items) {
    const history = decisions.get(item.key)!;
    assert.equal(history.length, 2, `${item.key}: one decision per attempt, ${history.length} recorded`);
    for (const [index, decision] of history.entries()) {
      const outcomes = settled.get(decision.id) ?? [];
      assert.equal(outcomes.length, 1, `${item.key}: decision ${decision.id} settled once (${outcomes.map(entry => entry.kind).join(', ')})`);
      const expected = item.n === 7 && index === 0 ? 'stale' : 'applied';
      assert.equal(decision.state, expected, `${item.key}: decision ${index + 1} ${decision.state}: ${decision.outcome}`);
      assert.equal(decision.approvedBy, 'graphyard-approver', `${item.key}: the approval stands on the settled record`);
      assert.ok(heldAt.has(decision.id) && outcomes[0].at > heldAt.get(decision.id)!, `${item.key}: settled after it was held`);
    }
    assert.equal(item.policyRevision, item.n === 7 ? 3 : 3, `${item.key}: revised once per applied decision (and once by hand for GY-1697)`);
  }
  assert.match(decisions.get('GY-1690')![1].outcome!, /the submitted head is re-reviewed on revision 3$/, 'a completed head is re-reviewed on the new revision');
  // Every hand-launched approver session was closed once, within three cycles of its decision being held, and none lingers.
  const panes = [...heldAt.keys()].map(decision => `pane-${decision.slice(0, 8)}`);
  assert.deepEqual(closes.map(close => close.pane).sort(), panes.sort(), 'each approver session closed exactly once');
  for (const [decision, held] of heldAt) {
    const close = closes.find(entry => entry.pane === `pane-${decision.slice(0, 8)}`)!;
    assert.ok(close.at - held <= 3 * cycleMs, `approver session of ${decision} closed ${(close.at - held) / minute} minutes after its hold`);
  }
  assert.deepEqual(sessions, [], 'no approver session lingers');
  // The loop's own request path: the routed widening of GY-1692's and GY-1695's ask found the held decision standing and requested nothing, once.
  // GY-1720: the held revision plans only the layout, not the cycle module the worker asks for, so since GY-1702 the loop
  // adopts it with the wording that it does not widen for the ask (heldWaitDetail, unmatched) and the ask waits for the
  // hold to settle. This soak's pattern still named the covering wording, so it counted zero records on candidate
  // b991fb359b (run 38213291605). The pattern names the first attempt's held decision by id, so a hold the loop ignored or
  // a widening routed in its place still finds no record here, and `requested` above stays empty.
  for (const key of ['GY-1692', 'GY-1695']) {
    const held = decisions.get(key)![0].id;
    const adopted = Object.entries(state.actions).filter(([, action]) => action.work === key && action.detail?.includes(`requirements decision ${held} is approved by graphyard-approver and held (`)
      && /; it does not widen for this scope ask, so the ask waits until the hold settles and nothing is requested$/.test(action.detail));
    assert.ok(adopted.length >= 1 && adopted.length <= 2, `${key}: the held decision was adopted in place of the routed widening (${adopted.length} records)`);
  }
  // Bounded: a held decision costs the loop a few records in all (watched, closed, adopted, the head's review note), never one per
  // cycle; the loop reads each open item's history at most once per step; and the two quiet days performed no work at all.
  const performed = performedPerCycle.reduce((total, entry) => total + entry.count, 0);
  assert.ok(performed <= 12 * heldAt.size, `${performed} records performed for ${heldAt.size} held decisions`);
  assert.ok(Math.max(...readsPerCycle) <= 3 * items.length, `decision reads per cycle stay bounded: ${Math.max(...readsPerCycle)} at most`);
  const quiet = performedPerCycle.filter(entry => entry.at >= quietFrom!);
  assert.ok(quiet.length > day / cycleMs, `the quiet period spans more than a day: ${quiet.length} cycles`);
  assert.deepEqual(quiet.filter(entry => entry.count > 0).map(entry => `${iso(entry.at)}: ${entry.count}`), [], 'no action was performed in the quiet days');
  assert.ok(Math.max(...quiet.map(entry => entry.reads)) <= items.length, `quiet cycles read at most once per item: ${Math.max(...quiet.map(entry => entry.reads))}`);
});

/**
 * GY-1701. Covering asks across six items over two simulated days: the master's no-answers revision
 * already plans the path the worker asks for. Adoption excludes the blocked bound while the revision
 * stands; a refused covering revision clears its watch; held covering watches stay active until
 * apply or ask close; closing the ask while the foreign revision is still requested drops the
 * covering watch and never withdraws that revision; every system invariant holds.
 */
test('unit:soak-covering-scope-adopt — over two simulated days, covering asks across six items adopt standing revisions, exclude the blocked bound, clear watches on refusal, drop watches without withdrawing when the ask closes, and keep every invariant', { timeout: 300_000 }, async () => {
  let now = start;
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], producers: [], run: { intervalSeconds: 600 } }) as MasterConfig;

  type CoverItem = Item & { cover: string };
  const items: CoverItem[] = [0, 1, 2, 3, 4, 5].map(n => ({
    key: `GY-${1700 + n}`, n, epoch: 1, live: true, policyRevision: 1, text: 'The widget layout renders',
    plannedFiles: [layout], cover: `src/widget/Cover-${n}.tsx`, stage: 'build', submission: null, candidate: null, reworkRequested: false, scopeRequest: null,
  }));
  type CoverDecision = Decision & { refusal: { approver: string; reason: string; at: string } | null };
  const decisions = new Map<string, CoverDecision[]>(items.map(item => [item.key, []]));
  const sessions: { name: string; pane: string; status: 'working' | 'done'; key: string; decision: string }[] = [];
  const closes: { pane: string; at: number }[] = [], adopted: string[] = [], requested: string[] = [], withdrawals: string[] = [];
  const standing = (item: CoverItem) => decisions.get(item.key)!.find(decision => ['requested', 'held'].includes(decision.state));
  const revision = (item: CoverItem) => ({
    expectedPolicyRevision: item.policyRevision,
    criteria: [{ id: 'AC-1', text: `The widget layout renders, as release ${item.policyRevision + 1} shows`, proofs: ['unit:layout'] }],
    dependencies: [], plannedFiles: [layout, item.cover], exclusiveResources: [],
  });
  const request = (item: CoverItem) => {
    assert.ok(item.live && !standing(item), `${item.key}: one decision per attempt`);
    const id = randomUUID();
    decisions.get(item.key)!.push({ id, action: 'requirements', state: 'requested', input: revision(item), outcome: null, approvedBy: null, approvedAt: null, approvalReason: null, refusal: null, requestedAt: iso(now), requestedBy: 'graphyard-master-project', held: null });
    sessions.push({ name: approverSessionName(item, id), pane: `pane-${id.slice(0, 8)}`, status: 'working', key: item.key, decision: id });
  };
  const approve = (item: CoverItem) => {
    const decision = standing(item)!;
    assert.equal(decision.state, 'requested');
    const reason = `${liveLeaseRevisionRefusal}; the approved decision is held and applied when the attempt ends`;
    Object.assign(decision, { state: 'held', approvedBy: 'graphyard-approver', approvedAt: iso(now), approvalReason: 'The criterion names the deployed behaviour', outcome: reason,
      held: { reason, at: iso(now), application: { actor: { id: 'graphyard-master-project', role: 'admin', sessionKind: 'ai' }, reason: 'Judged on the release [decision approved]' } } });
    sessions.find(session => session.decision === decision.id)!.status = 'done';
  };
  const refuse = (item: CoverItem) => {
    const decision = standing(item)!;
    assert.equal(decision.state, 'requested');
    Object.assign(decision, { state: 'refused', outcome: 'refused', refusal: { approver: 'graphyard-approver', reason: 'criteria rewrite not needed', at: iso(now) } });
    sessions.find(session => session.decision === decision.id)!.status = 'done';
  };
  const ask = (item: CoverItem) => {
    item.scopeRequest = { epoch: item.epoch, at: iso(now), paths: [item.cover], reason: 'AC-1 needs the cover module', requestedBy: 'worker',
      decision: { state: 'refused', reason: `No rule implies ${item.cover}`, at: iso(now + 1_000), decidedBy: 'graphyard', treeRead: true } } as ScopeRequestState;
  };
  const closeAsk = (item: CoverItem) => { item.scopeRequest = null; };
  const end = (item: CoverItem) => {
    assert.ok(item.live);
    const decision = standing(item);
    if (decision?.state === 'held') {
      item.policyRevision++; item.text = decision.input.criteria[0].text; item.plannedFiles = [...decision.input.plannedFiles];
      Object.assign(decision, { state: 'applied', outcome: `Requirements revised to policy revision ${item.policyRevision} when attempt ${item.epoch} ended` });
    }
    item.live = false; item.scopeRequest = null;
  };
  const claim = (item: CoverItem) => { assert.ok(!item.live); item.epoch++; item.live = true; item.stage = 'build'; };

  const steps: Step[] = [];
  const at = (when: number, item: CoverItem, run: () => void) => steps.push({ at: when, key: item.key, run });
  for (const item of items) {
    const n = item.n, requested = start + n * minute, kind = n % 3;
    at(requested, item, () => request(item));
    at(requested + 2 * minute, item, () => ask(item));
    // 0: refuse covering. 1: hold then settle across two attempts. 2: close ask while revision still requested.
    if (kind === 0) at(requested + judgeAfter, item, () => refuse(item));
    else if (kind === 2) at(requested + 4 * minute, item, () => closeAsk(item));
    else {
      at(requested + judgeAfter, item, () => approve(item));
      at(requested + hour, item, () => end(item));
      at(requested + hour + 20 * minute, item, () => claim(item));
      at(requested + hour + 25 * minute, item, () => request(item));
      at(requested + hour + 27 * minute, item, () => ask(item));
      at(requested + hour + 25 * minute + judgeAfter, item, () => approve(item));
      at(requested + hour + 90 * minute, item, () => end(item));
    }
  }
  steps.sort((a, b) => a.at - b.at);
  const lastStep = steps.at(-1)!.at;
  let next = 0;
  const advance = () => { for (; next < steps.length && steps[next].at <= now; next++) steps[next].run(); };

  const view = (item: CoverItem): Work => ({
    id: `work-${item.key}`, key: item.key, title: 'Widget research', description: '', type: 'feature', priority: 1, dependencies: [], plannedFiles: [...item.plannedFiles],
    criteria: [{ id: 'AC-1', text: item.text, proofs: ['unit:layout'] }], policy: { checks: ['test'], review: true },
    stage: item.stage, ready: true, epoch: item.epoch, revision: 10 + decisions.get(item.key)!.length + item.policyRevision, policyRevision: item.policyRevision,
    createdAt: iso(start - hour), updatedAt: iso(now), stageEnteredAt: iso(start - hour), lease: item.live ? { owner: `worker-${item.n % 3}`, epoch: item.epoch, expiresAt: iso(now + hour) } : null,
    workspaces: [], submission: item.submission, candidate: item.candidate, reworkRequested: item.reworkRequested, scenarioRequirements: [], violations: [], evidence: [], observation: null, blocker: null,
    scopeRequest: item.scopeRequest, carriedScopeRequest: null, scopeDecision: null,
    containmentQuarantine: standing(item)?.state === 'held' ? { at: iso(now - minute), epoch: item.epoch, owner: `worker-${item.n % 3}`, scope: { pid: 1, unit: 'u' }, leaseExpiresAt: iso(now + hour), settlementHash: 'a'.repeat(64), launchExpiresAt: iso(now - minute), launchAcknowledgedAt: iso(now - minute) } : undefined,
    gates: item.stage === 'build' ? [{ name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }]
      : [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['A new independent approval after the requirement-review baseline is required'] }],
  } as unknown as Work);

  const effects = {
    agents: () => [], herdr: () => ({ agents: sessions.map(session => ({ name: session.name, agent_status: session.status, pane_id: session.pane })), available: true }), credentials: async () => ({}),
    snapshot: async () => { advance(); return { work: items.map(view), now: iso(now) }; },
    closeSession: (pane: string) => { closes.push({ pane, at: now }); const index = sessions.findIndex(session => session.pane === pane); if (index >= 0) sessions.splice(index, 1); },
    dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}), wakeObservation: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    decisions: async (work: Work) => ({ decisions: structuredClone(decisions.get(work.key) ?? []) }),
    decide: async (work: Work, action: string, reason: string) => { requested.push(`${work.key}: ${action}: ${reason}`); return { id: randomUUID(), state: 'requested' }; },
    withdraw: async (work: Work, decision: string, reason: string) => {
      withdrawals.push(`${work.key}: ${decision}: ${reason}`);
      const entry = decisions.get(work.key)?.find(each => each.id === decision);
      if (entry) entry.state = 'withdrawn';
    },
    resume: async (work: Work, decision: string) => decisions.get(work.key)!.find(entry => entry.id === decision)!,
    approver: async () => ({ agentName: 'gy-approver', pane: null }),
    widenScope: async () => ({}), persist: async () => {},
  } as unknown as DaemonEffects;

  const state: DaemonState = emptyDaemonState(config);
  const violations: string[] = [], coveringBudgetBreaches: string[] = [];
  let sawOrdinaryRouted = false;
  for (let cycle = 0; now < start + 2 * day; cycle++, now += cycleMs) {
    await runCycle(config, state, effects, () => now);
    for (const check of state.invariants.report as InvariantCheck[]) if (!check.holds) violations.push(`cycle ${cycle}: ${check.line}`);
    const live = items.filter(item => item.scopeRequest).map(view);
    const budget = scopeBudget(live, state.scope, now, true, state.approvals);
    for (const item of items) {
      if (!item.scopeRequest) continue;
      const work = view(item);
      if (coveringStandingScopeWatch(work, state.approvals)) {
        assert.ok(Object.values(state.approvals).some(watch => watch.work === item.key && watch.coveringAdopt),
          `${item.key}: covering budget exclusion requires coveringAdopt`);
        adopted.push(`${item.key}@${iso(now)}`);
        for (const breach of budget.breaches) if (breach.id === `blocked:${item.key}:${item.scopeRequest.epoch}`) {
          coveringBudgetBreaches.push(`${iso(now)}: ${breach.detail}`);
        }
      } else {
        const watch = Object.values(state.approvals).find(entry => entry.work === item.key && entry.scope && !entry.coveringAdopt);
        if (watch) sawOrdinaryRouted = true;
      }
    }
  }

  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.equal(next, steps.length, 'the whole script ran');
  assert.ok(adopted.length > 0, 'covering asks were adopted across cycles');
  assert.deepEqual(coveringBudgetBreaches, [], 'no covering ask breached the blocked bound while its coveringAdopt watch stood');
  assert.ok(sawOrdinaryRouted, 'after a covering refusal the loop routes an ordinary widening whose watch does not suppress the bound');
  // kind 0: covering revision refused — watch cleared.
  for (const item of items.filter(entry => entry.n % 3 === 0)) {
    assert.ok(Object.values(state.actions).some(action => action.work === item.key && /covering revision did not answer|Cleared covering watch/.test(action.detail ?? '')),
      `${item.key}: the refused covering revision cleared its watch`);
  }
  // kind 1: covering hold applied on attempt end — no stranded covering watch remains.
  for (const item of items.filter(entry => entry.n % 3 === 1)) {
    assert.ok(!Object.values(state.approvals).some(watch => watch.work === item.key && watch.coveringAdopt && !watch.settledAt),
      `${item.key}: no unsettled covering watch lingers after both attempts`);
  }
  // kind 2: ask closed while the foreign revision was still requested — watch dropped, revision not withdrawn.
  for (const item of items.filter(entry => entry.n % 3 === 2)) {
    const foreign = decisions.get(item.key)!.find(entry => entry.requestedBy === 'graphyard-master-project');
    assert.ok(foreign, `${item.key}: the master revision exists`);
    assert.equal(foreign!.state, 'requested', `${item.key}: closing the ask left the foreign revision requested`);
    assert.ok(!Object.values(state.approvals).some(watch => watch.work === item.key && watch.coveringAdopt),
      `${item.key}: the covering watch was dropped when the ask closed`);
    assert.ok(!withdrawals.some(entry => entry.startsWith(`${item.key}: ${foreign!.id}:`)),
      `${item.key}: the foreign covering revision was not withdrawn because the ask ended`);
  }
  assert.deepEqual(withdrawals.filter(entry => /moved past the requirements/.test(entry)), [],
    'no covering adopt was withdrawn as a decision the item moved past');
  assert.ok(now > lastStep + scopeBlockedBudgetMs, 'the soak outlasts the blocked bound so a stranded ask would have breached');
  assert.deepEqual(state.faults.instances.filter(instance => instance.faultClass === 'decision' && /left to its requester/.test(instance.text ?? '')), [],
    'covering asks never throw the one-at-a-time starvation fault');
  assert.ok(closes.length >= 0 && requested.every(entry => !/left to its requester/.test(entry)));
});
