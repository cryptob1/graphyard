import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as githubModule from '../src/github.js';
import { CHECK_NAME, GitHub, gateMerge } from '../src/github.js';
import { type Observation, type Work } from '../src/model.js';
import * as mergeQueue from '../src/merge-queue.js';
import type { MergeEnqueueRequest } from '../src/merge-queue.js';
import { mergeStallAttention } from '../src/cli/status-attention.js';

// GY-1917. On GY-1912 (PR #1300) the `Graphyard / merge` run at head 7252bcc7 read success when
// GitHub merged the head; an observation between the merge and the item reaching done threw
// (publish refuses success on a closed pull request), and the reconciliation error path then
// rewrote that run to REFUSED. Each test is named for its proof.

const head = '7'.repeat(40), base = 'e'.repeat(40), mergeSha = '3'.repeat(40);
const APP = 4935393, CI = 15368;
// Read through the namespace, so the file still loads (and its cases fail) against a base without it.
const verdictContradictions = (work: Work[]) => (mergeQueue as any).verdictContradictions(work) as { key: string; head: string; run: number; conclusion: string | null }[];
const reconciliationFailed = 'Reconciliation failed; fresh verification required';

function work(overrides: Partial<Work> = {}): Work {
  const candidate = { sha: head, baseSha: base, pr: 1300, branch: 'graphyard/gy-1912-1', author: 'worker' };
  return { id: 'work-1912', key: 'GY-1912', title: 'Observer lane', description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: [], stage: 'merge', revision: 9, policyRevision: 2, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 1,
    lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 1300 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: { at: new Date().toISOString(), candidate, reviews: [], checks: [], protected: true, mergeable: true, merged: false, prState: 'open', draft: false, baseTip: base } as unknown as Observation,
    blocker: null, gates: [{ name: 'merge', passed: true, reasons: [] }], violations: [], ...overrides } as Work;
}
const requested = (item: Work): MergeEnqueueRequest => ({ sha: item.candidate!.sha, baseSha: item.candidate!.baseSha, policyRevision: item.policyRevision, requestedBy: 'graphyard', at: new Date().toISOString() });

/** A GitHub whose check runs persist, and whose pull request a head-bound merge closes as merged. */
function fakeGitHub() {
  const runs: any[] = [];
  const writes: string[] = [];
  const pull = { number: 1300, state: 'open', draft: false, merged: false, merge_commit_sha: null as string | null, head: { sha: head }, base: { ref: 'main', sha: base } };
  const latest = () => runs.filter(run => run.name === CHECK_NAME && run.app.id === APP).sort((a, b) => b.id - a.id)[0] ?? null;
  const github = new GitHub({ repository: 'cryptob1/graphyard', base: 'main', appId: APP, installationId: 1, privateKey: 'not-used' });
  github.request = async (path: string, method = 'GET', body?: any) => {
    if (method === 'POST' && path === '/check-runs') {
      const run = { ...body, id: 117431141906 + runs.length, app: { id: APP } };
      runs.push(run); writes.push(`POST ${body.conclusion}`);
      return run;
    }
    if (method === 'PATCH' && path.startsWith('/check-runs/')) {
      const run = runs.find(entry => entry.id === Number(path.slice('/check-runs/'.length)))!;
      Object.assign(run, body); writes.push(`PATCH ${body.conclusion}`);
      return run;
    }
    if (method !== 'GET') return {};
    if (path === '/pulls/1300') return pull;
    if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: base } };
    if (/^\/commits\/[a-f0-9]{40}$/.test(path)) return { sha: path.slice(9), commit: { tree: { sha: 'f'.repeat(40) } } };
    if (path.startsWith(`/commits/${head}/check-runs`)) return { check_runs: runs.filter(run => path.includes(`check_name=${encodeURIComponent(run.name)}&`)) };
    throw new Error(`Unexpected GitHub request ${method} ${path}`);
  };
  github.graphql = async (query: string) => {
    if (/mergeQueue\(branch/.test(query)) return { repository: { mergeQueue: null, pullRequest: { id: 'PR_1300', headRefOid: head, mergeStateStatus: 'CLEAN', isInMergeQueue: false, autoMergeRequest: null, mergeQueueEntry: null } } };
    // The head-bound merge: GitHub merges the head and closes the pull request.
    if (/mergePullRequest/.test(query)) Object.assign(pull, { state: 'closed', merged: true, merge_commit_sha: mergeSha });
    return {};
  };
  return { github, runs, writes, latest, pull };
}

