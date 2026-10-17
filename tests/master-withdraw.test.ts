import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, withdrawEnqueuedPullRequests } from '../src/github.js';
import { withdrawEntries } from '../src/cli/master/fleet.js';

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
  assert.deepEqual(plan.rows.map(row => [row.pr, row.head, row.mode, row.action]), [[11, heads[11], 'queued', 'dequeue'], [22, heads[22], 'auto-merge', 'disable-auto-merge'], [33, heads[33], 'none', 'none']]);

  // The apply: the queued entry dequeued, the armed one disarmed, the untouched one left alone.
  const applied = await withdrawEnqueuedPullRequests(held.github, entries, admin, true);
  assert.deepEqual(held.named('dequeuePullRequest').map(entry => entry.variables), [{ id: idOf(11) }], 'the queued pull request is dequeued');
  assert.deepEqual(held.named('disablePullRequestAutoMerge').map(entry => entry.variables), [{ id: idOf(22) }], 'the armed pull request has auto-merge disabled');
  assert.equal(applied.applied, true);
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

test('unit:withdraw-collects-work-prs — the pull requests withdrawn are every distinct pull request the control plane\u2019s work items hold, deduplicated and ordered', () => {
  const work = [
    { key: 'GY-22', candidate: { pr: 22 }, submission: { pr: 22 } },
    { key: 'GY-11', candidate: { pr: 11 }, submission: null },
    { key: 'GY-33', candidate: null, submission: { pr: 33 } },
    { key: 'GY-7', candidate: null, submission: null },
    { key: 'GY-9', candidate: { pr: 0 }, submission: { pr: null } },
  ];
  assert.deepEqual(withdrawEntries(work as never), [{ key: 'GY-11', pr: 11 }, { key: 'GY-22', pr: 22 }, { key: 'GY-33', pr: 33 }]);
});
