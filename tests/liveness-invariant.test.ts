import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import type { Store } from '../src/store.js';
import type { Work } from '../src/model.js';
import { claimAction, reconcileActions, settleAction } from '../src/model/actions.js';
import { actionStallThreshold } from '../src/model/action-progress.js';
import { livenessFailureLimit, livenessNext, livenessTick, livenessViolations, livenessWaitBoundMs, obligationOf, successorAction } from '../src/model/liveness.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, writeDaemonState } from '../src/master-daemon.js';

/**
 * GY-201: every open item always has exactly one owned next step with a deadline — a live leased
 * session, an action row, or a named wait with a dueAt — and the server keeps it so.
 *
 * - `unit:liveness-violations-detected` builds items in every state, including the three the
 *   design review found stranded in production (a merge with its PR open and no execution, a
 *   failed proof nobody asked to rework, a refused scope request), and asserts exactly which are
 *   violations and which obligation holds each of the others.
 * - `unit:violations-get-successor-actions` drives each violation through one reconciliation tick
 *   and asserts exactly one successor per item, none duplicated on the next tick, and that a
 *   successor failing `livenessFailureLimit` times for one reason is escalated, not retried.
 * - `unit:liveness-count-reported` asserts master status reports the count and each violation's
 *   age, and that the count is zero once the fixture board has settled through the engine.
 */

const now = new Date('2031-03-01T12:00:00Z');
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();
const hour = 3_600_000;
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const PROOF = 'unit:liveness-fixture';

