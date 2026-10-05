import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import { generateKeyPairSync } from 'node:crypto';
import { applyMainGuardRevert, commitVerdict, mainGuardAttention, readMain, revertInverseRefusal, runMainGuard, type CheckRun, type FileChange, type MainCommit, type MainGuardPorts } from '../src/main-guard.js';
import { GitHub } from '../src/github.js';
import { mergeStep } from '../src/daemon/cycle-delivery.js';
import { emptyDaemonState, pruneDaemonState, retainedActions } from '../src/daemon/state.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { MasterConfig } from '../src/master.js';

// GY-1250: under GitHub delivery a merge that breaks main is reverted through a revert pull request
// the App merges, and its item is reopened; a revert that cannot merge is given up after one attempt.
// Each test is named for the proof it produces.
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

  // A refused merge is abandoned too, not retried.
  const C = sha('c3'), itemC = delivered('GY-3', C, 703), other = world([{ sha: C, parent: A }, { sha: A, parent: base }], [itemC]);
  other.checks.set(A, green); other.checks.set(C, runs({ test: 'failure', typecheck: 'success' }));
  other.ports.mergeRevert = async () => { throw new Error('Repository rule violations found'); };
  await runMainGuard(other.ports, { required, ciAppIds: [ci], now: new Date(at) });
  other.checks.set(itemC.mainGuardReverts![0].revert!.head, green);
  await runMainGuard(other.ports, { required, ciAppIds: [ci], now: new Date(at) });
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
