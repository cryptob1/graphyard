import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_NAME, GitHub, gateMerge } from '../src/github.js';
import { LANDABLE_CHECK, type Observation, type Work } from '../src/model.js';
import { requiredCheckDisagreements, requiredChecksOf, type MergeEnqueueRequest } from '../src/merge-queue.js';
import { mergeStallAttention } from '../src/cli/status-attention.js';

// GY-1884. On GY-1871 (PR #1265) the only `Graphyard / merge` run at head e95a92c2 read REFUSED
// when the loop requested auto-merge and GitHub merged the head, and the observation recorded
// branch protection's required checks as secrets, test and typecheck with no app, while GitHub
// required five, two of them Graphyard's own App-bound checks. Each test is named for its proof.

const head = 'e'.repeat(40), base = 'b'.repeat(40);
const pullRequestId = 'PR_kwDOgraphyard1884';
const APP = 4935393, CI = 15368;

function work(overrides: Partial<Work> = {}): Work {
  const candidate = { sha: head, baseSha: base, pr: 1265, branch: 'graphyard/gy-1871-1', author: 'worker' };
  return { id: 'work-1871', key: 'GY-1871', title: 'Merge check', description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: [], stage: 'merge', revision: 9, policyRevision: 2, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 1,
    lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 1265 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: { at: new Date().toISOString(), candidate, reviews: [], checks: [], protected: true, mergeable: true, merged: false, prState: 'open', draft: false, baseTip: base } as unknown as Observation,
    blocker: null, gates: [{ name: 'merge', passed: true, reasons: [] }], violations: [], ...overrides } as Work;
}
const refused = () => work({ stage: 'test', gates: [{ name: 'test', passed: false, reasons: ['Required CI check test has not passed on the current candidate'] }] });
const requested = (item: Work): MergeEnqueueRequest => ({ sha: item.candidate!.sha, baseSha: item.candidate!.baseSha, policyRevision: item.policyRevision, requestedBy: 'graphyard', at: new Date().toISOString() });

/**
 * A base branch with no merge queue whose check runs persist across gate passes. `frozen` makes
 * GitHub answer an update of a completed run with the run unchanged; `stuck` makes every write
 * answer the run's old conclusion, so no success ever stands at the head.
 */
function fakeGitHub(options: { mergeStateStatus: string; frozen?: boolean; stuck?: boolean }) {
  const runs: any[] = [];
  const writes: { method: string; id: number | null; conclusion: string }[] = [];
  const merges: { operation: string; latest: string | null }[] = [];
  const latest = () => runs.filter(run => run.name === CHECK_NAME && run.head_sha === head && run.app.id === APP).sort((a, b) => b.id - a.id)[0] ?? null;
  const github = new GitHub({ repository: 'cryptob1/graphyard', base: 'main', appId: APP, installationId: 1, privateKey: 'not-used' });
  github.request = async (path: string, method = 'GET', body?: any) => {
    if (method === 'POST' && path === '/check-runs') {
      const run = { ...body, id: 117343871285 + runs.length, app: { id: APP }, conclusion: options.stuck && runs.length ? runs[0].conclusion : body.conclusion };
      runs.push(run);
      writes.push({ method, id: run.id, conclusion: body.conclusion });
      return run;
    }
    if (method === 'PATCH' && path.startsWith('/check-runs/')) {
      const run = runs.find(entry => entry.id === Number(path.slice('/check-runs/'.length)))!;
      writes.push({ method, id: run.id, conclusion: body.conclusion });
      if (!options.frozen && !options.stuck) Object.assign(run, body);
      return run;
    }
    if (method !== 'GET') return {};
    if (path === '/pulls/1265') return { number: 1265, state: 'open', draft: false, head: { sha: head }, base: { ref: 'main', sha: base } };
    if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: base } };
    if (/^\/commits\/[a-f0-9]{40}$/.test(path)) return { sha: path.slice(9), commit: { tree: { sha: 'f'.repeat(40) } } };
    if (path.startsWith(`/commits/${head}/check-runs`)) return { check_runs: runs.filter(run => path.includes(`check_name=${encodeURIComponent(run.name)}`)) };
    throw new Error(`Unexpected GitHub request ${method} ${path}`);
  };
  github.graphql = async (query: string) => {
    const operation = /(enablePullRequestAutoMerge|mergePullRequest|enqueuePullRequest|disablePullRequestAutoMerge|dequeuePullRequest|mergeQueue\(branch)/.exec(query)?.[1] ?? 'unknown';
    if (operation === 'mergeQueue(branch') return { repository: { mergeQueue: null, pullRequest: { id: pullRequestId, headRefOid: head, mergeStateStatus: options.mergeStateStatus, isInMergeQueue: false, autoMergeRequest: null, mergeQueueEntry: null } } };
    merges.push({ operation, latest: latest()?.conclusion ?? null });
    return {};
  };
  const requests = () => merges.filter(entry => ['enablePullRequestAutoMerge', 'mergePullRequest', 'enqueuePullRequest'].includes(entry.operation));
  return { github, runs, writes, latest, requests };
}

