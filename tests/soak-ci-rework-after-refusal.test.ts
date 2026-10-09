import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { InvariantCheck } from '../src/model/invariants.js';
import { nextAction } from '../src/model/next-action.js';
import { terminalDecisions } from '../src/cli/decision-report.js';
import type { Work } from '../src/model.js';

/**
 * GY-1606 (review of fb387319a66a). A refused capped review rework must never hold back the rework a failed required
 * check owes on the same head, and the handoff runs for every item on every cycle, so the real loop runs here for three
 * simulated days over several items whose workers keep pushing heads. Each head but an item's last fails its required
 * check `test` after its rerun and carries a capped review rework past the round cap: on some heads it stands requested
 * when the failed check is first seen (GY-1598's order: the failed-check binding adopts it) and its approver refuses it
 * later, on others it is already refused (GY-1600's order). The last head passes and is delivered. After every cycle
 * every system invariant holds, master status names the failed-check rework over the review change request, and no
 * attention asks the master to answer the refusal by hand. At the end: each failing head got exactly one failed-check
 * rework, within one cycle of the observation that showed it owed one; no capped review rework was ever requested by
 * the loop, so none was re-requested; and no refusal was escalated.
 */
const minute = 60_000, hour = 60 * minute, day = 24 * hour, start = Date.parse('2026-10-09T00:00:00.000Z'), interval = 10 * minute;
const iso = (at: number) => new Date(at).toISOString();
const reviewer = 'graphyard-reviewer[bot]', base = 'b'.repeat(40);

/** The order each failing head meets: the capped rework still requested when the failed check is seen, or already refused. */
type Order = 'adopted' | 'refused-first';
type Decision = { id: string; action: string; state: string; input: any; reason: string; requestedBy: string; requestedAt: string; approvedBy: string | null; refusal: { approver: string; reason: string; at: string } | null };
type Item = { key: string; n: number; heads: Order[]; round: number; pushedAt: number; reworkRequested: boolean; delivered: boolean; withdrawn: boolean; decisions: Decision[] };

