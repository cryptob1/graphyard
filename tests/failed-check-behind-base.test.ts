import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseRefreshNeeded, pendingBaseRefresh, refreshInFlight, type BaseRefresh } from '../src/merge-queue.js';
import { evaluate, Refusal, type Evidence, type Observation, type Work } from '../src/model.js';
import { nextAction, refusalAction } from '../src/model/next-action.js';
import { failedCheckRework } from '../src/daemon/decisions.js';
import { GitHub } from '../src/github.js';

// GY-534: four decision faults in 24 hours, one shared cause. On 2026-09-26 main gained the fix
// for a clock timebomb (PR #284, 61a9670f1 → 147272e15); GY-392, GY-430 and GY-522 had candidates
// bound to the older base 4c6c9a6ae, whose `test` check failed on exactly that timebomb. The test
// gate mapped each failed check straight to `request-rework`, so the loop owed a two-party "needs a
// new head" decision for each (three owed-decision faults), and the approver refused GY-392's on
// the grounds that the failure is upstream and already fixed (the decision-refused fault) — which
// left GY-392 owing the same decision again. Each instance is reproduced below with the record
// shape it had, and each test fails against the base (the refusal maps to request-rework, no base
// refresh is owed) and passes against the candidate (the control plane refreshes the base itself).

const ciAppIds = [15368];
const commit = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const now = new Date('2026-09-26T07:43:43.424Z');
const staleBase = commit('4c6c9a6ae'), fixedMain = commit('147272e15');
const failedTest = 'Required CI check test has not passed on the current candidate';