test('unit:merge-check-updated-before-auto-merge — a head first refused gets its Graphyard / merge run updated, or a new one created, to success before auto-merge or a merge is requested; a failing head or a run that stays REFUSED never has a merge requested', async () => {
  for (const mergeStateStatus of ['BLOCKED', 'CLEAN']) {
    const fake = fakeGitHub({ mergeStateStatus });
    // The first verdict: the test check is still pending, so the head is refused and nothing is requested.
    const first = await gateMerge(fake.github, refused(), requested(refused()));
    assert.notEqual(first.action.kind, 'enqueue', `${mergeStateStatus}: ${first.action.reason}`);
    assert.deepEqual(fake.runs.map(run => [run.conclusion, run.output.title]), [['failure', 'REFUSED']]);
    assert.deepEqual(fake.requests(), [], `${mergeStateStatus}: a head whose gates fail never has auto-merge requested`);
    // Another observation while the gates still fail: still refused, still nothing requested.
    await gateMerge(fake.github, refused(), requested(refused()));
    assert.deepEqual(fake.requests(), []);

    // Every gate now passes: the REFUSED run is updated in place to the passing verdict, then the merge is requested.
    const item = work();
    const gated = await gateMerge(fake.github, item, requested(item));
    assert.equal(gated.action.kind, 'enqueue', gated.action.reason);
    assert.equal(fake.runs.length, 1, 'the standing run is updated, not duplicated');
    assert.deepEqual([fake.latest().conclusion, fake.latest().output.title], ['success', 'All required gates passed']);
    assert.match(fake.latest().output.summary, new RegExp(`Candidate ${head}; base ${base}; policy 2`));
    const expected = mergeStateStatus === 'CLEAN' ? 'mergePullRequest' : 'enablePullRequestAutoMerge';
    assert.deepEqual(fake.requests(), [{ operation: expected, latest: 'success' }], `${mergeStateStatus}: requested once, while the latest run at the head reads success`);
  }

  // GitHub answers the update of the completed REFUSED run with the run unchanged: a new run is
  // created with the passing verdict, so the latest run at the head is success before auto-merge.
  const frozen = fakeGitHub({ mergeStateStatus: 'BLOCKED', frozen: true });
  await gateMerge(frozen.github, refused(), requested(refused()));
  const item = work();
  assert.equal((await gateMerge(frozen.github, item, requested(item))).action.kind, 'enqueue');
  assert.deepEqual(frozen.writes.map(write => [write.method, write.conclusion]), [['POST', 'failure'], ['PATCH', 'success'], ['POST', 'success']]);
  assert.deepEqual(frozen.runs.map(run => run.conclusion), ['failure', 'success'], 'the REFUSED run stands beside a newer success');
  assert.deepEqual(frozen.requests(), [{ operation: 'enablePullRequestAutoMerge', latest: 'success' }]);

  // No write makes the latest run read success: the merge is held and never requested.
  const stuck = fakeGitHub({ mergeStateStatus: 'CLEAN', stuck: true });
  await gateMerge(stuck.github, refused(), requested(refused()));
  const held = await gateMerge(stuck.github, item, requested(item));
  assert.equal(held.action.kind, 'hold');
  assert.match(held.action.reason, /latest Graphyard \/ merge run at e{12} reads failure, not success/);
  assert.equal(stuck.latest().conclusion, 'failure');
  assert.deepEqual(stuck.requests(), [], 'the loop never requests a merge while the latest Graphyard / merge run at the head is not success');
});