let number = 0;
function item(key: string, overrides: Partial<Work> = {}): Work {
  number += 1;
  return {
    id: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`, key, title: key, description: '', type: 'feature', priority: 2, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Proven', proofs: [PROOF] }], policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: ['src/'],
    stage: 'build', revision: 1, policyRevision: 1, createdAt: at(-3 * hour), updatedAt: at(-2 * hour), stageEnteredAt: at(-2 * hour), ready: true,
    epoch: 1, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [],
    evidence: [], observation: null, blocker: null, gates: [], violations: [], ...overrides,
  } as Work;
}
const candidate = { sha: head, baseSha: base, pr: 71, branch: 'graphyard/gy-1-1', author: 'worker', createdAt: at(-2 * hour) };
const observed = (overrides: Partial<NonNullable<Work['observation']>> = {}) => ({
  candidate, checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
  reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }], merged: false, mergeSha: null, mergeable: true, protected: true,
  files: ['src/a.ts'], scopeFiles: [], at: at(-60_000), prState: 'open' as const, draft: false, baseTip: base, baseTipContained: true, ...overrides,
}) as NonNullable<Work['observation']>;
const passed = (...names: string[]) => names.map(name => ({ name, passed: true, reasons: [] }));

/** Every state the invariant has to answer for, keyed by what the test expects of it. */
function board() {
  const done = item('GY-9', { stage: 'done', candidate, submission: { epoch: 1, pr: 70 }, observation: observed({ merged: true, mergeSha: 'c'.repeat(40) }) });
  const leased = item('GY-10', { lease: { owner: 'worker-a', epoch: 1, expiresAt: at(90_000) }, gates: [{ name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }] });
  const queued = item('GY-11', { gates: [{ name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }] });
  reconcileActions(queued, [queued], now);
  const dependent = item('GY-12', { gates: [{ name: 'ready', passed: false, reasons: ['Dependency GY-10 is unfinished'] }] });
  const backlog = item('GY-13', { ready: false, stage: 'backlog' });
  // The GY-183 shape: the merge ahead of it landed, and nothing drives this one's merge.
  const stranded = item('GY-14', { stage: 'merge', candidate, submission: { epoch: 1, pr: 71 }, observation: observed(),
    gates: [...passed('ready', 'build', 'review', 'test', 'acceptance'), { name: 'merge', passed: false, reasons: ['Merge queue position 2 of 2: GY-9 is ahead'] }] });
  // Every gate passed, the pull request open, no merge execution and no row: nothing merges it.
  const unmerged = item('GY-15', { stage: 'merge', candidate, submission: { epoch: 1, pr: 72 }, observation: observed(), gates: passed('ready', 'build', 'review', 'test', 'acceptance', 'merge') });
  // The gate words it as the real evaluator does: a failed proof returns the head to its worker.
  const failed = item('GY-16', { stage: 'build', candidate, submission: { epoch: 1, pr: 73 }, observation: observed(),
    workspaces: [{ host: 'machine-a', path: '/work/gy-16', branch: 'graphyard/gy-16-1', epoch: 1, owner: 'worker-a' }],
    evidence: [{ id: 'e1', proof: PROOF, sha: head, baseSha: base, policyRevision: 1, producer: 'producer-a', trusted: true, result: 'fail', executed: 3, skipped: 0, at: at(-hour) }],
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: [`AC-1: ${PROOF} failed on aaaaaaaaaaaa (trusted evidence from producer-a); the head returns to its worker before review`] },
      ...passed('review', 'test'), { name: 'acceptance', passed: false, reasons: [`AC-1: ${PROOF} needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy`] }, ...passed('merge')] });
  const decision = { state: 'refused' as const, reason: 'docs/ops.md is outside the implied scope', at: at(-hour), decidedBy: 'graphyard', waitedMs: 1000, paths: ['docs/ops.md'], requestedBy: 'worker-b', requestedAt: at(-hour - 1000), epoch: 1 };
  const refused = item('GY-17', { scopeRequest: { epoch: 1, paths: ['docs/ops.md'], reason: 'the runbook changes', requestedBy: 'worker-b', at: at(-hour - 1000), decision },
    scopeDecision: decision, blocker: 'Scope request refused: docs/ops.md is outside the implied scope' });
  // A dependency that shipped long ago and a wait that never cleared.
  const orphaned = item('GY-18', { gates: [{ name: 'ready', passed: false, reasons: ['Dependency GY-9 is unfinished'] }] });
  return { done, leased, queued, dependent, backlog, stranded, unmerged, failed, refused, orphaned };
}
const all = (fixture: ReturnType<typeof board>) => Object.values(fixture);

test('unit:liveness-violations-detected — an open item with no live session, no action row and no named wait inside its deadline is a violation, in each stranded state', () => {
  const fixture = board(), items = all(fixture);
  const found = livenessViolations(items, now);
  assert.deepEqual(Object.fromEntries(found.map(entry => [entry.key, entry.state])), {
    'GY-14': 'stranded-merge', 'GY-15': 'stranded-merge', 'GY-16': 'failed-proof', 'GY-17': 'refused-scope', 'GY-18': 'stale-wait',
  });
  for (const entry of found) {
    assert.ok(entry.ageMs >= 0 && Number.isFinite(Date.parse(entry.since)), `${entry.key} carries its age`);
    assert.doesNotMatch(entry.reason, /\d{4}-\d\d-\d\dT/, `${entry.key}'s reason is worded without times, so it reads the same every tick`);
  }
  assert.match(found.find(entry => entry.key === 'GY-14')!.reason, /PR #71 is open on a{12} with no merge execution/);
  assert.match(found.find(entry => entry.key === 'GY-16')!.reason, new RegExp(`failed ${PROOF} on a{12} and no rework is requested`));
  assert.match(found.find(entry => entry.key === 'GY-17')!.reason, /docs\/ops\.md outside plannedFiles was refused/);
  assert.match(found.find(entry => entry.key === 'GY-18')!.reason, /waits on dependency GY-9 past its deadline/);

  // And the obligation that owns each of the others, with its deadline.
  const lease = obligationOf(fixture.leased, items, now);
  assert.deepEqual(lease, { kind: 'session', owner: 'worker-a', epoch: 1, dueAt: at(90_000) });
  const row = obligationOf(fixture.queued, items, now);
  assert.equal(row?.kind, 'action');
  assert.ok(row && row.kind === 'action' && row.action === 'dispatch' && Date.parse(row.dueAt) > now.getTime());
  const wait = obligationOf(fixture.dependent, items, now);
  assert.deepEqual(wait && { kind: wait.kind, dueAt: wait.dueAt }, { kind: 'wait', dueAt: at(90_000) }, 'a wait on another item is due when that item\'s own obligation is');
  assert.equal(livenessViolations([fixture.backlog, fixture.done], now).length, 0, 'backlog and done items are not open work');

  // A wait the item names for itself holds only until its deadline.
  const merged = item('GY-19', { stage: 'merge', candidate, observation: observed({ merged: true, mergeSha: 'd'.repeat(40), mergedAt: at(-10 * 60_000) }), gates: passed('ready', 'build', 'review', 'test', 'acceptance', 'merge') });
  const settled = obligationOf(merged, [merged], now);
  assert.ok(settled && settled.kind === 'wait' && settled.wait === 'settled' && settled.dueAt === at(livenessWaitBoundMs - 10 * 60_000));
  const later = new Date(now.getTime() + livenessWaitBoundMs);
  assert.deepEqual(livenessViolations([merged], later).map(entry => [entry.state, entry.reason]), [['stranded-merge', 'GY-19\'s PR #71 merged as dddddddddddd and its delivery is not recorded']]);
  // A lease that lapsed is not a session, and the violation dates from its expiry.
  const lapsed = item('GY-20', { lease: { owner: 'worker-c', epoch: 1, expiresAt: at(-5 * 60_000) }, submission: { epoch: 1, pr: 74 }, candidate, stage: 'merge', observation: observed(), gates: passed('ready', 'build', 'review', 'test', 'acceptance', 'merge') });
  const lost = livenessViolations([lapsed], now);
  assert.equal(lost[0]?.since, at(-5 * 60_000));
  assert.equal(lost[0]?.ageMs, 5 * 60_000);
});

