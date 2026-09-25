import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { GitHub, gateMerge } from '../src/github.js';
import { buildMasterStatus } from '../src/master.js';
import type { GitHubMergeQueueState, MergeEnqueueRequest } from '../src/merge-queue.js';
import type { Observation, Principal, Work } from '../src/model.js';

// All merges stalled after GY-258: on a base branch without a merge queue Graphyard enabled
// auto-merge, but it only asks once every gate — including the required `Graphyard / merge` check
// it just published — passes, so the pull request is CLEAN, and GitHub refuses auto-merge on a
// clean pull request ("Pull request is in clean status"). The refusal was a silent hold. A clean
// pull request is now merged at once, bound to the authorized head, and every refusal is recorded
// once and shown in master status.

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const pullRequestId = 'PR_kwDOgraphyard292';

function work(overrides: Partial<Work> = {}): Work {
  const candidate = { sha: head, baseSha: base, pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' };
  return { id: 'work-42', key: 'GY-42', title: 'Clean merge', description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'merge', revision: 9, policyRevision: 2, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 1,
    lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 42 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: { at: new Date().toISOString(), candidate, reviews: [], checks: [], protected: true, mergeable: true, merged: false, prState: 'open', draft: false, baseTip: base } as unknown as Observation,
    blocker: null, gates: [{ name: 'merge', passed: true, reasons: [] }], violations: [],
    mergeAuthorization: { sha: head, baseSha: base, policyRevision: 2, at: new Date().toISOString() }, ...overrides } as Work;
}
const requested = (item: Work): MergeEnqueueRequest => ({ sha: item.candidate!.sha, baseSha: item.candidate!.baseSha, policyRevision: item.policyRevision, requestedBy: 'master#daemon-1', at: new Date().toISOString() });

/** A base branch with no merge queue; the pull request's merge state and GitHub's answer to auto-merge are the fake's. */
function fakeGitHub(options: { mergeStateStatus: string | null; autoMergeError?: string; mergeError?: string }) {
  const operations: { operation: string; query: string; variables: Record<string, unknown> }[] = [];
  const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used' });
  github.request = async (path: string, method = 'GET') => {
    if (method !== 'GET') return { id: 77 };
    if (path === '/pulls/42') return { number: 42, state: 'open', draft: false, head: { sha: head }, base: { ref: 'main', sha: base } };
    if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: base } };
    if (/^\/commits\/[a-f0-9]{40}$/.test(path)) return { sha: path.slice(9), commit: { tree: { sha: 'e'.repeat(40) } } };
    if (path.includes('/check-runs')) return { check_runs: [] };
    throw new Error(`Unexpected GitHub request ${method} ${path}`);
  };
  github.graphql = async (query: string, variables: Record<string, unknown>) => {
    const operation = /(enqueuePullRequest|enablePullRequestAutoMerge|mergePullRequest|mergeQueue\(branch)/.exec(query)?.[1] ?? 'unknown';
    operations.push({ operation, query, variables });
    if (operation === 'mergeQueue(branch') {
      assert.match(query, /mergeStateStatus/, 'the merge-queue read asks GitHub for the pull request\'s merge state');
      return { repository: { mergeQueue: null, pullRequest: { id: pullRequestId, headRefOid: head, mergeStateStatus: options.mergeStateStatus, isInMergeQueue: false, autoMergeRequest: null, mergeQueueEntry: null } } };
    }
    if (operation === 'enablePullRequestAutoMerge' && options.autoMergeError) throw new Error(options.autoMergeError);
    if (operation === 'mergePullRequest' && options.mergeError) throw new Error(options.mergeError);
    return {};
  };
  const named = (name: string) => operations.filter(entry => entry.operation === name).map(entry => entry.variables);
  const queries = (name: string) => operations.filter(entry => entry.operation === name).map(entry => entry.query);
  return { github, named, queries };
}

test('unit:clean-pr-merged-head-bound — no queue and a CLEAN pull request: merged at once with expectedHeadOid set to the authorized head, auto-merge never enabled', async () => {
  for (const mergeStateStatus of ['CLEAN', 'HAS_HOOKS']) {
    const item = work();
    const fake = fakeGitHub({ mergeStateStatus });
    const gated = await gateMerge(fake.github, item, requested(item));
    assert.equal(gated.action.kind, 'enqueue', `${mergeStateStatus}: ${gated.action.reason}`);
    assert.equal(gated.state?.mergeStateStatus, mergeStateStatus);
    assert.deepEqual(fake.named('mergePullRequest'), [{ id: pullRequestId, head, method: 'MERGE' }], `${mergeStateStatus}: one merge, bound to the authorized head`);
    assert.match(fake.queries('mergePullRequest')[0], /expectedHeadOid: \$head/, 'GitHub refuses the merge if the head moved');
    assert.deepEqual(fake.named('enablePullRequestAutoMerge'), [], `${mergeStateStatus}: auto-merge is not enabled on a pull request GitHub merges now`);
    assert.deepEqual(fake.named('enqueuePullRequest'), []);
  }
});