test('unit:merge-verdict-after-merge — a head GitHub merged keeps the Graphyard / merge run it was merged under: a later observation and the reconciliation error path write nothing, while an open head is still refused', async () => {
  const fake = fakeGitHub();
  // A first verdict while CI ran: REFUSED, as on GY-1912 at 15:22:21Z.
  const pending = work({ stage: 'test', gates: [{ name: 'test', passed: false, reasons: ['Required CI check test has not passed on the current candidate'] }] });
  await fake.github.publish(pending, reconciliationFailed);
  assert.equal(fake.latest().conclusion, 'failure');

  // Every gate passes: success is published, then the head-bound merge, and GitHub merges.
  const item = work();
  const gated = await gateMerge(fake.github, item, requested(item));
  assert.equal(gated.action.kind, 'enqueue', gated.action.reason);
  assert.equal(fake.pull.merged, true, 'GitHub merged the head');
  const merged = fake.latest();
  assert.deepEqual([merged.conclusion, merged.output.title], ['success', 'All required gates passed']);
  const written = fake.writes.length;

  // An observation between the merge and the item reaching done: publishing success on the closed
  // pull request no longer throws, and it writes nothing.
  assert.deepEqual(await fake.github.publish(item), { id: merged.id, conclusion: 'success' });
  // The reconciliation error path's forced REFUSED reads the merged state first and writes nothing.
  assert.deepEqual(await fake.github.publish(item, reconciliationFailed), { id: merged.id, conclusion: 'success' });
  // Nor does a later refusal from failing gates.
  await fake.github.publish(pending, reconciliationFailed);
  assert.equal(fake.writes.length, written, 'no write reaches the merged head');
  assert.deepEqual([fake.latest().id, fake.latest().conclusion, fake.latest().output.title], [merged.id, 'success', 'All required gates passed'], 'the run still reads success afterwards');

  // A still-open head's error path publishes REFUSED as before.
  const open = fakeGitHub();
  await open.github.publish(item);
  assert.equal(open.latest().conclusion, 'success');
  const refused = await open.github.publish(item, reconciliationFailed);
  assert.equal(refused?.conclusion, 'failure');
  assert.equal(open.latest().output.title, 'REFUSED');
  assert.match(open.latest().output.summary, /Reconciliation failed; fresh verification required/);

  // A stale candidate: the pull request moved to another head, and GitHub merged that one. The
  // recorded head was not delivered, so its error path still publishes REFUSED on it.
  const stale = fakeGitHub();
  await stale.github.publish(item);
  assert.equal(stale.latest().conclusion, 'success');
  Object.assign(stale.pull, { state: 'closed', merged: true, merge_commit_sha: mergeSha, head: { sha: 'b'.repeat(40) } });
  assert.equal((await stale.github.publish(item, reconciliationFailed))?.conclusion, 'failure');
  assert.equal(stale.latest().output.title, 'REFUSED', 'the stale head is refused');

  // GitHub merges the head while the write guard runs: the refusal re-reads the pull request and writes nothing.
  const racing = fakeGitHub();
  await racing.github.publish(item);
  const raced = racing.writes.length;
  assert.deepEqual(await racing.github.publish(item, reconciliationFailed, async () => { Object.assign(racing.pull, { state: 'closed', merged: true, merge_commit_sha: mergeSha }); }),
    { id: racing.latest().id, conclusion: 'success' });
  assert.equal(racing.writes.length, raced, 'a merge during the guard freezes the head');

  // A success publication whose guard spans the merge, its output differing from the standing
  // success (a new policy revision): it re-reads the pull request too and writes nothing.
  const succeeding = fakeGitHub();
  await succeeding.github.publish(item);
  const succeeded = succeeding.writes.length;
  assert.deepEqual(await succeeding.github.publish({ ...item, policyRevision: 3 }, undefined, async () => { Object.assign(succeeding.pull, { state: 'closed', merged: true, merge_commit_sha: mergeSha }); }),
    { id: succeeding.latest().id, conclusion: 'success' });
  assert.equal(succeeding.writes.length, succeeded, 'a success publication spanning the merge writes nothing');
  assert.equal(succeeding.latest().output.summary, `Candidate ${head}; base ${base}; policy 2`);

  // A refusal on an open head whose update GitHub answers with the completed run's unchanged
  // success, and GitHub merges during that update: no fallback run is created over the delivery.
  const patching = fakeGitHub();
  await patching.github.publish(item);
  const request = patching.github.request.bind(patching.github);
  patching.github.request = async (path: string, method = 'GET', body?: any) => {
    if (method !== 'PATCH') return request(path, method, body);
    patching.writes.push(`PATCH ${body.conclusion} (kept)`);
    Object.assign(patching.pull, { state: 'closed', merged: true, merge_commit_sha: mergeSha });
    return patching.latest();
  };
  assert.deepEqual(await patching.github.publish(item, reconciliationFailed), { id: patching.latest().id, conclusion: 'success' });
  assert.equal(patching.runs.length, 1, 'no run is created after the merge');
  assert.deepEqual([patching.latest().conclusion, patching.latest().output.title], ['success', 'All required gates passed']);
  // The same answer on a head that stays open still creates the REFUSED run, as before.
  const kept = fakeGitHub();
  await kept.github.publish(item);
  const keptRequest = kept.github.request.bind(kept.github);
  kept.github.request = async (path: string, method = 'GET', body?: any) => method === 'PATCH' ? kept.latest() : keptRequest(path, method, body);
  assert.equal((await kept.github.publish(item, reconciliationFailed))?.conclusion, 'failure');
  assert.deepEqual([kept.runs.length, kept.latest().output.title], [2, 'REFUSED']);
});

