import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, withdrawEnqueuedPullRequests } from '../src/github.js';
import { ghMergeQueueTransport, withdrawEntries } from '../src/cli/master/fleet.js';

// GY-1871: `master withdraw` is the operator's take-back of Graphyard's merge intent on a managed
// repository: every pull request a work item enqueued (merge queue) or armed (auto-merge) is taken
// back through the same dequeuePullRequest logic the gates run, each reported with its number, head
// sha, prior mode and result; a pull request already out of GitHub's hands is `none` and untouched,
// so a second run writes nothing; and no identity but the operator's admin may withdraw.

const idOf = (pr: number) => `PR_kwDOwithdraw${pr}`;
const heads: Record<number, string> = { 11: 'a'.repeat(40), 22: 'b'.repeat(40), 33: 'c'.repeat(40) };
const entries = [{ key: 'GY-11', pr: 11 }, { key: 'GY-22', pr: 22 }, { key: 'GY-33', pr: 33 }];

/**
 * A recording GitHub transport: the App client over a fake GraphQL backend that holds each pull
 * request's merge-queue state and applies the take-back mutations it is asked to run, so a re-read
 * after a write reports what GitHub would.
 */
function fakeGitHub(prs: Record<number, 'queued' | 'auto-merge' | 'none'>) {
  const state = new Map(Object.entries(prs).map(([pr, mode]) => [Number(pr), { mode, head: heads[Number(pr)] }]));
  const byId = new Map([...state.keys()].map(pr => [idOf(pr), pr]));
  const operations: { operation: string; variables: Record<string, unknown> }[] = [];
  const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used' });
  github.graphql = async (query: string, variables: Record<string, unknown>) => {
    const operation = /(dequeuePullRequest|disablePullRequestAutoMerge|mergeQueue\(branch)/.exec(query)?.[1] ?? 'unknown';
    operations.push({ operation, variables });
    if (operation === 'dequeuePullRequest' || operation === 'disablePullRequestAutoMerge') {
      const pr = byId.get(String(variables.id));
      assert.ok(pr, `the mutation names a pull request the transport holds: ${String(variables.id)}`);
      state.set(pr, { mode: 'none', head: state.get(pr)!.head });
      return {};
    }
    const pr = Number(variables.number), entry = state.get(pr)!;
    return { repository: { mergeQueue: { id: 'MQ_1' }, pullRequest: { id: idOf(pr), headRefOid: entry.head, isInMergeQueue: entry.mode === 'queued',
      autoMergeRequest: entry.mode === 'auto-merge' ? { enabledAt: 'armed' } : null,
      mergeQueueEntry: entry.mode === 'queued' ? { state: 'AWAITING_CHECKS', position: 1, headCommit: { oid: entry.head } } : null } } };
  };
  const named = (name: string) => operations.filter(entry => entry.operation === name);
  return { github, state, named, writes: () => operations.filter(entry => entry.operation !== 'mergeQueue(branch') };
}

test('unit:withdraw-dequeues-every-enqueued-pr — master withdraw --apply dequeues every queued pull request and disarms every auto-merge-armed one, reporting number, head, prior mode and result; the plan writes nothing; a non-operator identity is refused', async () => {
  const held = fakeGitHub({ 11: 'queued', 22: 'auto-merge', 33: 'none' });
  const admin = { id: 'vishrog', role: 'admin' };

  // The plan: every pull request read, nothing written, the same rows an apply carries out.
  const plan = await withdrawEnqueuedPullRequests(held.github, entries, admin, false);
  assert.deepEqual(held.writes(), [], 'a plan issues no GitHub write');
  assert.equal(plan.failed, 0, 'a plan fails nothing');
  assert.deepEqual(plan.rows.map(row => [row.pr, row.head, row.mode, row.action]), [[11, heads[11], 'queued', 'dequeue'], [22, heads[22], 'auto-merge', 'disable-auto-merge'], [33, heads[33], 'none', 'none']]);

  // The apply: the queued entry dequeued, the armed one disarmed, the untouched one left alone.
  const applied = await withdrawEnqueuedPullRequests(held.github, entries, admin, true);
  assert.deepEqual(held.named('dequeuePullRequest').map(entry => entry.variables), [{ id: idOf(11) }], 'the queued pull request is dequeued');
  assert.deepEqual(held.named('disablePullRequestAutoMerge').map(entry => entry.variables), [{ id: idOf(22) }], 'the armed pull request has auto-merge disabled');
  assert.equal(applied.applied, true);
  assert.equal(applied.failed, 0, 'a complete take-back fails nothing');
  assert.deepEqual(applied.rows.map(row => [row.pr, row.head, row.mode, row.action, row.result]), [
    [11, heads[11], 'queued', 'dequeue', 'dequeued'],
    [22, heads[22], 'auto-merge', 'disable-auto-merge', 'auto-merge disabled'],
    [33, heads[33], 'none', 'none', 'none'],
  ], 'each row reports the pull request number, head sha, prior mode and result');

  // No identity but the operator's admin withdraws: the master's coordinator and a worker are refused.
  for (const actor of [{ id: 'graphyard-master', role: 'coordinator' }, { id: 'graphyard-codex-1', role: 'worker' }, { id: 'graphyard-producer-1', role: 'producer' }, { id: 'unknown', role: undefined }]) {
    await assert.rejects(withdrawEnqueuedPullRequests(held.github, entries, actor, true), /operator-only/);
  }
  assert.equal(held.writes().length, 2, 'a refused identity issues no further write');
});

test('unit:withdraw-idempotent-and-reports-heads — a second master withdraw --apply issues no GitHub write and reports every pull request with mode none and its head', async () => {
  const held = fakeGitHub({ 11: 'queued', 22: 'auto-merge', 33: 'none' });
  const admin = { id: 'vishrog', role: 'admin' };
  const first = await withdrawEnqueuedPullRequests(held.github, entries, admin, true);
  assert.equal(first.rows.filter(row => row.action !== 'none').length, 2, 'the first apply takes the two held pull requests back');
  const writes = held.writes().length;

  const second = await withdrawEnqueuedPullRequests(held.github, entries, admin, true);
  assert.equal(held.writes().length, writes, 'the second apply issues no GitHub write');
  assert.equal(second.applied, true);
  assert.deepEqual(second.rows.map(row => [row.pr, row.head, row.mode, row.action, row.result]), [
    [11, heads[11], 'none', 'none', 'none'],
    [22, heads[22], 'none', 'none', 'none'],
    [33, heads[33], 'none', 'none', 'none'],
  ], 'every pull request is reported with mode none and its head');
});

test('unit:withdraw-incomplete-take-back-fails — a take-back GitHub refuses, cannot re-read, or leaves held is a failed row, so a script can tell an incomplete withdrawal from a done one', async () => {
  const admin = { id: 'vishrog', role: 'admin' };

  // A refused mutation: GitHub will not release the pull request.
  const refusing = fakeGitHub({ 11: 'queued', 22: 'none' });
  const original = refusing.github.graphql.bind(refusing.github);
  refusing.github.graphql = async (query: string, variables: Record<string, unknown>) => {
    if (/dequeuePullRequest/.test(query)) throw new Error('Pull request is in a merge group');
    return original(query, variables);
  };
  const refused = await withdrawEnqueuedPullRequests(refusing.github, [{ key: 'GY-11', pr: 11 }], admin, true);
  assert.equal(refused.failed, 1, 'the refused take-back is a failed row');
  assert.match(refused.rows[0].result, /^refused: Pull request is in a merge group$/);

  // A failed re-read: the mutation ran but GitHub's post-write state cannot be confirmed.
  const unconfirmable = fakeGitHub({ 11: 'queued', 22: 'none' });
  const base = unconfirmable.github.graphql.bind(unconfirmable.github);
  let reads = 0;
  unconfirmable.github.graphql = async (query: string, variables: Record<string, unknown>) => {
    if (/mergeQueue\(branch/.test(query) && ++reads > 1) throw new Error('rate limit exhausted');
    return base(query, variables);
  };
  const unconfirmed = await withdrawEnqueuedPullRequests(unconfirmable.github, [{ key: 'GY-11', pr: 11 }], admin, true);
  assert.equal(unconfirmed.failed, 1, 'the unconfirmed take-back is a failed row');
  assert.match(unconfirmed.rows[0].result, /refused: rate limit exhausted/);

  // A take-back GitHub does not apply: the re-read still reports the entry held.
  const sticky = fakeGitHub({ 11: 'queued', 22: 'none' });
  const inner = sticky.github.graphql.bind(sticky.github);
  sticky.github.graphql = async (query: string, variables: Record<string, unknown>) => {
    if (/dequeuePullRequest/.test(query)) return {}; // the mutation reports done but changes nothing
    return inner(query, variables);
  };
  const still = await withdrawEnqueuedPullRequests(sticky.github, [{ key: 'GY-11', pr: 11 }], admin, true);
  assert.equal(still.failed, 1, 'the held pull request is a failed row');
  assert.equal(still.rows[0].result, 'GitHub still reports queued');
});

test('unit:withdraw-gh-transport-reads-the-recorded-envelope — the real gh path unwraps GraphQL\u2019s data envelope, takes back through the operator credential, and refuses GitHub\u2019s errors', async () => {
  const entry = (mode: 'queued' | 'none') => ({ repository: { mergeQueue: { id: 'MQ_1' }, pullRequest: { id: idOf(11), headRefOid: heads[11], isInMergeQueue: mode === 'queued', autoMergeRequest: null,
    mergeQueueEntry: mode === 'queued' ? { state: 'AWAITING_CHECKS', position: 1, headCommit: { oid: heads[11] } } : null } } });
  // Exactly what `gh api graphql` prints: the `{ data }` envelope, one per call in order.
  const outputs = [JSON.stringify({ data: entry('queued') }), JSON.stringify({ data: {} }), JSON.stringify({ data: entry('none') })];
  const calls: string[][] = [];
  const run = (command: string, args: string[]) => { calls.push([command, ...args]); return outputs.shift()!; };
  const report = await withdrawEnqueuedPullRequests(ghMergeQueueTransport('owner/project', 'main', run), [{ key: 'GY-11', pr: 11 }], { id: 'vishrog', role: 'admin' }, true);
  assert.ok(calls.every(call => call[0] === 'gh' && call[1] === 'api' && call[2] === 'graphql'), 'every call rides the operator gh credential');
  assert.deepEqual(calls[0].slice(5), ['-f', 'owner=owner', '-f', 'name=project', '-F', 'number=11', '-f', 'branch=main'], 'the state read names the repository, pull request and base');
  assert.deepEqual(calls[1].slice(5), ['-f', `id=${idOf(11)}`], 'the take-back names the pull request GitHub reported');
  assert.deepEqual([report.rows[0].pr, report.rows[0].head, report.rows[0].mode, report.rows[0].result], [11, heads[11], 'queued', 'dequeued'], 'the recorded envelope is read as the pull request\u2019s state, not as an empty report');
  assert.equal(report.failed, 0);

  // An errors envelope refuses: it must not read as a pull request out of GitHub's hands.
  const refusing = ghMergeQueueTransport('owner/project', 'main', () => JSON.stringify({ errors: [{ message: 'Bad credentials' }] }));
  const failed = await withdrawEnqueuedPullRequests(refusing, [{ key: 'GY-11', pr: 11 }], { id: 'vishrog', role: 'admin' }, true);
  assert.equal(failed.failed, 1, 'the unreadable state is a failed row');
  assert.match(failed.rows[0].result, /GitHub refused the GraphQL read: Bad credentials/);
});

test('unit:withdraw-collects-work-prs — the pull requests withdrawn are every distinct pull request the control plane\u2019s open work items hold, deduplicated and ordered; a settled item\u2019s pull requests are never read', () => {
  const work = [
    { key: 'GY-22', stage: 'merge', candidate: { pr: 22 }, submission: { pr: 22 } },
    { key: 'GY-11', stage: 'review', candidate: { pr: 11 }, submission: null },
    { key: 'GY-33', stage: 'build', candidate: null, submission: { pr: 33 } },
    { key: 'GY-7', stage: 'ready', candidate: null, submission: null },
    { key: 'GY-9', stage: 'backlog', candidate: { pr: 0 }, submission: { pr: null } },
    { key: 'GY-5', stage: 'done', candidate: { pr: 44 }, submission: { pr: 55 } },
    { key: 'GY-3', stage: 'done', candidate: { pr: 66 }, submission: null },
  ];
  assert.deepEqual(withdrawEntries(work as never), [{ key: 'GY-11', pr: 11 }, { key: 'GY-22', pr: 22 }, { key: 'GY-33', pr: 33 }], 'the delivered and closed items\u2019 pull requests are collected for no read');
});
