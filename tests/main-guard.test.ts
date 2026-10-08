import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import { generateKeyPairSync } from 'node:crypto';
import * as mainGuard from '../src/main-guard.js';
import { applyMainGuardRevert, commitVerdict, mainGuardAttention, readMain, revertInverseRefusal, runMainGuard, type CheckRun, type MainGuardRevert, type FileChange, type MainCommit, type MainGuardPorts } from '../src/main-guard.js';
import { GitHub } from '../src/github.js';
import { mergeStep } from '../src/daemon/cycle-delivery.js';
import { emptyDaemonState, pruneDaemonState, retainedActions } from '../src/daemon/state.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { MasterConfig } from '../src/master.js';

// GY-1250: under GitHub delivery a merge that breaks main is reverted through a revert pull request
// the App merges, and its item is reopened; a revert that cannot merge is given up after one attempt.
// Each test is named for the proof it produces.
// A namespace read, so these proofs fail as test cases on a base without GY-1332, not as a load error.
const revertLandingAttempts = (mainGuard as { revertLandingAttempts?: number }).revertLandingAttempts ?? 3;
const sha = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const ci = 15368, required = ['test', 'typecheck'];
const at = '2026-10-05T08:00:00.000Z';

function delivered(key: string, mergeSha: string, pr: number): Work {
  return { id: `id-${key}`, key, title: key, description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: [], criteria: [],
    policy: { checks: required, review: true }, stage: 'done', revision: 3, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
    workspaces: [], candidate: { sha: sha(`c${pr}`), baseSha: sha('b0'), pr, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' }, submission: { epoch: 1, pr }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, violations: [], gates: [], delivery: { mergedAt: at, mergeSha, authorizationRevision: 1 } } as unknown as Work;
}
const runs = (results: Record<string, string>): CheckRun[] => Object.entries(results).map(([name, result], id) => ({ name, result, appId: ci, id }));
const green = runs({ test: 'success', typecheck: 'success' });

/** What a merge changed: one file, two lines replaced by one. */
const mergeDiff = (mergeSha: string): FileChange[] => [
  { filename: 'docs/delivery.md', status: 'modified', patch: `@@ -10,4 +10,3 @@ intro\n context\n-old line one ${mergeSha.slice(0, 4)}\n-old line two\n+new line\n context` },
  { filename: 'src/added.ts', status: 'added', patch: '@@ -0,0 +1,2 @@\n+export const a = 1;\n+export const b = 2;' },
];
/** The exact inverse of a diff, as GitHub lists the revert pull request's files: line numbers shifted by a later merge. */
const inverseOf = (diff: FileChange[]): FileChange[] => diff.map(change => ({ ...change, status: change.status === 'added' ? 'removed' : change.status === 'removed' ? 'added' : change.status,
  patch: change.patch!.split('\n').map(line => line.startsWith('@@') ? '@@ -40,3 +40,4 @@ moved' : line.startsWith('-') ? `+${line.slice(1)}` : line.startsWith('+') ? `-${line.slice(1)}` : line).join('\n') }));

/**
 * A fake GitHub: main's history, the check runs on each commit, and the revert pull requests the
 * guard opens. Like the protected branch (GY-1291) it requires an approval of the head from someone
 * other than the last pusher, and the App that opened the revert pushed it.
 */
function world(history: MainCommit[], items: Work[]) {
  const checks = new Map<string, CheckRun[]>();
  const pulls = new Map<number, { merged: boolean; mergeSha: string | null; open: boolean; mergeable: boolean | null; head: string }>();
  const pushers = new Map<number, string>(), approvals = new Map<number, { by: string; head: string }[]>(), revertDiffs = new Map<number, FileChange[]>();
  const calls = { opened: [] as string[], merged: [] as number[], closed: [] as { pr: number; reason: string }[], approved: [] as number[] };
  let next = 900, refuse: string | null = null;
  const ports: MainGuardPorts = {
    reverting: async () => items.filter(work => work.mainGuardReverts?.some(revert => revert.state === 'opened')),
    culprit: async mergeSha => items.find(work => work.delivery?.mergeSha === mergeSha || work.mainGuardReverts?.some(revert => revert.mergeSha === mergeSha)) ?? null,
    history: async () => history,
    checks: async commit => checks.get(commit) ?? [],
    openRevert: async (_work, mergeSha) => {
      calls.opened.push(mergeSha);
      if (refuse) return { refusal: refuse };
      const pr = next++, head = sha(`e${pr}`);
      pulls.set(pr, { merged: false, mergeSha: null, open: true, mergeable: true, head });
      pushers.set(pr, 'graphyard-app'); revertDiffs.set(pr, inverseOf(mergeDiff(mergeSha)));
      return { pr, head };
    },
    pull: async pr => pulls.get(pr)!,
    mergeChanges: async mergeSha => mergeDiff(mergeSha),
    revertChanges: async pr => revertDiffs.get(pr)!,
    approveRevert: async (pr, head) => {
      calls.approved.push(pr);
      approvals.set(pr, [...approvals.get(pr) ?? [], { by: 'revert-approver[bot]', head }]);
      return 'approved';
    },
    mergeRevert: async (_work, revert) => {
      // Branch protection: require_last_push_approval, enforced for admins and the App alike.
      if (!(approvals.get(revert.pr) ?? []).some(approval => approval.head === revert.head && approval.by !== pushers.get(revert.pr))) throw new Error('New changes require approval from someone other than the last pusher.');
      calls.merged.push(revert.pr);
      const merge = sha(`d${revert.pr}`);
      pulls.set(revert.pr, { ...pulls.get(revert.pr)!, merged: true, open: false, mergeSha: merge });
      return merge;
    },
    closeRevert: async (pr, reason) => { calls.closed.push({ pr, reason }); pulls.set(pr, { ...pulls.get(pr)!, open: false }); },
    record: async (snapshot, revert) => { applyMainGuardRevert(items.find(work => work.id === snapshot.id)!, revert, new Date(at)); },
  };
  return { ports, checks, pulls, calls, items, revertDiffs, approvals, refuse: (reason: string | null) => { refuse = reason; } };
}

test('unit:main-guard-reverts-breaking-merge a merge that fails a check its parent passed is reverted by an App-merged revert PR and its item reopened', async () => {
  // Main: base → A → B → C. A left every check green; B broke the docs budget test; C, merged on top, inherits the failure.
  const [base, A, B, C] = ['b0', 'a1', 'b2', 'c3'].map(sha);
  const history: MainCommit[] = [{ sha: C, parent: B }, { sha: B, parent: A }, { sha: A, parent: base }, { sha: base, parent: null }];
  const itemA = delivered('GY-1', A, 701), itemB = delivered('GY-2', B, 702), itemC = delivered('GY-3', C, 703);
  const fake = world(history, [itemA, itemB, itemC]);
  fake.checks.set(base, green); fake.checks.set(A, green);
  fake.checks.set(B, runs({ test: 'failure', typecheck: 'success' })); fake.checks.set(C, runs({ test: 'failure', typecheck: 'success' }));
  const options = { required, ciAppIds: [ci], now: new Date(at) };

  // Tick 1: B, not A (nor C, whose parent was already red), is named and its revert opened.
  let tick = await runMainGuard(fake.ports, options);
  assert.deepEqual(tick.main, { state: 'broken', culprit: B, parent: A, failing: ['test'] });
  assert.deepEqual(fake.calls.opened, [B]);
  assert.equal(itemB.mainGuardReverts?.[0].state, 'opened');
  assert.equal(itemA.mainGuardReverts, undefined); assert.equal(itemC.mainGuardReverts, undefined);
  const revert = itemB.mainGuardReverts![0].revert!;

  // Tick 2: the revert's own required checks are running, so it is not merged yet and nothing is reopened.
  tick = await runMainGuard(fake.ports, options);
  assert.deepEqual(fake.calls.merged, []);
  assert.deepEqual(fake.calls.opened, [B], 'the same broken merge is never reverted twice');
  assert.equal(itemB.stage, 'done');

  // Tick 3: the revert's checks pass, the App merges it, and B's item is reopened naming the failing check and merge commit.
  fake.checks.set(revert.head, green);
  tick = await runMainGuard(fake.ports, options);
  assert.deepEqual(fake.calls.merged, [revert.pr]);
  assert.equal(itemB.mainGuardReverts![0].state, 'merged');
  assert.equal(itemB.stage, 'ready');
  assert.equal(itemB.delivery, undefined);
  assert.equal(itemB.submission, null);
  assert.match(itemB.mainGuardReverts![0].reason!, /GY-2's merge b2f*.{0,12} \(PR #702\) broke main: test failed on that merge commit/);
  assert.ok(itemB.mainGuardReverts![0].reason!.includes(B.slice(0, 12)));
  assert.ok(itemB.mainGuardReverts![0].reason!.includes(`PR #${revert.pr}`));
  // A and C stay delivered: only the merge that broke main is withdrawn.
  assert.equal(itemA.stage, 'done'); assert.equal(itemA.delivery?.mergeSha, A);
  assert.equal(itemC.stage, 'done'); assert.equal(itemC.delivery?.mergeSha, C);
  assert.deepEqual(mainGuardAttention(fake.items), [], 'a merged revert raises no attention');
});

test('unit:main-guard-reverts-breaking-merge reading main names no culprit while it is green, or while the commit after the last green one is still running', async () => {
  const verdicts: Record<string, string> = {};
  const verdict = async (commit: string) => ({ pass: { verdict: 'pass' as const }, fail: { verdict: 'fail' as const, failing: ['test'] }, pending: { verdict: 'pending' as const } })[verdicts[commit] as 'pass'];
  const history: MainCommit[] = [{ sha: 'c', parent: 'b' }, { sha: 'b', parent: 'a' }, { sha: 'a', parent: null }];
  Object.assign(verdicts, { c: 'pass', b: 'fail', a: 'pass' });
  assert.deepEqual(await readMain(history, verdict), { state: 'green' });
  Object.assign(verdicts, { c: 'fail', b: 'pending', a: 'pass' });
  assert.deepEqual(await readMain(history, verdict), { state: 'pending', probe: 'b' });
  Object.assign(verdicts, { c: 'fail', b: 'fail', a: 'fail' });
  assert.deepEqual(await readMain(history, verdict), { state: 'unknown' });
  // Only the CI apps' runs count, and the latest run of each required check decides.
  assert.deepEqual(commitVerdict([{ name: 'test', result: 'failure', appId: 1 }, ...green], required, [ci]), { verdict: 'pass' });
  assert.deepEqual(commitVerdict([{ name: 'test', result: 'failure', appId: ci, id: 1 }, { name: 'test', result: 'success', appId: ci, id: 2 }, { name: 'typecheck', result: 'success', appId: ci }], required, [ci]), { verdict: 'pass' });
  assert.deepEqual(commitVerdict(runs({ test: 'success' }), required, [ci]), { verdict: 'pending' });
});

test('unit:main-guard-never-sticks a revert that conflicts or whose checks fail is closed after one attempt, raises one attention line, and the next red main is handled afresh', async () => {
  const [base, A, B, D, E] = ['b0', 'a1', 'b2', 'd4', 'e5'].map(sha);
  const history: MainCommit[] = [{ sha: B, parent: A }, { sha: A, parent: base }, { sha: base, parent: null }];
  const itemA = delivered('GY-1', A, 701), itemB = delivered('GY-2', B, 702), itemD = delivered('GY-4', D, 704), itemE = delivered('GY-5', E, 705);
  const fake = world(history, [itemA, itemB, itemD, itemE]);
  fake.checks.set(base, green); fake.checks.set(A, green); fake.checks.set(B, runs({ test: 'failure', typecheck: 'success' }));
  const options = { required, ciAppIds: [ci], now: new Date(at) };

  // A revert that conflicts with main is abandoned on its one attempt: no PR, one attention line.
  fake.refuse(`the revert of ${B.slice(0, 12)} conflicts with main's tip: a later merge changed the same lines`);
  await runMainGuard(fake.ports, options);
  assert.deepEqual(fake.calls.opened, [B]);
  assert.equal(itemB.mainGuardReverts![0].state, 'abandoned');
  assert.equal(itemB.stage, 'done', 'an abandoned revert reopens nothing');
  let lines = mainGuardAttention(fake.items);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].key, `escalation:main-guard:${B}`);
  assert.match(lines[0].text, new RegExp(`GY-2's merge ${B.slice(0, 12)} \\(PR #702\\) broke main \\(test\\).*no revert PR.*conflicts`));

  // Main is still red on B: the guard does not try B again, and holds nothing.
  fake.refuse(null);
  await runMainGuard(fake.ports, options);
  assert.deepEqual(fake.calls.opened, [B]);
  assert.equal(mainGuardAttention(fake.items).length, 1, 'still exactly one attention line');

  // Main is fixed forward (D passes), then E breaks it again: the next red main is handled afresh.
  history.unshift({ sha: D, parent: B });
  history.unshift({ sha: E, parent: D });
  fake.checks.set(D, green); fake.checks.set(E, runs({ test: 'success', typecheck: 'failure' }));
  await runMainGuard(fake.ports, options);
  assert.deepEqual(fake.calls.opened, [B, E]);
  const revert = itemE.mainGuardReverts![0].revert!;

  // E's revert fails its own required checks: closed after that one attempt, never merged, one more attention line.
  fake.checks.set(revert.head, runs({ test: 'failure', typecheck: 'success' }));
  await runMainGuard(fake.ports, options);
  assert.deepEqual(fake.calls.merged, []);
  assert.deepEqual(fake.calls.closed.map(close => close.pr), [revert.pr]);
  assert.match(fake.calls.closed[0].reason, /after one attempt/);
  assert.equal(itemE.mainGuardReverts![0].state, 'abandoned');
  assert.equal(itemE.stage, 'done');
  lines = mainGuardAttention(fake.items);
  assert.equal(lines.length, 2);
  const line = lines.find(entry => entry.work === 'GY-5')!;
  assert.match(line.text, new RegExp(`GY-5's merge ${E.slice(0, 12)} \\(PR #705\\) broke main \\(typecheck\\).*revert PR #${revert.pr}.*own required checks failed: test`));

  // Nothing is left waiting: the next tick opens, merges and closes nothing.
  const before = JSON.stringify(fake.calls);
  const tick = await runMainGuard(fake.ports, options);
  assert.equal(JSON.stringify(fake.calls), before);
  assert.deepEqual(tick.errors, []);
  assert.equal(itemA.stage, 'done'); assert.equal(itemD.stage, 'done');
});

test('unit:main-guard-never-sticks a revert whose checks never conclude, or that GitHub refuses to merge, is closed rather than waited on', async () => {
  const [base, A, B] = ['b0', 'a1', 'b2'].map(sha);
  const history: MainCommit[] = [{ sha: B, parent: A }, { sha: A, parent: base }];
  const itemB = delivered('GY-2', B, 702);
  const fake = world(history, [itemB]);
  fake.checks.set(A, green); fake.checks.set(B, runs({ test: 'failure', typecheck: 'success' }));
  await runMainGuard(fake.ports, { required, ciAppIds: [ci], now: new Date(at) });
  const revert = itemB.mainGuardReverts![0].revert!;
  // An hour and a minute later the revert's checks have still not concluded.
  await runMainGuard(fake.ports, { required, ciAppIds: [ci], now: new Date(Date.parse(at) + 61 * 60_000) });
  assert.equal(itemB.mainGuardReverts![0].state, 'abandoned');
  assert.match(itemB.mainGuardReverts![0].reason!, /did not conclude within 60 minutes/);
  assert.deepEqual(fake.calls.closed.map(close => close.pr), [revert.pr]);

  // A merge GitHub keeps refusing is retried within the one attempt, then abandoned, not waited on (GY-1332).
  const C = sha('c3'), itemC = delivered('GY-3', C, 703), other = world([{ sha: C, parent: A }, { sha: A, parent: base }], [itemC]);
  other.checks.set(A, green); other.checks.set(C, runs({ test: 'failure', typecheck: 'success' }));
  other.ports.mergeRevert = async () => { throw new Error('Repository rule violations found'); };
  await runMainGuard(other.ports, { required, ciAppIds: [ci], now: new Date(at) });
  other.checks.set(itemC.mainGuardReverts![0].revert!.head, green);
  for (let tick = 0; tick < revertLandingAttempts; tick++) await runMainGuard(other.ports, { required, ciAppIds: [ci], now: new Date(at) });
  assert.equal(itemC.mainGuardReverts![0].state, 'abandoned');
  assert.match(itemC.mainGuardReverts![0].reason!, /GitHub refused to merge revert PR #900: Repository rule violations found/);
});

test('unit:main-guard-never-sticks an abandoned revert raises its attention line once across a simulated day, even after the cursor prunes that line\'s row', async () => {
  // The loop raises the line from the item's record every cycle it is missing from the cursor, and
  // the cursor retires its oldest resolved rows past `retainedActions`; "once" must survive that.
  const state = emptyDaemonState({ url: 'https://graphyard.example', repository: 'owner/project', autoMerge: true } as MasterConfig);
  const start = Date.parse(at), cycleMs = 30_000, fillerPerCycle = 20;
  const abandoned = (work: Work, mergeSha: string, settled: number) => {
    work.mainGuardReverts = [{ mergeSha, pr: work.submission!.pr, failing: ['test'], revert: null, state: 'abandoned', at: new Date(settled).toISOString(), settledAt: new Date(settled).toISOString(), revertSha: null, reason: 'the revert conflicts with main' }];
  };
  const B = sha('b2'), E = sha('e5'), itemB = delivered('GY-2', B, 702), itemE = delivered('GY-5', E, 705), itemA = delivered('GY-1', sha('a1'), 701);
  abandoned(itemB, B, start);
  const work = [itemA, itemB, itemE], raised: string[] = [];
  let pruned = false;
  for (let index = 0, clock = start; clock < start + 24 * 60 * 60_000; index++, clock += cycleMs) {
    // Halfway through the day a second revert is abandoned: it too is raised exactly once.
    if (index === 1440) abandoned(itemE, E, clock);
    const performed: { kind: string; work: string | null; detail: string }[] = [];
    await mergeStep({ config: { autoMerge: true }, state, now: () => clock, clock, snapshot: { jobs: [], work }, performed, open: [],
      effects: { persist: async () => undefined, snapshot: async () => ({ work }) },
      isolate: async (_kind: unknown, _item: unknown, _name: unknown, body: () => Promise<unknown>) => body() } as unknown as Cycle);
    raised.push(...performed.filter(action => action.kind === 'escalation' && action.detail.startsWith('Main guard:')).map(action => action.work!));
    // The rest of the cycle's work: resolved rows the cursor must bound.
    for (let row = 0; row < fillerPerCycle; row++) state.actions[`dispatch:filler:${index}:${row}`] = { kind: 'dispatch', work: null, principal: null, state: 'done', detail: 'filler', attempts: 1, epoch: null, cycle: index, at: new Date(clock).toISOString() } as never;
    pruneDaemonState(state);
    if (!state.actions[`escalation:main-guard:${B}`]) pruned = true;
  }
  assert.ok(pruned, `the day's ${fillerPerCycle} rows a cycle retire the line's row past the ${retainedActions}-row bound`);
  assert.deepEqual(raised, ['GY-2', 'GY-5'], 'each abandoned revert is raised exactly once');
  assert.equal(mainGuardAttention(work).length, 2, 'both reverts stay abandoned on their items');
});

test('unit:guard-revert-lands-under-protection a revert the App pushed is approved by the independent approver and merges under last-push approval, with no human', async () => {
  const [base, A, B] = ['b0', 'a1', 'b2'].map(sha);
  const itemB = delivered('GY-2', B, 702);
  const fake = world([{ sha: B, parent: A }, { sha: A, parent: base }], [itemB]);
  fake.checks.set(A, green); fake.checks.set(B, runs({ test: 'failure', typecheck: 'success' }));
  const options = { required, ciAppIds: [ci], now: new Date(at) };
  await runMainGuard(fake.ports, options);
  const revert = itemB.mainGuardReverts![0].revert!;

  // The protection is real: the App that pushed the revert cannot merge it on its own standing.
  await assert.rejects(fake.ports.mergeRevert(itemB, { ...revert, failing: ['test'] }), /approval from someone other than the last pusher/);
  assert.deepEqual(fake.calls.merged, []);

  // While the revert's checks run nothing is approved; once they pass, the exact inverse is approved at its head and merged.
  await runMainGuard(fake.ports, options);
  assert.deepEqual(fake.calls.approved, []);
  fake.checks.set(revert.head, green);
  const tick = await runMainGuard(fake.ports, options);
  assert.deepEqual(tick.errors, []);
  assert.deepEqual(fake.calls.approved, [revert.pr]);
  assert.deepEqual(fake.approvals.get(revert.pr), [{ by: 'revert-approver[bot]', head: revert.head }]);
  assert.deepEqual(fake.calls.merged, [revert.pr]);
  assert.equal(itemB.mainGuardReverts![0].state, 'merged');
  assert.equal(itemB.stage, 'ready', 'main is restored and the item reopened, with no reviewer round');
});

test('unit:guard-revert-lands-under-protection while GitHub has not merged an approved revert yet, later ticks neither re-read its diffs nor approve it again', async () => {
  const [base, A, B] = ['b0', 'a1', 'b2'].map(sha);
  const itemB = delivered('GY-2', B, 702);
  const fake = world([{ sha: B, parent: A }, { sha: A, parent: base }], [itemB]);
  fake.checks.set(A, green); fake.checks.set(B, runs({ test: 'failure', typecheck: 'success' }));
  const options = { required, ciAppIds: [ci], now: new Date(at), approved: new Set<string>() };
  await runMainGuard(fake.ports, options);
  const revert = itemB.mainGuardReverts![0].revert!;
  fake.checks.set(revert.head, green);
  // GitHub's auto-merge has not landed it yet: the merge call returns null for two ticks.
  const merge = fake.ports.mergeRevert, diffs = { merge: 0, revert: 0 };
  let pending = 2;
  fake.ports.mergeRevert = async (work, entry) => pending-- > 0 ? null : merge(work, entry);
  const [mergeChanges, revertChanges] = [fake.ports.mergeChanges, fake.ports.revertChanges];
  fake.ports.mergeChanges = async mergeSha => { diffs.merge++; return mergeChanges(mergeSha); };
  fake.ports.revertChanges = async pr => { diffs.revert++; return revertChanges(pr); };
  for (let tick = 0; tick < 3; tick++) assert.deepEqual((await runMainGuard(fake.ports, options)).errors, []);
  assert.deepEqual(diffs, { merge: 1, revert: 1 }, 'the diffs are compared once per head');
  assert.deepEqual(fake.calls.approved, [revert.pr], 'the head is approved once');
  assert.deepEqual(fake.calls.merged, [revert.pr]);
  assert.equal(itemB.mainGuardReverts![0].state, 'merged');
});

test('unit:guard-revert-lands-under-protection the GitHub client approves as the revert approver App, bound to the head, and never as the control-plane App', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const head = sha('e900'), requests: { method: string; url: string; body: any; auth: string }[] = [];
  let reviews: any[] = [];
  const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 7, privateKey: 'not-used', revertApprover: { appId: 5678, installationId: 9, privateKey } });
  github.fetch = (async (input: string, init: RequestInit) => {
    const method = init.method ?? 'GET', body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, url: String(input), body, auth: String((init.headers as Record<string, string>).Authorization) });
    if (String(input).endsWith('/app/installations/9/access_tokens')) return Response.json({ token: 'approver-installation-token', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
    if (String(input).includes('/pulls/900/reviews') && method === 'GET') return Response.json(reviews);
    if (String(input).endsWith('/pulls/900/reviews') && method === 'POST') {
      const review = { id: 1, state: 'APPROVED', commit_id: body.commit_id, performed_via_github_app: { id: 5678 } };
      reviews.push(review);
      return Response.json(review);
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;
  assert.equal(await github.approveRevert(900, head, 'exact inverse'), 'approved');
  const posted = requests.filter(request => request.method === 'POST' && request.url.endsWith('/reviews'));
  assert.deepEqual(posted.map(request => request.body), [{ commit_id: head, event: 'APPROVE', body: 'exact inverse' }]);
  assert.equal(posted[0].auth, 'Bearer approver-installation-token', 'the approval is the approver App\'s, not the App that pushed the revert');
  // An approval already standing on the head is not posted again.
  assert.equal(await github.approveRevert(900, head, 'exact inverse'), 'approved');
  assert.equal(requests.filter(request => request.method === 'POST' && request.url.endsWith('/reviews')).length, 1);
  // Without an approver the merge is attempted on the App's own standing; the control-plane App is never its own approver.
  assert.equal(await new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 7, privateKey: 'not-used' }).approveRevert(900, head, 'x'), 'unconfigured');
  await assert.rejects(new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 7, privateKey: 'not-used', revertApprover: { appId: 1234, installationId: 7, privateKey } }).approveRevert(900, head, 'x'), /other than the control-plane App/);
});