/** An observer of PR #1300 merged at `head`, its App's latest `Graphyard / merge` run reading `conclusion`. */
function observer(conclusion: string) {
  const github = new GitHub({ repository: 'cryptob1/graphyard', base: 'main', appId: APP, installationId: 1, privateKey: 'not-used' });
  github.mergeabilityRetryMs = 0;
  github.controlPlaneLogin = async () => 'graphyard-cryptob1-graphyard[bot]';
  const checks = [
    { id: 117431141906, name: CHECK_NAME, head_sha: head, status: 'completed', conclusion, app: { id: APP } },
    { id: 117431141000, name: CHECK_NAME, head_sha: head, status: 'completed', conclusion: 'success', app: { id: APP } },
    { id: 117432386787, name: 'test', head_sha: head, status: 'completed', conclusion: 'success', app: { id: CI } },
  ];
  github.request = async (path, method = 'GET') => {
    if (method !== 'GET') return { id: 12 };
    if (path === '/pulls/1300') return { number: 1300, head: { sha: head, ref: 'graphyard/gy-1912-1', repo: { full_name: 'cryptob1/graphyard' } }, base: { sha: base, ref: 'main', repo: { full_name: 'cryptob1/graphyard' } },
      user: { login: 'implementer', id: 7 }, merged: true, mergeable: null, draft: false, state: 'closed', merge_commit_sha: mergeSha, created_at: null };
    if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: mergeSha } };
    if (/^\/commits\/[a-f0-9]{40}$/.test(path)) return { sha: path.slice(9), commit: { tree: { sha: 'f'.repeat(40) } }, parents: [], author: null };
    if (path.startsWith('/compare/')) return { status: 'ahead', files: [] };
    if (path === '/branches/main/protection') return { required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: APP }], contexts: [CHECK_NAME] } };
    if (path === '/rules/branches/main') return [];
    if (path.includes('/status?')) return { statuses: [] };
    if (path.includes('/reviews')) return [];
    if (path.includes('/files')) return [{ filename: 'src/feature.ts', status: 'modified', sha: 'c'.repeat(40), additions: 1, deletions: 0 }];
    if (path.includes('/check-runs')) return { check_runs: checks };
    throw new Error(`Unexpected request ${path}`);
  };
  return github;
}
const observe = (github: GitHub) => github.observe({ id: 'work-1912', key: 'GY-1912', stage: 'done', policy: { review: false, checks: ['test'] }, plannedFiles: ['src/feature.ts'], submission: { pr: 1300, epoch: 1 }, policyRevision: 2, observation: null } as unknown as Work);

