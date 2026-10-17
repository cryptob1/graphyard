import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_NAME, GitHub, gateMerge } from '../src/github.js';
import { type Observation, type Work } from '../src/model.js';
import { verdictContradictions, type MergeEnqueueRequest } from '../src/merge-queue.js';
import { mergeStallAttention } from '../src/cli/status-attention.js';

// GY-1917. On GY-1912 (PR #1300) the `Graphyard / merge` run at head 7252bcc7 read success when
// GitHub merged the head; an observation between the merge and the item reaching done threw
// (publish refuses success on a closed pull request), and the reconciliation error path then
// rewrote that run to REFUSED. Each test is named for its proof.

const head = '7'.repeat(40), base = 'e'.repeat(40), mergeSha = '3'.repeat(40);
const APP = 4935393, CI = 15368;
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
});