test('unit:violations-get-successor-actions — one tick gives each violation exactly one successor for its state, the next tick adds none, and a successor failing N times for one reason is escalated', () => {
  const fixture = board(), items = all(fixture);
  const first = livenessTick(items, now);
  assert.deepEqual(livenessViolations(items, now), [], 'every violation is repaired within the tick that saw it');
  const rows = (work: Work) => work.actionQueue?.actions ?? [];
  const expected: [Work, string, string | null][] = [
    [fixture.stranded, 'merge', null], [fixture.unmerged, 'merge', null], [fixture.failed, 'request-rework', null],
    [fixture.refused, 'escalate', 'scope'], [fixture.orphaned, 'escalate', 'stale-wait'],
  ];
  for (const [work, kind, trigger] of expected) {
    assert.equal(rows(work).length, 1, `${work.key} holds exactly one row`);
    assert.equal(rows(work)[0].kind, kind, `${work.key} is repaired by ${kind}`);
    if (trigger) assert.equal((rows(work)[0].inputs as { trigger: string }).trigger, trigger);
    assert.equal(first.find(entry => entry.key === work.key)!.transitions.filter(entry => entry.event === 'requested').length, 1);
  }
  assert.match(fixture.stranded.nextAction!.reason, /^reconcile-merge: /);
  assert.match(fixture.refused.nextAction!.reason, /^scope-decision: /);
  assert.match((rows(fixture.refused)[0].inputs as { detail: string }).detail, /graphyard master decide GY-17 requirements/);
  // Owned items are left exactly as they are: the lease, the queued row and the named wait stand.
  assert.equal(rows(fixture.leased).length, 0);
  assert.equal(rows(fixture.dependent).length, 0);
  assert.equal(rows(fixture.queued).length, 1);

  // The next tick recognises every row it queued: no duplicate, no churn.
  const ids = items.map(work => rows(work).map(row => row.id).join());
  const second = livenessTick(items, new Date(now.getTime() + 30_000));
  assert.deepEqual(second.flatMap(entry => entry.transitions), [], 'the same violation names the same row');
  assert.deepEqual(items.map(work => rows(work).map(row => row.id).join()), ids);
  // Deduplicated by reason: the same reason binds the same successor, a different one another.
  const again = successorAction(fixture.orphaned, 'stale-wait', 'GY-18 waits on dependency GY-9 past its deadline: x');
  assert.equal(successorAction(fixture.orphaned, 'stale-wait', 'GY-18 waits on dependency GY-9 past its deadline: x').binding, again.binding);
  assert.notEqual(successorAction(fixture.orphaned, 'stale-wait', 'GY-18 waits on dependency GY-9 past its deadline: y').binding, again.binding);

  // The stranded merge's successor fails, again and again, for one unchanged reason.
  const executor = { id: 'executor-1', host: 'machine-a', principal: 'coordinator' };
  const stranded = fixture.stranded, reason = 'Merge gate refused: Merge queue position 2 of 2: GY-9 is ahead';
  let clock = now.getTime() + 60_000;
  const fail = (why: string) => {
    const claimed = claimAction(items, executor, new Date(clock), { work: stranded.key, kinds: ['merge'] });
    assert.ok(claimed, `the successor is offered at attempt ${stranded.actionQueue!.actions[0].attempts + 1}`);
    settleAction(stranded, claimed!.row.id, { executor: executor.id, principal: executor.principal }, 'failed', why, new Date(clock));
    clock += 11 * 60_000;
    livenessTick(items, new Date(clock));
  };
  assert.equal(livenessFailureLimit, actionStallThreshold);
  for (let attempt = 1; attempt < livenessFailureLimit; attempt += 1) fail(reason);
  assert.equal(rows(stranded)[0].kind, 'merge', `after ${livenessFailureLimit - 1} identical failures the successor is still retried`);
  fail(reason);
  assert.deepEqual(rows(stranded).map(row => row.kind), ['escalate'], 'the Nth identical failure converts it to one escalation');
  const escalation = rows(stranded)[0];
  assert.equal((escalation.inputs as { trigger: string }).trigger, 'liveness');
  assert.match(escalation.reason, new RegExp(`failed ${livenessFailureLimit} times for one unchanged reason \\(${reason.replace(/[()]/g, '\\$&')}\\)`));
  assert.ok(stranded.actionQueue!.history.some(row => row.kind === 'merge' && row.history.at(-1)?.event === 'cancelled'), 'the merge row is retired, with why');
  // And it stays converted: later ticks neither retry the merge nor add a second escalation.
  for (let tick = 0; tick < 3; tick += 1) {
    clock += 11 * 60_000;
    const next = livenessTick(items, new Date(clock)).find(entry => entry.key === stranded.key)!;
    assert.deepEqual(next.transitions.filter(entry => entry.event === 'requested'), []);
    assert.deepEqual(rows(stranded).map(row => row.id), [escalation.id]);
  }

  // Failures whose reason keeps changing are retries, not a stall: nothing is converted.
  const orphan = item('GY-30', { stage: 'merge', candidate, submission: { epoch: 1, pr: 80 }, observation: observed(),
    gates: [...passed('ready', 'build', 'review', 'test', 'acceptance'), { name: 'merge', passed: false, reasons: ['Merge queue position 2 of 2: GY-99 is ahead'] }] });
  clock = now.getTime();
  livenessTick([orphan], new Date(clock));
  for (let attempt = 1; attempt <= livenessFailureLimit + 1; attempt += 1) {
    const claimed = claimAction([orphan], executor, new Date(clock + 1), { work: orphan.key })!;
    settleAction(orphan, claimed.row.id, { executor: executor.id, principal: executor.principal }, 'failed', `transient failure ${attempt}`, new Date(clock + 1));
    clock += 11 * 60_000;
    livenessTick([orphan], new Date(clock));
  }
  assert.deepEqual(rows(orphan).map(row => row.kind), ['merge'], 'a successor whose failures keep changing is retried');
  assert.equal(livenessNext(orphan, [orphan], new Date(clock))!.kind, 'merge');
});