test('unit:merge-verdict-contradiction-attention — master status names a delivered item whose merged head\'s latest Graphyard / merge run reads other than success while its recorded gates passed, with key, head, run id and conclusion', async () => {
  // The merged observation records the App's latest run at the merged head.
  const contradicted = await observe(observer('failure'));
  assert.deepEqual(contradicted.mergeVerdict, { id: 117431141906, conclusion: 'failure' });
  const agreeing = await observe(observer('success'));
  assert.deepEqual(agreeing.mergeVerdict, { id: 117431141906, conclusion: 'success' });

  const delivered = (observation: Observation, overrides: Partial<Work> = {}) => work({ stage: 'done', observation, gates: [{ name: 'merge', passed: true, reasons: [] }], ...overrides });
  const found = verdictContradictions([delivered(contradicted)]);
  assert.deepEqual(found.map(entry => [entry.key, entry.head, entry.run, entry.conclusion]), [['GY-1912', head, 117431141906, 'failure']]);
  const attention = mergeStallAttention({ work: [delivered(contradicted)], now: new Date().toISOString() });
  assert.equal(attention.length, 1, 'one attention item');
  assert.equal(attention[0].subject, 'GY-1912');
  assert.match(attention[0].text, /^public-verdict-contradicts-delivery: GY-1912 merged head 7{12} .*run 117431141906 reads failure/);

  // No attention for a passing verdict, a gate that did not pass, a closed (undelivered) item, or an open item.
  assert.deepEqual(verdictContradictions([delivered(agreeing)]), []);
  assert.deepEqual(verdictContradictions([delivered(contradicted, { gates: [{ name: 'merge', passed: false, reasons: ['refused'] }] })]), []);
  assert.deepEqual(verdictContradictions([delivered(contradicted, { closure: { reason: 'closed' } as any })]), []);
  assert.deepEqual(verdictContradictions([work({ observation: contradicted })]), []);
  assert.deepEqual(mergeStallAttention({ work: [delivered(agreeing)], now: new Date().toISOString() }), []);

  // A run rewritten after the item reached done: the delivered-verdict refresh re-reads it, records
  // it on the delivered observation, and master status then names it; a second refresh saves nothing.
  const refreshDeliveredVerdicts = (githubModule as any).refreshDeliveredVerdicts as (engine: any, github: any) => Promise<number>;
  assert.equal(typeof refreshDeliveredVerdicts, 'function', 'the delivered verdict is re-read after done');
  const stored = delivered(structuredClone(agreeing), { delivery: { mergedAt: new Date().toISOString(), mergeSha, authorizationRevision: 9 } as any });
  const saves: string[] = [];
  const db = { query: async (sql: string, params: any[] = []) => {
    if (/^SELECT document FROM work_items/.test(sql)) return { rows: [{ document: structuredClone(stored) }], rowCount: 1 };
    if (/^UPDATE work_items SET document/.test(sql)) { Object.assign(stored, JSON.parse(params[1])); return { rows: [], rowCount: 1 }; }
    if (/^INSERT INTO events/.test(sql)) { saves.push(params[2]); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  } };
  const engine = { store: {
    pool: { query: async () => ({ rows: [{ id: stored.id, head: stored.observation!.candidate.sha, verdict: stored.observation!.mergeVerdict }] }) },
    transaction: (fn: (client: any, at: Date) => Promise<unknown>) => fn(db, new Date()),
  } };
  let live = { id: 117431141906, conclusion: 'success' as string | null };
  const reads: string[] = [];
  const reader = { mergeVerdictOf: async (sha: string) => { reads.push(sha); return live; } };
  assert.equal(await refreshDeliveredVerdicts(engine, reader), 0, 'an unchanged verdict saves nothing');
  live = { id: 117431141907, conclusion: 'failure' };
  assert.equal(await refreshDeliveredVerdicts(engine, reader), 1);
  assert.deepEqual(saves, ['merge-verdict.refreshed']);
  assert.equal(stored.stage, 'done', 'the delivery stands');
  assert.deepEqual(verdictContradictions([stored]).map(entry => [entry.key, entry.head, entry.run, entry.conclusion]), [['GY-1912', head, 117431141907, 'failure']]);
  assert.match(mergeStallAttention({ work: [stored], now: new Date().toISOString() })[0].text, /^public-verdict-contradicts-delivery: GY-1912 merged head 7{12} .*run 117431141907 reads failure/);
  assert.equal(await refreshDeliveredVerdicts(engine, reader), 0, 'the recorded contradiction is not saved again');
  assert.deepEqual([reads.length, saves.length], [3, 1], 'one read per delivered head per refresh, one save per change');
});