test('unit:ci-rework-after-review-refusal — over three simulated days every head that carries a refused capped review rework and a failed required check gets one failed-check rework promptly, the refused review rework is never re-requested, nobody is asked to answer it by hand, and every invariant holds', { timeout: 300_000 }, async () => {
  let now = start;
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], producers: [], run: { intervalSeconds: 600 },
    reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: '/outside/reviewer.json', boundAt: iso(start - hour) } }) as MasterConfig;

  const items: Item[] = [
    ['adopted', 'refused-first', 'adopted', 'adopted'],
    ['refused-first', 'adopted', 'refused-first'],
    ['adopted', 'adopted', 'refused-first', 'adopted', 'refused-first'],
    ['refused-first', 'refused-first'],
  ].map((heads, n) => ({ key: `GY-${1700 + n}`, n, heads: heads as Order[], round: 0, pushedAt: start + n * 7 * minute, reworkRequested: false, delivered: false, withdrawn: false, decisions: [] }));
  const shaOf = (item: Item, round = item.round) => `${(item.n + 1).toString(16)}${(round + 1).toString(16).padStart(39, '0')}`;
  const cappedBinding = (item: Item, round = item.round) => `${shaOf(item, round)}:capped:${reviewer}`;
  const ciBinding = (item: Item, round = item.round) => `${shaOf(item, round)}:ci:test`;
  const failing = (item: Item) => item.round < item.heads.length;
  /** The capped review rework the review-cap step requested on a head past the round cap; its approver refuses it as non-blocking. */
  const capped = (item: Item, state: 'requested' | 'refused'): Decision => ({ id: randomUUID(), action: 'rework', state, input: { previousWorkerStopped: true, binding: cappedBinding(item) },
    reason: '[Capped review under policy revision 1.] a blocking finding', requestedBy: 'graphyard-master-project', requestedAt: iso(item.pushedAt), approvedBy: null,
    refusal: state === 'refused' ? { approver: 'graphyard-approver', reason: 'Non-blocking past the round cap', at: iso(item.pushedAt) } : null });
  const refuseAfter = 25 * minute;
  // A head is pushed with its capped review rework standing as its order says; the approver refuses a requested one later.
  const push = (item: Item) => { if (failing(item)) item.decisions.push(capped(item, item.heads[item.round] === 'adopted' ? 'requested' : 'refused')); };
  for (const item of items) push(item);
  /** When a head first owed its failed-check rework: once the capped request on it is refused (or at once, when it already was). */
  const owedAt = new Map<string, number>();

  const view = (item: Item): Work => {
    const sha = shaOf(item), candidate = { sha, baseSha: base, pr: 1700 + item.n, branch: `graphyard/${item.key.toLowerCase()}-1`, author: 'worker' }, fails = failing(item);
    const observation = { candidate, checks: [{ name: 'test', result: fails ? 'failure' : 'success', appId: 15368, id: 7, attempt: 2 }, { name: 'typecheck', result: 'success', appId: 15368, id: 8 }],
      // The review-cap step withdraws a refused capped change request; the head then awaits its re-review.
      reviews: [{ reviewer, sha, state: !fails ? 'APPROVED' : item.withdrawn ? 'DISMISSED' : 'CHANGES_REQUESTED', submittedAt: iso(item.pushedAt - 5 * minute), id: 5475323343 + item.round, body: 'BLOCKING: the loop drops the failed-check rework', blocking: ['the loop drops the failed-check rework'] }], merged: item.delivered, mergeSha: null, mergeable: true, protected: true,
      files: ['src/loop.ts'], scopeFiles: [], at: iso(now), prState: item.delivered ? 'merged' : 'open', draft: false, baseTip: base, baseTree: base, baseTipContained: true, conversations: { required: true, unresolved: [] } };
    return {
      id: `work-${item.key}`, key: item.key, title: 'Capped review on a failing head', description: '', type: 'bug', priority: 1, dependencies: [], plannedFiles: ['src/loop.ts'],
      criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], policy: { checks: ['test', 'typecheck'], review: true }, stage: item.delivered ? 'done' : 'review', ready: true,
      epoch: item.round + 1, revision: 10 + item.decisions.length, policyRevision: 1, createdAt: iso(start - hour), updatedAt: iso(now), stageEnteredAt: iso(item.pushedAt), lease: null, workspaces: [],
      submission: { epoch: item.round + 1, pr: 1700 + item.n }, candidate, reworkRequested: item.reworkRequested, scenarioRequirements: [], evidence: [], blocker: null, violations: [],
      pipeline: { reworkRounds: 3 + item.round }, observation,
      gates: fails ? [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: [item.withdrawn ? 'A new independent GitHub approval after the requirement-review baseline is required' : `Outstanding change requests from ${reviewer}`] },
        { name: 'test', passed: false, reasons: ['Required CI check test has not passed on the current candidate'], ciAppIds: [15368] }]
        : [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] }, { name: 'test', passed: true, reasons: [] }, { name: 'merge', passed: true, reasons: [] }],
    } as unknown as Work;
  };
  const of = (work: Work) => items.find(item => item.key === work.key)!;

  const reworks: { key: string; binding: string; at: number }[] = [], requested: { key: string; action: string; binding: unknown }[] = [], approvers: string[] = [], withdrawals: string[] = [], reviewWithdrawals: string[] = [];
  const effects = {
    // An approver session is working until its decision is judged, as herdr reports it.
    agents: () => [], herdr: () => ({ agents: approvers.filter(decision => items.some(item => item.decisions.some(entry => entry.id === decision && entry.state === 'requested')))
      .map(decision => ({ name: `gy-approver-${decision.slice(0, 8)}`, agent_status: 'working' })), available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: items.map(view), now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}), wakeObservation: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    decisions: async (work: Work) => ({ decisions: structuredClone(of(work).decisions) }),
    // The risk lane applies a failed-check rework as it is requested, as it does any.
    decide: async (work: Work, action: string, reason: string, input?: Record<string, unknown>) => {
      const item = of(work), id = randomUUID();
      requested.push({ key: item.key, action, binding: input?.binding });
      assert.equal(action, 'rework', `${item.key}: only a rework is asked for, not ${action}`);
      reworks.push({ key: item.key, binding: String(input?.binding), at: now });
      item.decisions.push({ id, action, state: 'applied', input, reason, requestedBy: 'graphyard-master-project', requestedAt: iso(now), approvedBy: 'graphyard-risk-lane', refusal: null });
      item.reworkRequested = true;
      return { id, state: 'applied', approvedBy: 'graphyard-risk-lane' };
    },
    withdraw: async (work: Work, decision: string) => { withdrawals.push(`${work.key}:${decision}`); },
    withdrawReview: async (work: Work) => { const item = of(work); reviewWithdrawals.push(shaOf(item)); item.withdrawn = true; },
    approver: async (_work: Work, decision: string) => { approvers.push(decision); return { agentName: `gy-approver-${decision.slice(0, 8)}`, pane: null }; },
    persist: async () => {},
  } as unknown as DaemonEffects;

  const state: DaemonState = emptyDaemonState(config);
  const violations: string[] = [], escalations: string[] = [], failures: string[] = [], named: string[] = [], attention: string[] = [];
  for (let cycle = 0; now < start + 3 * day; cycle++, now += interval) {
    for (const item of items) {
      // The worker pushes the next head two hours after its rework was applied; a passing head is delivered.
      if (item.reworkRequested && now - item.pushedAt >= 2 * hour) { item.round++; item.reworkRequested = false; item.withdrawn = false; item.pushedAt = now; push(item); }
      if (!failing(item)) { item.delivered = true; continue; }
      if (now < item.pushedAt) continue;
      const standing = item.decisions.find(entry => entry.input.binding === cappedBinding(item))!;
      if (standing.state === 'requested' && now - item.pushedAt >= refuseAfter)
        Object.assign(standing, { state: 'refused', refusal: { approver: 'graphyard-approver', reason: 'Non-blocking past the round cap', at: iso(now) } });
      if (standing.state === 'refused' && !owedAt.has(shaOf(item))) owedAt.set(shaOf(item), now);
    }
    const result = await runCycle(config, state, effects, () => now);
    for (const action of result.actions) {
      if (action.kind === 'escalation') escalations.push(`cycle ${cycle}: ${action.detail ?? ''}`);
      if (action.state === 'failed' && action.kind === 'decision') failures.push(`cycle ${cycle}: ${action.kind} ${action.detail ?? ''}`);
    }
    for (const check of state.invariants.report as InvariantCheck[]) if (!check.holds) violations.push(`cycle ${cycle}: ${check.line}`);
    // Master status on every failing head names the failed-check rework and asks nobody to answer the refusal.
    for (const item of items.filter(entry => failing(entry) && !entry.reworkRequested)) {
      const work = view(item), action = nextAction(work, items.map(view), new Date(now));
      if (action?.kind !== 'request-rework' || action.gate !== 'test') named.push(`cycle ${cycle} ${item.key}: ${action?.kind} on ${action?.gate} ${action?.reason}`);
    }
    if (cycle % 6 === 0) {
      const report = await terminalDecisions(async (path: string) => ({ decisions: structuredClone(items.find(item => path.includes(`work-${item.key}`) || path.includes(item.key))?.decisions ?? []) }),
        items.filter(item => !item.delivered).map(item => ({ id: `work-${item.key}`, key: item.key, stage: 'review' })), { approvals: [], runtime: { available: true, agents: [] }, now });
      for (const entry of report.attentionItems) if (/Answer the refusal/.test(entry.text)) attention.push(`cycle ${cycle} ${entry.subject}: ${entry.text}`);
    }
  }

  assert.deepEqual(failures, [], 'no decision step failed');
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(items.filter(item => !item.delivered).map(item => `${item.key} round ${item.round + 1} of ${item.heads.length + 1}`), [], 'every item worked through its failing heads and was delivered');
  for (const item of items) for (const [round] of item.heads.entries()) {
    const sha = shaOf(item, round), mine = reworks.filter(entry => entry.binding.startsWith(sha));
    // Exactly one failed-check rework per failing head, never repeated per cycle, and never the refused review rework.
    assert.deepEqual(mine.map(entry => entry.binding), [ciBinding(item, round)], `${item.key} head ${round + 1} (${item.heads[round]}): ${mine.map(entry => entry.binding).join(', ')}`);
    // Requested in the cycle the observation showing it owed one reached the loop.
    assert.ok(mine[0].at - owedAt.get(sha)! <= interval, `${item.key} head ${round + 1}: requested ${(mine[0].at - owedAt.get(sha)!) / minute} minutes after it was owed`);
  }
  assert.deepEqual(requested.filter(entry => String(entry.binding).includes(':capped:')), [], 'the loop never requested a capped review rework, so a refused one was never re-requested');
  assert.deepEqual(escalations.filter(detail => /refus/.test(detail)), [], 'no refusal was escalated to a master');
  assert.deepEqual(named, [], 'master status named the failed-check rework on every failing head');
  assert.deepEqual(attention, [], 'no attention asked the master to answer a refused capped rework by hand');
  assert.deepEqual(withdrawals, [], 'no decision was withdrawn');
  // The refusal is the review-cap step's to answer: it withdrew each refused change request once, never a second time.
  assert.deepEqual([...reviewWithdrawals].sort(), items.flatMap(item => item.heads.map((_, round) => shaOf(item, round))).sort(), 'each refused capped change request was withdrawn once by the review-cap step');
  const cappedIds = new Set(items.flatMap(item => item.decisions.filter(entry => String(entry.input.binding).includes(':capped:')).map(entry => entry.id)));
  assert.deepEqual(approvers.filter(decision => !cappedIds.has(decision)), [], 'no approver was launched for a failed-check rework');
});