function observation(item: Work, overrides: Partial<Observation> = {}): Observation {
  return {
    candidate: { ...item.candidate! }, checks: [{ name: 'test', result: 'failure', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    // Each item had passed review; the failed check was the only thing standing.
    reviews: [{ reviewer: 'reviewer', sha: item.candidate!.sha, state: 'APPROVED' }], merged: false, mergeSha: null, mergeable: true, protected: true, prState: 'open', draft: false,
    // Main moved on to the timebomb fix: the head does not contain it but merges cleanly with it.
    baseTip: fixedMain, baseTree: commit('b1'), baseTipContained: false, files: ['src/engine.ts'], scopeFiles: [], at: now.toISOString(), ...overrides,
  };
}
function work(key: string, head: string, overrides: Partial<Observation> = {}): Work {
  const item = {
    id: key.toLowerCase(), key, title: key, description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:policy'] }], policy: { checks: ['test', 'typecheck'], review: true },
    plannedFiles: ['src/engine.ts'], stage: 'test', revision: 7, policyRevision: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    stageEnteredAt: now.toISOString(), ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'machine', path: `/tmp/${key}`, branch: `graphyard/${key.toLowerCase()}-1`, epoch: 1, owner: 'agent' }],
    candidate: { sha: head, baseSha: staleBase, pr: 1, branch: `graphyard/${key.toLowerCase()}-1`, author: 'agent' },
    submission: { epoch: 1, pr: 1 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: null, blocker: null, gates: [], violations: [],
  } as unknown as Work;
  item.observation = observation(item, overrides);
  item.evidence = [{ id: `e-${key}`, proof: 'unit:policy', sha: head, baseSha: staleBase, policyRevision: 1, producer: 'ci-runner', trusted: true, result: 'pass', executed: 4, skipped: 0, at: now.toISOString() } as Evidence];
  return evaluated(item);
}
function evaluated(item: Work): Work {
  const result = evaluate(item, [item], now, ciAppIds);
  return { ...item, stage: result.stage, gates: result.gates };
}
const testRefusal = (item: Work) => item.gates.find(gate => gate.name === 'test')!.reasons;

/** The four listed instances, as the item's own evidence names them. */
const instances = [
  { id: 'owed-decision|GY-392|2026-09-26T07:43:43.424Z', key: 'GY-392', head: commit('e1071e43d838') },
  { id: 'owed-decision|GY-430|2026-09-26T07:43:43.424Z', key: 'GY-430', head: commit('d430') },
  { id: 'decision-refused|GY-392|2026-09-26T07:44:52.519Z', key: 'GY-392', head: commit('e1071e43d838') },
  { id: 'owed-decision|GY-522|2026-09-26T07:44:52.519Z', key: 'GY-522', head: commit('d522') },
];

for (const instance of instances) {
  test(`manual:fault-class-decision — ${instance.id}: a required check that failed on a head behind the fixed base tip owes no rework decision; the control plane brings the head onto the tip itself`, () => {
    const item = work(instance.key, instance.head);
    assert.deepEqual(testRefusal(item), [failedTest], 'the test gate refuses the head, exactly as it did for the instance');
    // Base behaviour: request-rework, "needs a new head", the owed two-party decision.
    assert.equal(refusalAction(item, 'test', failedTest), 'resync', 'the fresh reading that runs the base refresh answers it, not a rework decision');
    const action = nextAction(item, [item], now);
    assert.equal(action?.kind, 'resync');
    assert.doesNotMatch(action!.reason, /needs a new head/);
    assert.equal(failedCheckRework(item), null, 'the loop asks no worker for a new head while the base refresh is owed');
    assert.deepEqual(baseRefreshNeeded(item), { head: instance.head, boundBase: staleBase, baseTip: fixedMain, trigger: 'failed check behind base', check: 'test' });
    assert.deepEqual(pendingBaseRefresh(item), { baseTip: fixedMain, boundBase: staleBase, trigger: 'failed check behind base', check: 'test' });
  });
}

test('manual:fault-class-decision — decision-refused|GY-392: once the refreshed head contains the fixed tip, a check that passes clears the gate, and one that still fails is the head\'s own and goes back to its worker', () => {
  const head = commit('e1071e43d838'), refreshed = commit('e2');
  const refresh: BaseRefresh = { from: { sha: head, baseSha: staleBase }, base: fixedMain, baseTree: commit('b1'), policyRevision: 1, at: now.toISOString(),
    head: refreshed, conflict: null, merge: null, carry: null, trigger: 'failed check behind base' };
  const onTip = (result: string) => {
    const item = work('GY-392', head);
    const moved = { ...item, candidate: { ...item.candidate!, sha: refreshed, baseSha: fixedMain }, baseRefresh: refresh } as Work;
    moved.observation = observation(moved, { baseTipContained: true, checks: [{ name: 'test', result, appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }] });
    return evaluated(moved);
  };
  const passing = onTip('success');
  assert.deepEqual(testRefusal(passing), [], 'the timebomb fix on the base is what the check needed');
  assert.equal(baseRefreshNeeded(passing), null);
  const failing = onTip('failure');
  assert.equal(refusalAction(failing, 'test', failedTest), 'request-rework', 'a failure on a head containing the tip is the head\'s own');
  assert.ok(failedCheckRework(failing));
  // The same refreshed head, behind a base that moved again: one refresh per worker head, so a
  // genuinely broken head is not refreshed forever while main keeps moving.
  const behindAgain = { ...failing, observation: { ...failing.observation!, baseTip: commit('f3'), baseTipContained: false } } as Work;
  assert.equal(baseRefreshNeeded(behindAgain), null);
  assert.equal(refusalAction(behindAgain, 'test', failedTest), 'request-rework');
});

for (const instance of instances) test(`manual:fault-class-decision — ${instance.id}: between binding the refresh and observing the head it published, the old failure owes no rework decision and the worker head is not refreshed again`, () => {
  // The refresh is bound (engine.bindBaseRefresh) while the candidate and observation still name
  // the old, failing head: the state the reviewer of PR #366 found owing the rework again.
  const refreshed = commit('e2');
  const bound = (item: Work): Work => evaluated({ ...item, baseRefresh: { from: { sha: instance.head, baseSha: staleBase }, base: fixedMain, baseTree: commit('b1'), policyRevision: 1,
    at: now.toISOString(), head: refreshed, conflict: null, merge: null, carry: null, trigger: 'failed check behind base' } } as Work);
  const item = bound(work(instance.key, instance.head));
  assert.deepEqual(testRefusal(item), [failedTest], 'the gate still refuses the old head it reads');
  assert.ok(refreshInFlight(item));
  assert.equal(refusalAction(item, 'test', failedTest), 'resync', 'the reading that sees the refreshed head answers it');
  const action = nextAction(item, [item], now);
  assert.equal(action?.kind, 'resync');
  assert.doesNotMatch(action!.reason, /needs a new head/);
  assert.equal(failedCheckRework(item), null, 'no rework decision is owed for the failure the refresh answered');
  assert.equal(baseRefreshNeeded(item), null, 'the refresh ran: nothing refreshes it again');
  // Main moves again before the observation: still one refresh per worker head.
  const movedAgain = bound(work(instance.key, instance.head, { baseTip: commit('f3') }));
  assert.equal(baseRefreshNeeded(movedAgain), null);
  assert.equal(failedCheckRework(movedAgain), null);
  // A reading taken after the refresh that still shows the old head ends the window: the push did
  // not stick, and the failure goes back to the worker rather than holding the item forever.
  const later = new Date(now.getTime() + 60_000).toISOString();
  const unstuck = bound(work(instance.key, instance.head, { at: later }));
  assert.equal(refreshInFlight(unstuck), null);
  assert.equal(refusalAction(unstuck, 'test', failedTest), 'request-rework');
  assert.ok(failedCheckRework(unstuck));
});

test('manual:fault-class-decision — a failed check behind a base the control plane cannot merge in goes back to the worker with the conflict named', () => {
  const head = commit('d522');
  const item = work('GY-522', head);
  const conflicted = { ...item, baseRefresh: { from: { sha: head, baseSha: staleBase }, base: fixedMain, baseTree: commit('b1'), policyRevision: 1, at: now.toISOString(),
    head: null, conflict: 'Required check test failed … cannot be brought onto it without resolving a conflict', merge: null, carry: null, trigger: 'failed check behind base' } } as Work;
  assert.equal(baseRefreshNeeded(conflicted), null, 'one attempt per head, base tip and policy revision');
  assert.equal(refusalAction(conflicted, 'test', failedTest), 'request-rework');
  assert.ok(failedCheckRework(conflicted));
  // A head that contains the tip and fails is rework, as it always was; no refresh is owed.
  const current = evaluated({ ...item, observation: observation(item, { baseTip: staleBase, baseTipContained: true }) });
  assert.equal(baseRefreshNeeded(current), null);
  assert.equal(refusalAction(current, 'test', failedTest), 'request-rework');
});

test('manual:fault-class-decision — the refresh merges the base tip into the candidate\'s own branch so CI answers again against it; a conflict writes nothing and is named', async () => {
  const head = commit('e1071e43d838'), refreshed = commit('e2');
  const calls: { path: string; method: string; body: any }[] = [];
  let merge: { sha: string } | 'conflict' = { sha: refreshed };
  const github = new GitHub({ repository: 'owner/repo', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used-in-adapter-test' });
  github.controlPlaneLogin = async () => 'graphyard-owner-repo[bot]';
  github.request = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (path === '/merges' && method === 'POST') { if (merge === 'conflict') throw new Refusal('GitHub POST /merges failed (409)', 502); return merge; }
    if (path === '/pulls/1') return { number: 1, head: { sha: head, ref: 'graphyard/gy-392-1' }, base: { ref: 'main' }, state: 'open', draft: false };
    if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: fixedMain } };
    if (/^\/commits\//.test(path)) return { sha: path.slice(9), commit: { tree: { sha: commit('b1') }, author: { email: 'noreply@github.com' } }, parents: [{ sha: head }, { sha: fixedMain }], author: { login: 'graphyard-owner-repo[bot]' } };
    if (path.startsWith('/compare/')) return { status: 'diverged', files: [] };
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  const item = work('GY-392', head);
  const refresh = await github.refreshCandidateBase(item);
  assert.deepEqual([refresh.trigger, refresh.head, refresh.conflict, refresh.base, refresh.from], ['failed check behind base', refreshed, null, fixedMain, { sha: head, baseSha: staleBase }]);
  const merges = calls.filter(call => call.path === '/merges');
  assert.equal(merges.length, 1, 'no scratch-branch test merge: the merge is the refresh');
  assert.deepEqual([merges[0].body.base, merges[0].body.head], ['graphyard/gy-392-1', fixedMain]);
  assert.doesNotMatch(merges[0].body.commit_message, /skip ci/, 'CI must answer on the refreshed head');

  calls.length = 0; merge = 'conflict';
  const conflicted = await github.refreshCandidateBase(item);
  assert.equal(conflicted.head, null);
  assert.match(conflicted.conflict!, /Required check test failed on candidate .* Run graphyard sync GY-392, resolve it and push/);
  assert.deepEqual(calls.filter(call => call.method !== 'GET').map(call => `${call.method} ${call.path}`), ['POST /merges'], 'a conflicting merge writes nothing');
});