test('unit:blocked-pr-auto-merge — no queue and a pull request GitHub cannot merge yet: auto-merge is enabled, bound to the head, and nothing merges now', async () => {
  for (const mergeStateStatus of ['BLOCKED', 'BEHIND', 'DIRTY', 'UNKNOWN', null]) {
    const item = work();
    const fake = fakeGitHub({ mergeStateStatus });
    assert.equal((await gateMerge(fake.github, item, requested(item))).action.kind, 'enqueue');
    assert.deepEqual(fake.named('enablePullRequestAutoMerge'), [{ id: pullRequestId, head, method: 'MERGE' }], `${mergeStateStatus}: auto-merge bound to the head`);
    assert.deepEqual(fake.named('mergePullRequest'), [], `${mergeStateStatus}: no immediate merge`);
  }
});

test('unit:unstable-merges-directly — no queue and an UNSTABLE pull request (only optional checks cancelled or failing): merged at once, head-bound, never auto-merge; an "unstable status" refusal falls back to the head-bound merge; DIRTY and BLOCKED never merge now', async () => {
  const item = work();
  const fake = fakeGitHub({ mergeStateStatus: 'UNSTABLE' }), request = requested(item);
  const gated = await gateMerge(fake.github, item, request);
  assert.equal(gated.action.kind, 'enqueue', gated.action.reason);
  assert.match(gated.action.reason, /merging it now, bound to that head/);
  assert.deepEqual(fake.named('mergePullRequest'), [{ id: pullRequestId, head, method: 'MERGE' }], 'exactly one merge, bound to the authorized head');
  assert.match(fake.queries('mergePullRequest')[0], /expectedHeadOid: \$head/);
  assert.deepEqual(fake.named('enablePullRequestAutoMerge'), [], 'no auto-merge request on an UNSTABLE pull request');
  assert.equal(gated.state?.requestedAt, request.at, 'the current request\'s time is kept on the state');

  // GitHub turned the pull request UNSTABLE between the read and the auto-merge request.
  for (const reason of ['Pull request is in unstable status', 'Pull request Pull request is in has_hooks status']) {
    const racing = fakeGitHub({ mergeStateStatus: 'BLOCKED', autoMergeError: reason });
    const fellBack = await gateMerge(racing.github, item, requested(item));
    assert.equal(fellBack.action.kind, 'enqueue', `${reason}: ${fellBack.action.reason}`);
    assert.equal(racing.named('enablePullRequestAutoMerge').length, 1);
    assert.deepEqual(racing.named('mergePullRequest'), [{ id: pullRequestId, head, method: 'MERGE' }], `${reason}: the head-bound merge follows`);
  }

  for (const mergeStateStatus of ['DIRTY', 'BLOCKED']) {
    const unmergeable = fakeGitHub({ mergeStateStatus, autoMergeError: 'Pull request is in dirty status' });
    await gateMerge(unmergeable.github, item, requested(item));
    assert.deepEqual(unmergeable.named('mergePullRequest'), [], `${mergeStateStatus}: never merged directly`);
  }
});

test('unit:clean-status-refusal-falls-back — auto-merge refused because the pull request became clean: merged at once, still bound to the head; any other refusal is a hold naming GitHub\'s reason', async () => {
  const item = work();
  const fake = fakeGitHub({ mergeStateStatus: 'BLOCKED', autoMergeError: 'Pull request Pull request is in clean status' });
  const gated = await gateMerge(fake.github, item, requested(item));
  assert.equal(gated.action.kind, 'enqueue', gated.action.reason);
  assert.equal(fake.named('enablePullRequestAutoMerge').length, 1);
  assert.deepEqual(fake.named('mergePullRequest'), [{ id: pullRequestId, head, method: 'MERGE' }]);

  const other = fakeGitHub({ mergeStateStatus: 'BLOCKED', autoMergeError: 'Resource not accessible by integration' });
  const held = await gateMerge(other.github, item, requested(item));
  assert.equal(held.action.kind, 'hold');
  assert.match(held.action.reason, /^GitHub refused to enqueue GY-42: Resource not accessible by integration/);
  assert.deepEqual(other.named('mergePullRequest'), [], 'only a clean-status refusal falls back to merging');

  const moved = fakeGitHub({ mergeStateStatus: 'CLEAN', mergeError: 'Head branch was modified. Review and try the merge again.' });
  const refused = await gateMerge(moved.github, item, requested(item));
  assert.equal(refused.action.kind, 'hold');
  assert.match(refused.action.reason, /^GitHub refused to enqueue GY-42: Head branch was modified/);
});