test('unit:guard-revert-exact-inverse-only a revert with one line altered is neither approved nor merged, and is closed', async () => {
  const merge = mergeDiff(sha('b2'));
  assert.equal(revertInverseRefusal(merge, inverseOf(merge)), null, 'the exact inverse passes, whatever its line numbers');
  // One line of the revert altered: refused.
  const altered = inverseOf(merge);
  altered[0] = { ...altered[0], patch: altered[0].patch!.replace('+old line two', '+old line 2') };
  assert.match(revertInverseRefusal(merge, altered)!, /docs\/delivery\.md is not exactly the inverse/);
  // An extra file, a missing file, a status that does not invert, and a file without a patch are refused too.
  assert.match(revertInverseRefusal(merge, [...inverseOf(merge), { filename: 'src/other.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }])!, /changes src\/other\.ts, which the merge did not/);
  assert.match(revertInverseRefusal(merge, inverseOf(merge).slice(1))!, /does not change docs\/delivery\.md/);
  assert.match(revertInverseRefusal(merge, inverseOf(merge).map(change => ({ ...change, status: 'modified' })))!, /src\/added\.ts is modified, not the inverse of the merge's added/);
  assert.match(revertInverseRefusal(merge, inverseOf(merge).map(change => ({ ...change, patch: null })))!, /no patch to compare/);

  // Through the guard: the altered revert's checks pass, yet it is never approved or merged, and is closed after its one attempt.
  const [base, A, B] = ['b0', 'a1', 'b2'].map(sha);
  const itemB = delivered('GY-2', B, 702);
  const fake = world([{ sha: B, parent: A }, { sha: A, parent: base }], [itemB]);
  fake.checks.set(A, green); fake.checks.set(B, runs({ test: 'failure', typecheck: 'success' }));
  const options = { required, ciAppIds: [ci], now: new Date(at) };
  await runMainGuard(fake.ports, options);
  const revert = itemB.mainGuardReverts![0].revert!;
  const diff = fake.revertDiffs.get(revert.pr)!;
  diff[0] = { ...diff[0], patch: diff[0].patch!.replace('-new line', '-new line, edited') };
  fake.checks.set(revert.head, green);
  await runMainGuard(fake.ports, options);
  assert.deepEqual(fake.calls.approved, []);
  assert.deepEqual(fake.calls.merged, []);
  assert.deepEqual(fake.calls.closed.map(close => close.pr), [revert.pr]);
  assert.equal(itemB.mainGuardReverts![0].state, 'abandoned');
  assert.match(itemB.mainGuardReverts![0].reason!, new RegExp(`revert PR #${revert.pr} is not exactly the inverse of merge ${B.slice(0, 12)}, so it is neither approved nor merged`));
  assert.equal(itemB.stage, 'done');
});

test('unit:main-guard-approval-refusal-retry an approval or merge the approval rule refuses is retried with a fresh approval and the App\'s bypass merge before the revert is abandoned', async () => {
  const [base, A, B] = ['b0', 'a1', 'b2'].map(sha);
  const setup = () => {
    const itemB = delivered('GY-2', B, 702), fake = world([{ sha: B, parent: A }, { sha: A, parent: base }], [itemB]);
    fake.checks.set(A, green); fake.checks.set(B, runs({ test: 'failure', typecheck: 'success' }));
    return { itemB, fake };
  };
  const options = () => ({ required, ciAppIds: [ci], now: new Date(at), approved: new Set<string>() });

  // 1. The approver App is refused once: the merge is still tried, the last-push rule refuses it, and
  //    the revert stays open. The next tick approves afresh and the merge lands: no abandonment.
  {
    const { itemB, fake } = setup(), opts = options();
    await runMainGuard(fake.ports, opts);
    const revert = itemB.mainGuardReverts![0].revert!;
    fake.checks.set(revert.head, green);
    const approve = fake.ports.approveRevert, merges: number[] = [];
    let refusals = 1;
    fake.ports.approveRevert = async (pr, head, body) => { if (refusals-- > 0) { fake.calls.approved.push(pr); throw new Error('GitHub refused the revert approver\'s POST /pulls/900/reviews (422)'); } return approve(pr, head, body); };
    const merge = fake.ports.mergeRevert;
    fake.ports.mergeRevert = async (work, entry) => { merges.push(entry.pr); return merge(work, entry); };
    await runMainGuard(fake.ports, opts);
    assert.equal(itemB.mainGuardReverts![0].state, 'opened', 'one refusal does not abandon the revert');
    assert.equal(itemB.mainGuardReverts![0].refusals?.length, 1);
    assert.match(itemB.mainGuardReverts![0].refusals![0], /revert approver could not approve.*New changes require approval/);
    assert.deepEqual(merges, [revert.pr], 'the refused approval still tries the merge');
    assert.deepEqual(fake.calls.closed, []);
    await runMainGuard(fake.ports, opts);
    assert.deepEqual(fake.calls.approved, [revert.pr, revert.pr], 'the retry approves afresh');
    assert.deepEqual(merges, [revert.pr, revert.pr], 'and merges through the App\'s merge path again');
    assert.equal(itemB.mainGuardReverts![0].state, 'merged');
    assert.equal(itemB.stage, 'ready');
  }

  // 2. The approver App is refused every time, but the App's ruleset bypass lets the merge land:
  //    the revert merges on the first attempt, with no abandonment.
  {
    const { itemB, fake } = setup();
    await runMainGuard(fake.ports, options());
    fake.checks.set(itemB.mainGuardReverts![0].revert!.head, green);
    fake.ports.approveRevert = async () => { throw new Error('Resource not accessible by integration'); };
    fake.ports.mergeRevert = async (_work, entry) => { fake.calls.merged.push(entry.pr); fake.pulls.set(entry.pr, { ...fake.pulls.get(entry.pr)!, merged: true, open: false, mergeSha: sha('d900') }); return sha('d900'); };
    await runMainGuard(fake.ports, options());
    assert.equal(itemB.mainGuardReverts![0].state, 'merged');
  }

  // 3. The merge is refused on every attempt: each tick retries with a fresh approval, and only after
  //    the last attempt is the revert closed and abandoned as an approval-rule refusal.
  {
    const { itemB, fake } = setup(), opts = options();
    await runMainGuard(fake.ports, opts);
    const revert = itemB.mainGuardReverts![0].revert!;
    fake.checks.set(revert.head, green);
    fake.ports.mergeRevert = async () => { throw new Error('Repository rule violations found\n\nAt least 1 approving review is required by reviewers with write access.'); };
    for (let attempt = 1; attempt < revertLandingAttempts; attempt++) {
      await runMainGuard(fake.ports, opts);
      assert.equal(itemB.mainGuardReverts![0].state, 'opened', `attempt ${attempt} is retried`);
      assert.equal(itemB.mainGuardReverts![0].refusals?.length, attempt);
    }
    await runMainGuard(fake.ports, opts);
    assert.deepEqual(fake.calls.approved, Array(revertLandingAttempts).fill(revert.pr), 'every attempt approved afresh');
    const settled = itemB.mainGuardReverts![0];
    assert.equal(settled.state, 'abandoned');
    assert.equal(settled.cause, 'approval-refused');
    assert.equal(settled.red, true);
    assert.equal(settled.refusals?.length, revertLandingAttempts);
    assert.match(settled.reason!, new RegExp(`GitHub's approval rule refused revert PR #${revert.pr} on all ${revertLandingAttempts} approve-then-merge attempts`));
    assert.deepEqual(fake.calls.closed.map(close => close.pr), [revert.pr]);
  }

  // 4. A revert's own failing checks are not a mechanical refusal: they still abandon on the first look.
  {
    const { itemB, fake } = setup();
    await runMainGuard(fake.ports, options());
    fake.checks.set(itemB.mainGuardReverts![0].revert!.head, runs({ test: 'failure', typecheck: 'success' }));
    await runMainGuard(fake.ports, options());
    assert.equal(itemB.mainGuardReverts![0].state, 'abandoned');
    assert.equal(itemB.mainGuardReverts![0].cause, 'checks-failed');
    assert.equal(itemB.mainGuardReverts![0].refusals, undefined);
  }
});

/** Runs the loop's merge step over `work` for one cycle, with main's check `state` read through `baseCheck`; returns the main guard lines raised. */
async function mergeCycle(state: ReturnType<typeof emptyDaemonState>, work: Work[], clock: number, baseCheck?: (check: string) => Promise<{ state: string }>) {
  const performed: { kind: string; work: string | null; detail: string }[] = [];
  await mergeStep({ config: { autoMerge: true }, state, now: () => clock, clock, snapshot: { jobs: [], work }, performed, open: [],
    effects: { persist: async () => undefined, snapshot: async () => ({ work }), baseCheck },
    isolate: async (_kind: unknown, _item: unknown, _name: unknown, body: () => Promise<unknown>) => body() } as unknown as Cycle);
  return performed.filter(action => action.kind === 'escalation' && action.detail.startsWith('Main guard:'));
}

test('unit:main-guard-attention-until-green an abandoned revert raises its line every cycle while main\'s failing check is red, and stops once it passes', async () => {
  const state = emptyDaemonState({ url: 'https://graphyard.example', repository: 'owner/project', autoMerge: true } as MasterConfig);
  const B = sha('b2'), itemB = delivered('GY-2', B, 702), start = Date.parse(at);
  itemB.mainGuardReverts = [{ mergeSha: B, pr: 702, failing: ['test'], revert: { pr: 900, head: sha('e900') }, state: 'abandoned', at, settledAt: at, revertSha: null,
    reason: 'GitHub\'s approval rule refused revert PR #900 on all 3 approve-then-merge attempts', cause: 'approval-refused', refusals: ['a', 'b', 'c'], red: true }];
  let main = 'failed';
  const reads: string[] = [];
  const baseCheck = async (check: string) => { reads.push(check); if (main === 'unreadable') throw new Error('gh: 502'); return { state: main }; };
  const raised: string[] = [];
  for (let cycle = 0; cycle < 6; cycle++) {
    // A pending run on main, or one that cannot be read, is not a pass: main is still red.
    if (cycle === 3) main = 'pending';
    if (cycle === 4) main = 'unreadable';
    raised.push(...(await mergeCycle(state, [itemB], start + cycle * 30_000, baseCheck)).map(line => line.detail));
  }
  assert.equal(raised.length, 6, 'raised on every cycle while red, not once');
  for (const detail of raised) assert.match(detail, /Main is still red: main's required check test stays red until the next merge to main re-runs CI/);
  assert.equal(state.actions[`escalation:main-guard:${B}`].attempts, 6);

  // A busy loop: while main stays red the cursor fills past `retainedActions` with rows newer than
  // the abandonment, so its oldest retained row postdates it. The line is still raised every cycle.
  main = 'failed';
  for (let cycle = 6; cycle < 10; cycle++) {
    const clock = start + cycle * 30_000;
    for (let row = 0; row < 200; row++) state.actions[`dispatch:filler:${cycle}:${row}`] = { kind: 'dispatch', work: null, principal: null, state: 'done', detail: 'filler', attempts: 1, epoch: null, cycle, at: new Date(clock - 1).toISOString() } as never;
    pruneDaemonState(state);
    const lines = await mergeCycle(state, [itemB], clock, baseCheck);
    assert.equal(lines.length, 1, `cycle ${cycle}: raised while main is red, however full the cursor`);
    assert.match(lines[0].detail, /Main is still red/);
  }
  assert.ok(Object.values(state.actions).filter(action => action.state === 'done').length >= retainedActions, 'the cursor holds as many resolved rows as it keeps');
  assert.ok(Math.min(...Object.values(state.actions).map(action => Date.parse(action.at))) > start, 'every retained row is newer than the abandonment');

  // An unrelated merge re-runs CI and main's test passes: the line is raised once more as recovered, then never again.
  main = 'passed';
  const recovered = await mergeCycle(state, [itemB], start + 10 * 30_000, baseCheck);
  assert.equal(recovered.length, 1);
  assert.match(recovered[0].detail, /Main's test passed again; nothing is owed/);
  for (let cycle = 11; cycle < 14; cycle++) assert.deepEqual(await mergeCycle(state, [itemB], start + cycle * 30_000, baseCheck), []);
  assert.equal(reads.length, 11, 'main is no longer read once the line has recovered');
  // Once the recovered row itself is retired, the abandonment predates every retained row: it is not raised again.
  for (let row = 0; row < retainedActions; row++) state.actions[`dispatch:late:${row}`] = { kind: 'dispatch', work: null, principal: null, state: 'done', detail: 'filler', attempts: 1, epoch: null, cycle: 14, at: new Date(start + 14 * 30_000).toISOString() } as never;
  pruneDaemonState(state);
  assert.equal(state.actions[`escalation:main-guard:${B}`], undefined);
  assert.deepEqual(await mergeCycle(state, [itemB], start + 15 * 30_000, baseCheck), []);

  // A record from before GY-1332 (no `red`), or a loop with no reader of main's checks, raises the line once.
  const legacy = emptyDaemonState({ url: 'https://graphyard.example', repository: 'owner/project', autoMerge: true } as MasterConfig);
  const old = { ...itemB, mainGuardReverts: [{ ...itemB.mainGuardReverts[0], red: undefined }] } as Work;
  assert.equal((await mergeCycle(legacy, [old], start, baseCheck)).length, 1);
  assert.equal((await mergeCycle(legacy, [old], start + 30_000, baseCheck)).length, 0);
  const unread = emptyDaemonState({ url: 'https://graphyard.example', repository: 'owner/project', autoMerge: true } as MasterConfig);
  assert.equal((await mergeCycle(unread, [itemB], start)).length, 1);
  assert.equal((await mergeCycle(unread, [itemB], start + 30_000)).length, 0);
});

test('manual:main-guard-abandon-reason the abandonment record and attention line name an approval-rule refusal apart from check-failure, conflict and timeout', () => {
  const B = sha('b2');
  const revert = (cause: MainGuardRevert['cause'], reason: string): MainGuardRevert => ({ mergeSha: B, pr: 702, failing: ['test'], revert: { pr: 900, head: sha('e900') }, state: 'abandoned', at, settledAt: at, revertSha: null, reason, cause, red: true });
  const lines = (['approval-refused', 'checks-failed', 'conflict', 'timeout'] as const).map(cause => mainGuardAttention([{ key: 'GY-2', mainGuardReverts: [revert(cause, `${cause} reason`)] }])[0].text);
  assert.match(lines[0], /\[approval-rule refusal\]/);
  assert.match(lines[1], /\[its checks failed\]/);
  assert.match(lines[2], /\[conflict\]/);
  assert.match(lines[3], /\[its checks timed out\]/);
  assert.equal(new Set(lines).size, 4, 'each cause reads differently');
  for (const line of lines) assert.match(line, /main's required check test stays red until the next merge to main re-runs CI/);
});

// GY-1468: a run on main cancelled in an infrastructure step is not a failing test.
const shardRuns = (shards: string[], aggregate: string, from = 0): CheckRun[] => [
  ...shards.map((result, index) => ({ name: `test shard ${index + 1}`, result, appId: ci, id: from + index })),
  { name: 'test', result: aggregate, appId: ci, id: from + 10 }, { name: 'typecheck', result: 'success', appId: ci, id: from + 11 },
];
/** Main's run of 2026-10-07: shards 1 and 2 cancelled at the job timeout inside the apt step, the rest green, the aggregate `test` failed. */
const cancelledRun = (from = 0) => shardRuns(['cancelled', 'cancelled', 'success', 'success', 'success', 'success'], 'failure', from);
/** The fake's Actions runs: each cancelled job names run 4242 at its attempt; a rerun bumps the attempt and leaves the rerun's jobs queued. */
function withReruns(fake: ReturnType<typeof world>, commit: string, attempt = 1) {
  const reruns: number[] = [];
  fake.ports.jobRun = async () => ({ id: 4242, attempt });
  fake.ports.rerunFailed = async (checkRun, run) => {
    reruns.push(checkRun); assert.equal(run.id, 4242);
    attempt += 1;
    fake.checks.set(commit, [...fake.checks.get(commit)!, ...shardRuns(['queued', 'queued'], 'queued', 100 * attempt).filter(check => check.result === 'queued')]);
    return 'requested';
  };
  return { reruns, attempt: () => attempt };
}

test('unit:main-guard-cancelled-run-not-culprit a main run whose only failures are cancelled jobs, and the aggregate test failing on them, opens no revert: main is pending, the failed jobs are rerun once per attempt, and only a concluded rerun is judged', async () => {
  // The verdict: cancelled shards under a failed aggregate are `cancelled`; a real shard failure is `fail`; a job still running is `pending`.
  assert.deepEqual(commitVerdict(cancelledRun(), required, [ci]), { verdict: 'cancelled', failing: ['test'], checkRun: 0 });
  assert.deepEqual(commitVerdict(shardRuns(['timed_out', 'success'], 'failure'), required, [ci]), { verdict: 'cancelled', failing: ['test'], checkRun: 0 });
  assert.deepEqual(commitVerdict(shardRuns(['cancelled', 'failure'], 'failure'), required, [ci]), { verdict: 'fail', failing: ['test'] });
  assert.deepEqual(commitVerdict(shardRuns(['cancelled', 'in_progress'], 'failure'), required, [ci]), { verdict: 'pending' });
  assert.deepEqual(commitVerdict(runs({ test: 'cancelled', typecheck: 'success' }), required, [ci]), { verdict: 'cancelled', failing: ['test'], checkRun: 0 });

  const [base, A] = ['b0', 'a1'].map(sha);
  const history: MainCommit[] = [{ sha: A, parent: base }, { sha: base, parent: null }];
  const itemA = delivered('GY-1465', A, 942);
  const fake = world(history, [itemA]);
  fake.checks.set(base, green); fake.checks.set(A, cancelledRun());
  const actions = withReruns(fake, A);
  const options = { required, ciAppIds: [ci], now: new Date(at), verdicts: new Map(), cancelled: new Set<string>() };

  // Tick 1: no culprit; the run's failed jobs are rerun from a cancelled job.
  let tick = await runMainGuard(fake.ports, options);
  assert.deepEqual(tick.main, { state: 'pending', probe: A, cancelled: { failing: ['test'], checkRun: 0 } });
  assert.deepEqual(fake.calls.opened, [], 'a cancelled run never opens a revert');
  assert.deepEqual(actions.reruns, [0]);
  assert.equal(itemA.mainGuardReverts, undefined); assert.equal(itemA.stage, 'done');
  assert.deepEqual(tick.errors, []);

  // Tick 2: the rerun's jobs are queued, so main is pending and nothing is rerun again.
  tick = await runMainGuard(fake.ports, options);
  assert.deepEqual(tick.main, { state: 'pending', probe: A });
  assert.deepEqual(actions.reruns, [0]);

  // The rerun passes: main is green and nothing was reverted.
  fake.checks.set(A, [...cancelledRun(), ...shardRuns(['success', 'success'], 'success', 200).filter(check => check.name !== 'typecheck' && !/shard [3-6]/.test(check.name))]);
  tick = await runMainGuard(fake.ports, options);
  assert.deepEqual(tick.main, { state: 'green' });
  assert.deepEqual(fake.calls.opened, []);
  assert.equal(itemA.stage, 'done'); assert.equal(itemA.mainGuardReverts, undefined);

  // A rerun that concludes with a real failure is what names the culprit, and only then.
  const [B] = ['b2'].map(sha);
  history.unshift({ sha: B, parent: A });
  const itemB = delivered('GY-1466', B, 943); fake.items.push(itemB);
  fake.checks.set(B, cancelledRun());
  withReruns(fake, B);
  tick = await runMainGuard(fake.ports, options);
  assert.equal(tick.main.state, 'pending'); assert.deepEqual(fake.calls.opened, []);
  fake.checks.set(B, [...cancelledRun(), ...shardRuns(['failure', 'success'], 'failure', 300).filter(check => check.name !== 'typecheck')]);
  tick = await runMainGuard(fake.ports, options);
  assert.deepEqual(tick.main, { state: 'broken', culprit: B, parent: A, failing: ['test'] });
  assert.deepEqual(fake.calls.opened, [B]);
});

test('unit:main-guard-real-failure-reverted a main run with a genuine test failure on the merge while its parent passed is reverted exactly as before once its one rerun fails again', async () => {
  const [base, A] = ['b0', 'a1'].map(sha);
  const history: MainCommit[] = [{ sha: A, parent: base }, { sha: base, parent: null }];
  const itemA = delivered('GY-2', A, 702);
  const fake = world(history, [itemA]);
  fake.checks.set(base, green); fake.checks.set(A, shardRuns(['failure', 'success', 'success'], 'failure'));
  const actions = withReruns(fake, A);
  const options = { required, ciAppIds: [ci], now: new Date(at), verdicts: new Map(), reruns: new Map() };
  let tick = await runMainGuard(fake.ports, options);
  assert.deepEqual(tick.main, { state: 'pending', probe: A, rerun: { failing: ['test'] } });
  assert.deepEqual(actions.reruns, [10], 'the failed run is rerun once, from the failing check');
  // The rerun's shard fails again: reverted exactly as before.
  fake.checks.set(A, [...fake.checks.get(A)!, ...shardRuns(['failure'], 'failure', 500).filter(check => check.name !== 'typecheck')]);
  tick = await runMainGuard(fake.ports, options);
  assert.deepEqual(tick.main, { state: 'broken', culprit: A, parent: base, failing: ['test'] });
  assert.deepEqual(fake.calls.opened, [A]);
  assert.deepEqual(actions.reruns, [10], 'never rerun twice');
  const revert = itemA.mainGuardReverts![0].revert!;
  fake.checks.set(revert.head, green);
  tick = await runMainGuard(fake.ports, options);
  assert.deepEqual(fake.calls.merged, [revert.pr]);
  assert.equal(itemA.stage, 'ready');
  assert.match(itemA.mainGuardReverts![0].reason!, /broke main: test failed on that merge commit while its parent passed/);
  // A cancelled revert's own checks are still not merged: it is given up as before.
  assert.equal(commitVerdict(runs({ test: 'cancelled', typecheck: 'success' }), required, [ci]).verdict, 'cancelled');
});

// GY-1497: a failed required check on main is rerun once before its merge is reverted.
/** The fake's Actions run 5151 behind main's failed `test`: a rerun bumps the attempt and leaves the rerun's `test` queued until `conclude`. */
function withFailedReruns(fake: ReturnType<typeof world>, commit: string, answer: () => 'requested' | 'waiting' = () => 'requested') {
  let attempt = 1;
  const reruns: number[] = [];
  fake.ports.jobRun = async () => ({ id: 5151, attempt });
  fake.ports.rerunFailed = async (checkRun, run) => {
    assert.equal(run.id, 5151);
    if (answer() === 'waiting') return 'waiting';
    reruns.push(checkRun); attempt += 1;
    fake.checks.set(commit, [...fake.checks.get(commit)!, { name: 'test', result: 'queued', appId: ci, id: 100 * attempt }]);
    return 'requested';
  };
  const conclude = (result: string) => fake.checks.set(commit, fake.checks.get(commit)!.map(check => check.id === 100 * attempt ? { ...check, result } : check));
  return { reruns, conclude };
}

test('unit:main-guard-reruns-before-revert a merge that fails a required check its parent passed is rerun once first: main is pending, nothing is reverted and no later merge is judged until the rerun concludes', async () => {
  assert.equal((mainGuard as { mainFailedRerunLimit?: number }).mainFailedRerunLimit, 1);
  const [base, A, B] = ['b0', 'a1', 'b2'].map(sha);
  const history: MainCommit[] = [{ sha: B, parent: A }, { sha: A, parent: base }, { sha: base, parent: null }];
  const itemA = delivered('GY-1', A, 701), itemB = delivered('GY-2', B, 702);
  const fake = world(history, [itemA, itemB]);
  fake.checks.set(base, green); fake.checks.set(A, runs({ test: 'failure', typecheck: 'success' })); fake.checks.set(B, runs({ test: 'failure', typecheck: 'success' }));
  // GitHub first answers that the run is still finishing its other jobs: the rerun is asked again next tick.
  let waits = 1;
  const actions = withFailedReruns(fake, A, () => waits-- > 0 ? 'waiting' : 'requested');
  const options = { required, ciAppIds: [ci], now: new Date(at), verdicts: new Map(), reruns: new Map() };
  for (let index = 0; index < 4; index++) {
    const tick = await runMainGuard(fake.ports, options);
    assert.deepEqual(tick.main, { state: 'pending', probe: A, rerun: { failing: ['test'] } }, `tick ${index}: main is pending on the rerun`);
    assert.deepEqual(tick.errors, []);
  }
  assert.deepEqual(actions.reruns, [0], 'rerun once, after the wait, from the failed check run');
  assert.deepEqual(fake.calls.opened, [], 'no revert while the rerun runs');
  assert.equal(itemA.mainGuardReverts, undefined); assert.equal(itemB.mainGuardReverts, undefined, 'the later merge is not judged');
  // The rerun fails again: A, not B, is reverted, and nothing is rerun twice.
  actions.conclude('failure');
  let tick = await runMainGuard(fake.ports, options);
  assert.deepEqual(tick.main, { state: 'broken', culprit: A, parent: base, failing: ['test'] });
  assert.deepEqual(fake.calls.opened, [A]);
  await runMainGuard(fake.ports, options);
  assert.deepEqual(actions.reruns, [0]); assert.deepEqual(fake.calls.opened, [A]);

  // A rerun GitHub refuses counts as the failure: reverted on the same tick.
  const C = sha('c3'), itemC = delivered('GY-3', C, 703), refused = world([{ sha: C, parent: base }, { sha: base, parent: null }], [itemC]);
  refused.checks.set(base, green); refused.checks.set(C, runs({ test: 'failure', typecheck: 'success' }));
  refused.ports.jobRun = async () => ({ id: 5151, attempt: 1 });
  refused.ports.rerunFailed = async () => { throw new Error('Resource not accessible by integration (403)'); };
  tick = await runMainGuard(refused.ports, { required, ciAppIds: [ci], now: new Date(at) });
  assert.equal(tick.main.state, 'broken'); assert.deepEqual(refused.calls.opened, [C]);

  // A rerun that does not conclude within revertChecksTimeoutMs counts as the failure.
  const D = sha('d4'), itemD = delivered('GY-4', D, 704), slow = world([{ sha: D, parent: base }, { sha: base, parent: null }], [itemD]);
  slow.checks.set(base, green); slow.checks.set(D, runs({ test: 'failure', typecheck: 'success' }));
  const hung = withFailedReruns(slow, D), slowOptions = { required, ciAppIds: [ci], verdicts: new Map(), reruns: new Map() };
  tick = await runMainGuard(slow.ports, { ...slowOptions, now: new Date(at) });
  assert.equal(tick.main.state, 'pending');
  tick = await runMainGuard(slow.ports, { ...slowOptions, now: new Date(Date.parse(at) + 59 * 60_000) });
  assert.equal(tick.main.state, 'pending'); assert.deepEqual(slow.calls.opened, []);
  tick = await runMainGuard(slow.ports, { ...slowOptions, now: new Date(Date.parse(at) + 61 * 60_000) });
  assert.equal(tick.main.state, 'broken'); assert.deepEqual(slow.calls.opened, [D]); assert.deepEqual(hung.reruns, [0]);

  // A job already rerun (a restarted guard forgot it) is not rerun again: reverted.
  const E = sha('e5'), itemE = delivered('GY-5', E, 705), again = world([{ sha: E, parent: base }, { sha: base, parent: null }], [itemE]);
  again.checks.set(base, green); again.checks.set(E, runs({ test: 'failure', typecheck: 'success' }));
  let asked = 0;
  again.ports.jobRun = async () => ({ id: 5151, attempt: 2 });
  again.ports.rerunFailed = async () => { asked++; return 'requested'; };
  await runMainGuard(again.ports, { required, ciAppIds: [ci], now: new Date(at) });
  assert.equal(asked, 0); assert.deepEqual(again.calls.opened, [E]);
});

test('unit:main-guard-flake-recorded a rerun that passes leaves main green with no revert and records the flake on the merged item, bounded', async () => {
  const [base, A] = ['b0', 'a1'].map(sha);
  const itemA = delivered('GY-1', A, 701);
  const fake = world([{ sha: A, parent: base }, { sha: base, parent: null }], [itemA]);
  fake.checks.set(base, green); fake.checks.set(A, runs({ test: 'failure', typecheck: 'success' }));
  const actions = withFailedReruns(fake, A);
  const options = { required, ciAppIds: [ci], now: new Date(at), verdicts: new Map(), reruns: new Map() };
  let tick = await runMainGuard(fake.ports, options);
  assert.equal(tick.main.state, 'pending');
  actions.conclude('success');
  tick = await runMainGuard(fake.ports, options);
  assert.deepEqual(tick.main, { state: 'green' });
  assert.deepEqual(fake.calls.opened, []);
  assert.equal(itemA.stage, 'done'); assert.equal(itemA.delivery?.mergeSha, A); assert.equal(itemA.mainGuardReverts, undefined);
  const flake = { mergeSha: A, check: 'test', failedRunId: 0, rerunRunId: 200, at };
  assert.deepEqual(itemA.mainGuardFlakes, [flake]);
  assert.deepEqual(tick.flakes, [flake]);
  // Later ticks record nothing more and rerun nothing.
  tick = await runMainGuard(fake.ports, options);
  assert.deepEqual(itemA.mainGuardFlakes, [flake]); assert.deepEqual(actions.reruns, [0]); assert.deepEqual(tick.flakes, []);
  // The record keeps the last 20.
  const many = Array.from({ length: 25 }, (_, index) => ({ ...flake, failedRunId: index }));
  mainGuard.applyMainGuardFlakes(itemA, many);
  assert.equal(itemA.mainGuardFlakes!.length, 20);
  assert.equal(itemA.mainGuardFlakes!.at(-1)!.failedRunId, 24);
});

test('unit:main-guard-cancel-bound-escalates a run still cancelled past the rerun bound is reported once to the master as an infrastructure fault naming the run, never reverted', async () => {
  const limit = (mainGuard as { mainCancelledRerunLimit?: number }).mainCancelledRerunLimit ?? 3;
  const [base, A] = ['b0', 'a1'].map(sha);
  const history: MainCommit[] = [{ sha: A, parent: base }, { sha: base, parent: null }];
  const itemA = delivered('GY-1465', A, 942);
  const fake = world(history, [itemA]);
  fake.checks.set(base, green);
  const options = { required, ciAppIds: [ci], now: new Date(at), cancelled: new Set<string>() };
  // Every attempt is cancelled again: the guard reruns up to the bound, then reports.
  let attempt = 1, reads = 0, recordFails = 1; const reruns: number[] = [];
  fake.ports.jobRun = async () => { reads++; return { id: 4242, attempt, step: 'Install bubblewrap (the confinement suite runs real namespaces)' }; };
  fake.ports.rerunFailed = async checkRun => { reruns.push(checkRun); attempt += 1; return 'requested'; };
  // The first durable record fails: the fault is not marked seen, so the next tick records it.
  const record = fake.ports.record;
  fake.ports.record = async (work, revert) => { if (revert.cause === 'cancelled' && recordFails-- > 0) throw new Error('database unavailable'); return record(work, revert); };
  const errors: string[] = [];
  for (let tick = 0; tick < limit + 6; tick++) {
    fake.checks.set(A, cancelledRun(1000 * attempt));
    const result = await runMainGuard(fake.ports, options);
    assert.equal(result.main.state, 'pending', 'a cancelled main is never broken');
    errors.push(...result.errors);
  }
  assert.equal(reruns.length, limit, 'reruns stop at the bound');
  assert.equal(errors.length, 1); assert.match(errors[0], /database unavailable/);
  assert.equal(reads, limit + 2, 'one job read per rerun, one for the failed record and one for the recorded fault; none once it is reported');
  assert.deepEqual(fake.calls.opened, [], 'nothing is reverted');
  assert.equal(itemA.stage, 'done'); assert.equal(itemA.delivery?.mergeSha, A);
  assert.equal(itemA.mainGuardReverts?.length, 1, 'reported once');
  const fault = itemA.mainGuardReverts![0];
  assert.equal(fault.cause, 'cancelled'); assert.equal(fault.revert, null); assert.deepEqual(fault.run, { id: 4242, attempt: limit + 1 });
  assert.match(fault.reason!, /infrastructure fault: CI run 4242 on main's merge .*stopped in step "Install bubblewrap/);
  const lines = mainGuardAttention(fake.items);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].red, [], 'raised once, not every cycle');
  assert.match(lines[0].text, /infrastructure fault: CI run 4242.*not reverted.*rerun run 4242/);
  assert.doesNotMatch(lines[0].text, /broke main/);

  // A master rerun that then fails for real is still reverted.
  fake.checks.set(A, [...cancelledRun(), ...shardRuns(['failure', 'success'], 'failure', 9000).filter(check => check.name !== 'typecheck')]);
  const result = await runMainGuard(fake.ports, options);
  assert.equal(result.main.state, 'broken');
  assert.deepEqual(fake.calls.opened, [A]);
});

test('unit:ci-bubblewrap-install-bounded the CI bubblewrap install retries apt and is bounded well inside the shard timeout', async () => {
  const { readFile } = await import('node:fs/promises');
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const shard = workflow.slice(workflow.indexOf('  test-shard:'), workflow.indexOf('  test-browser:'));
  const shardTimeout = Number(/\n    timeout-minutes: (\d+)/.exec(shard)?.[1]);
  const step = shard.slice(shard.indexOf('- name: Install bubblewrap'), shard.indexOf('- name: Select the test files'));
  const stepTimeout = Number(/timeout-minutes: (\d+)/.exec(step)?.[1]);
  assert.ok(stepTimeout > 0 && stepTimeout * 2 <= shardTimeout, `the install step is bounded at ${stepTimeout} min, at most half the shard's ${shardTimeout}`);
  assert.match(step, /for attempt in 1 2 3/, 'apt is retried');
  assert.match(step, /Acquire::Retries=/);
  for (const call of step.match(/apt-get (update|install)/g) ?? []) assert.ok(new RegExp(`timeout \\d+ ${call}`).test(step), `${call} is bounded by timeout`);
  assert.equal(step.match(/apt-get (update|install)/g)?.length, 2);
});