/** A repository `master status` accepts, with its loop cursor written. */
async function statusHost() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-liveness-root-')), secrets = await mkdtemp(join(tmpdir(), 'graphyard-liveness-secrets-'));
  execFileSync('git', ['init', '-q', root]);
  const credentialFile = join(secrets, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(48, 'x'), { mode: 0o600 });
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [],
    operatorAgent: { id: 'graphyard-master-operator', credentialFile }, approver: { id: 'graphyard-approver', credentialFile }, run: { proofWorkflow: 'acceptance.yml' } });
  await writeDaemonState(master, emptyDaemonState(master));
  return { root, master, cleanup: () => Promise.all([rm(root, { recursive: true, force: true }), rm(secrets, { recursive: true, force: true })]) };
}

test('unit:liveness-count-reported — master status reports the count of liveness violations with each one\'s age, and the count is zero once the fixture board settles through the engine', async t => {
  const host = await statusHost();
  t.after(host.cleanup);
  const report = async (work: Work[]) => {
    const masterApi = async (path: string) => path === 'work-snapshot' ? { work: structuredClone(work), now: now.toISOString() } : { decisions: [] };
    return masterStatusReport(host.root, host.master, masterApi, { actor: { id: 'coordinator-1' } }, { commit: null }) as Promise<any>;
  };
  const fixture = board(), items = all(fixture);
  const before = await report(items);
  assert.equal(before.counts.liveness, 5, 'the count of open items nothing owns');
  assert.equal(before.liveness.violations, 5);
  assert.deepEqual(before.liveness.items.map((entry: { key: string }) => entry.key).sort(), ['GY-14', 'GY-15', 'GY-16', 'GY-17', 'GY-18']);
  for (const entry of before.liveness.items) assert.ok(typeof entry.ageMs === 'number' && entry.ageMs > 0 && entry.since, `${entry.key} is reported with its age`);
  assert.equal(before.liveness.oldestMs, Math.max(...before.liveness.items.map((entry: { ageMs: number }) => entry.ageMs)));

  // The board settles the way the server settles it: the reconciliation tick evaluates each open
  // item through the engine — real gates, real action computation, the liveness repair — in turn.
  const engine = new Engine({} as Store, [15368], 120, 'owner/project');
  for (let pass = 0; pass < 2; pass += 1) for (const work of items) if (work.stage !== 'done') engine.evaluate(work, items, now);
  const after = await report(items);
  assert.equal(after.counts.liveness, 0, `no open item is left without an owned next step: ${JSON.stringify(after.liveness.items)}`);
  assert.deepEqual(after.liveness, { violations: 0, oldestMs: null, items: [] });
  for (const work of items.filter(entry => entry.ready && entry.stage !== 'done')) assert.ok(obligationOf(work, items, now), `${work.key} is owned after settling`);
});