test('unit:merge-refused-status — master status names the latest refusal for the current head', () => {
  const refused = { reason: 'GitHub refused to enqueue GY-42: Pull request is in clean status', head, mode: 'none' as const, at: new Date().toISOString() };
  const githubQueue: GitHubMergeQueueState = { pullRequestId, head, queue: false, mergeStateStatus: 'CLEAN', mode: 'none', entryState: null, position: null, groupHead: null, at: new Date().toISOString(), refused };
  const item = work();
  item.observation!.githubQueue = githubQueue;
  const status: any = buildMasterStatus({ work: [item], now: new Date().toISOString() }, [], []);
  const row = status.work.find((entry: any) => entry.key === 'GY-42');
  assert.match(row.attention ?? '', /GitHub refused the merge request for GY-42 at aaaaaaaaaaaa.*Pull request is in clean status/);
  assert.match(row.attentionOwner?.next ?? JSON.stringify(row.attentionOwner), /integration job asks GitHub again/);
  // A refusal of an older head is not the current candidate's.
  const stale = work({ candidate: { ...item.candidate!, sha: 'c'.repeat(40) } });
  stale.observation!.githubQueue = githubQueue;
  const staleRow = (buildMasterStatus({ work: [stale], now: new Date().toISOString() }, [], []) as any).work.find((entry: any) => entry.key === 'GY-42');
  assert.doesNotMatch(staleRow.attention ?? '', /GitHub refused the merge request/);
});

// ---- The refusal is recorded once per reason and head, against a real engine ----------------------
const operator: Principal = { id: 'operator', role: 'admin' };
let pg: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 292;
  pg = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-merge-clean-pg-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('merge_clean_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/merge_clean_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'test/repository');
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });

test('integration:merge-refusal-recorded-once — a refused enqueue writes exactly one merge.enqueue.refused per reason and head, keeps it on the observation, and a success clears it', async () => {
  const created = await engine.execute(operator, 'create', null, { title: 'Refused merge', criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['unit:works'] }] }, randomUUID());
  const observation = { at: new Date().toISOString(), candidate: { sha: head, baseSha: base, pr: 42, branch: 'graphyard/refused', author: 'worker' }, reviews: [], checks: [], protected: true, mergeable: true, merged: false, mergeSha: null, files: [], scopeFiles: [] };
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{observation}',$2::jsonb) WHERE id=$1", [created.id, JSON.stringify(observation)]);
  const state: GitHubMergeQueueState = { pullRequestId, head, queue: false, mergeStateStatus: 'CLEAN', mode: 'none', entryState: null, position: null, groupHead: null, at: new Date().toISOString() };
  const refusal = { kind: 'hold' as const, reason: `GitHub refused to enqueue ${created.key}: Pull request Pull request is in clean status` };
  const events = async () => (await store.pool.query("SELECT payload->'details' AS details FROM events WHERE work_id=$1 AND kind='merge.enqueue.refused' ORDER BY seq", [created.id])).rows.map(row => row.details);

  let recorded = await engine.recordGitHubQueue(created.id, state, refusal);
  for (let observed = 0; observed < 3; observed++) recorded = await engine.recordGitHubQueue(created.id, { ...state, at: new Date().toISOString() }, refusal);
  const first = await events();
  assert.equal(first.length, 1, 'one event however many observations repeat the refusal');
  assert.equal(first[0].reason, refusal.reason);
  assert.equal(first[0].head, head);
  assert.equal(first[0].mode, 'none');
  assert.equal(recorded.observation?.githubQueue?.refused?.reason, refusal.reason, 'the refusal is kept on the observation for master status');

  // Another reason on the same head, and the same reason on another head, are each recorded once.
  const other = { kind: 'hold' as const, reason: `GitHub refused to enqueue ${created.key}: Resource not accessible by integration` };
  await engine.recordGitHubQueue(created.id, state, other);
  await engine.recordGitHubQueue(created.id, state, other);
  const movedHead = 'c'.repeat(40);
  await engine.recordGitHubQueue(created.id, { ...state, head: movedHead }, refusal);
  await engine.recordGitHubQueue(created.id, { ...state, head: movedHead }, refusal);
  assert.deepEqual((await events()).map(entry => [entry.reason, entry.head]), [[refusal.reason, head], [other.reason, head], [refusal.reason, movedHead]]);

  // An ordinary hold is not a refusal; a successful enqueue clears the standing refusal.
  await engine.recordGitHubQueue(created.id, state, { kind: 'hold', reason: `${created.key}: no merge was requested for candidate ${head.slice(0, 12)} at policy revision 1` });
  assert.equal((await events()).length, 3);
  const enqueued = await engine.recordGitHubQueue(created.id, state, { kind: 'enqueue', reason: 'merging it now' });
  assert.equal(enqueued.observation?.githubQueue?.refused ?? null, null);
});