/** The classic protection GitHub returned for main on 10-17: every check in `checks` with its app, and by name again in the legacy `contexts`. */
const liveProtection = {
  required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true },
  required_status_checks: { strict: false,
    checks: [{ context: 'test', app_id: CI }, { context: 'typecheck', app_id: CI }, { context: 'secrets', app_id: CI }, { context: CHECK_NAME, app_id: APP }, { context: LANDABLE_CHECK, app_id: APP }],
    contexts: ['test', 'typecheck', 'secrets', CHECK_NAME, LANDABLE_CHECK] },
  enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false },
};
function observer(protection: unknown) {
  const github = new GitHub({ repository: 'cryptob1/graphyard', base: 'main', appId: APP, installationId: 1, privateKey: 'not-used' });
  github.mergeabilityRetryMs = 0;
  github.controlPlaneLogin = async () => 'graphyard-cryptob1-graphyard[bot]';
  github.request = async (path, method = 'GET') => {
    if (method !== 'GET') return { id: 12 };
    if (path === '/pulls/1265') return { number: 1265, head: { sha: head, ref: 'graphyard/gy-1871-1', repo: { full_name: 'cryptob1/graphyard' } }, base: { sha: base, ref: 'main', repo: { full_name: 'cryptob1/graphyard' } },
      user: { login: 'implementer', id: 7 }, merged: false, mergeable: true, draft: false, state: 'open', merge_commit_sha: null, created_at: null };
    if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: base } };
    if (/^\/commits\/[a-f0-9]{40}$/.test(path)) return { sha: path.slice(9), commit: { tree: { sha: 'f'.repeat(40) } }, parents: [], author: null };
    if (path.startsWith('/compare/')) return { status: 'ahead', files: [] };
    if (path === '/branches/main/protection') return protection;
    if (path === '/rules/branches/main') return [];
    if (path.includes('/status?')) return { statuses: [] };
    if (path.includes('/reviews')) return [];
    if (path.includes('/files')) return [{ filename: 'src/feature.ts', status: 'modified', sha: 'c'.repeat(40), additions: 1, deletions: 0 }];
    if (path.includes('/check-runs')) return { check_runs: [{ id: 9, name: 'test', status: 'completed', conclusion: 'success', app: { id: CI } }] };
    throw new Error(`Unexpected request ${path}`);
  };
  return github;
}
const observe = (github: GitHub) => github.observe({ id: 'work-1871', key: 'GY-1871', policy: { review: false, checks: ['test', 'typecheck'] }, plannedFiles: ['src/feature.ts'], submission: { pr: 1265, epoch: 1 }, policyRevision: 1, observation: null } as unknown as Work);

test('unit:required-checks-include-app-bound-graphyard-checks — the required-checks observation records all five checks with their app ids, and a record that disagrees with the protection GitHub returns raises one attention item naming both lists', async () => {
  const observation = await observe(observer(liveProtection));
  assert.deepEqual(observation.requiredChecks, [
    { name: CHECK_NAME, appId: APP }, { name: LANDABLE_CHECK, appId: APP }, { name: 'secrets', appId: CI }, { name: 'test', appId: CI }, { name: 'typecheck', appId: CI },
  ], 'all five, each bound to its app: the legacy contexts echo never loosens a binding');
  assert.equal(observation.protected, true);
  // The gates still never wait on Graphyard's own two checks.
  const observed = work({ observation });
  assert.deepEqual(requiredChecksOf(observed).map(check => [check.name, check.policy, check.appId]), [['test', true, null], ['typecheck', true, null], ['secrets', false, CI]]);
  // The record agrees with what GitHub returned: no attention.
  assert.deepEqual(requiredCheckDisagreements([observed]), []);

  // A context protection lists by name only stays bound to no app.
  const unbound = await observe(observer({ ...liveProtection, required_status_checks: { ...liveProtection.required_status_checks, contexts: [...liveProtection.required_status_checks.contexts, 'lint'] } }));
  assert.deepEqual(unbound.requiredChecks!.find(check => check.name === 'lint'), { name: 'lint', appId: null });
  assert.deepEqual(requiredCheckDisagreements([work({ observation: unbound })]), []);

  // GY-1871's record against the protection GitHub returned: one attention item naming both lists,
  // however many open items observed the same disagreement.
  const stale = { ...observation, requiredChecks: [{ name: 'secrets', appId: null }, { name: 'test', appId: null }, { name: 'typecheck', appId: null }] } as Observation;
  const items = [work({ observation: stale }), work({ id: 'work-1876', key: 'GY-1876', observation: stale })];
  const disagreements = requiredCheckDisagreements(items);
  assert.equal(disagreements.length, 1);
  assert.deepEqual(disagreements[0].keys, ['GY-1871', 'GY-1876']);
  assert.equal(disagreements[0].recorded, 'secrets (any app), test (any app), typecheck (any app)');
  assert.equal(disagreements[0].protection, `${CHECK_NAME} (app ${APP}), ${LANDABLE_CHECK} (app ${APP}), secrets (app ${CI}), test (app ${CI}), typecheck (app ${CI})`);
  const attention = mergeStallAttention({ work: items, now: new Date().toISOString() });
  assert.equal(attention.length, 1, 'one attention item');
  assert.equal(attention[0].subject, 'GY-1871');
  assert.ok(attention[0].text.includes(disagreements[0].recorded) && attention[0].text.includes(disagreements[0].protection), attention[0].text);
  assert.match(attention[0].text, /^required-checks-disagree: /);

  // A record binding a check to another app than GitHub does disagrees too; an observation from
  // before the protection entries were kept, or a done item, is not judged.
  const rebound = { ...observation, requiredChecks: observation.requiredChecks!.map(check => check.name === 'test' ? { ...check, appId: 99 } : check) } as Observation;
  assert.equal(requiredCheckDisagreements([work({ observation: rebound })]).length, 1);
  assert.deepEqual(requiredCheckDisagreements([work({ observation: { ...stale, protectionChecks: undefined } as Observation }), work({ stage: 'done', observation: stale })]), []);
});
