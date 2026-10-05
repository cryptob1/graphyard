import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_APP_ID, CODEX_USER_ID } from '../src/codex-review.js';
import { GitHub, CHECK_NAME, scopeLookupBudget, compareFileCap } from '../src/github.js';
// A namespace import, so on a base without GY-1329's helpers these tests fail as cases rather than the file failing to load.
import * as mergeQueue from '../src/merge-queue.js';
import type { CheckRerun } from '../src/merge-queue.js';
import { Refusal, type Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// @ts-expect-error Dependency-free inspection script.
import { evaluateEnforcement } from '../scripts/verify-enforcement.mjs';
const head = 'a'.repeat(40), base = 'b'.repeat(40);
function fixture() {
  const calls: { path: string; method: string; body: any }[] = [];
  const pr: any = { number: 10, head: { sha: head, ref: 'graphyard/task', repo: { full_name: 'owner/repo' } }, base: { sha: base, ref: 'main', repo: { full_name: 'owner/repo' } }, user: { login: 'author' }, merged: false, mergeable: true, draft: false, state: 'open', merge_commit_sha: null };
  let reviews: any[] = [];
  let protectedBranch = true;
  let upToDateRequired = false;
  let prFiles: any[] = [{ filename: 'src/claims.ts', status: 'modified', sha: 'c'.repeat(40), additions: 3, deletions: 1, patch: '@@' }];
  let baseBlobs: Record<string, string> = {};
  // The managed branch's real head, read from its ref; the pull request's cached base.sha is
  // deliberately a separate value so a test can let GitHub's cache fall behind the branch.
  let branchTip = base;
  let comparison = 'ahead';
  let baseChanges: any[] = [];
  let commits: Record<string, any> = {};
  const github = new GitHub({ repository: 'owner/repo', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used-in-adapter-test' });
  github.controlPlaneLogin = async () => 'graphyard-owner-repo[bot]';
  const mutations: Record<string, () => any> = {};
  github.request = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (method !== 'GET') return path in mutations ? mutations[path]() : { id: 12 };
    if (/^\/commits\/[a-f0-9]{40}$/.test(path)) return { sha: path.slice(9), commit: { tree: { sha: `f${path.slice(10)}` } }, ...(commits[path.slice(9)] ?? {}) };
    if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: branchTip } };
    // GitHub paginates a comparison's commits only: the files come on the first page alone, at most compareFileCap of them.
    if (path.startsWith('/compare/')) { const page = Number(path.match(/[?&]page=(\d+)/)?.[1] ?? 1); return { status: comparison, files: page === 1 ? baseChanges.slice(0, compareFileCap) : [] }; }
    if (path === '/pulls/10') return structuredClone(pr);
    if (path.includes('/protection')) return { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: upToDateRequired, checks: [{ context: CHECK_NAME, app_id: protectedBranch ? 1234 : 999 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
    if (path.includes('/reviews')) return reviews;
    if (path.includes('/files')) { const page = Number(path.match(/[?&]page=(\d+)/)?.[1] ?? 1); return prFiles.slice((page - 1) * 100, page * 100); }
    if (path.startsWith('/contents/')) {
      const target = decodeURIComponent(path.slice(10, path.indexOf('?'))), ref = path.slice(path.indexOf('ref=') + 4);
      const blob = baseBlobs[`${ref}:${target}`];
      if (!blob) throw new Refusal(`GitHub GET ${path} failed (404)`, 502);
      return { type: 'file', sha: blob, path: target };
    }
    if (path.includes('check_name=')) return { check_runs: [{ id: 12, name: CHECK_NAME, app: { id: 1234 } }] };
    if (path.includes('/check-runs')) return { check_runs: [{ id: 9, name: 'test', status: 'completed', conclusion: 'success', app: { id: 15368 } }, { id: 12, name: CHECK_NAME, status: 'completed', conclusion: 'failure', app: { id: 1234 } }] };
    throw new Error(`Unexpected request ${path}`);
  };
  const work = { id: 'task-id', key: 'GY-41', policy: { review: true, checks: ['test'] }, plannedFiles: ['src/claims.ts'], submission: { pr: 10, epoch: 1 }, candidate: { sha: head, baseSha: base, pr: 10 }, policyRevision: 1, revision: 3, gates: [{ name: 'acceptance', passed: false, reasons: ['AC-1 requires proof'] }], violations: [] } as unknown as Work;
  return { github, calls, pr, work, mutations, reviews: (r: any[]) => { reviews = r; }, protection: (p: boolean) => { protectedBranch = p; },
    requireUpToDate: (required: boolean) => { upToDateRequired = required; }, files: (f: any[]) => { prFiles = f; }, baseBlobs: (b: Record<string, string>) => { baseBlobs = b; },
    branch: (sha: string) => { branchTip = sha; }, compare: (status: string, changed: any[] = []) => { comparison = status; baseChanges = changed; }, commit: (sha: string, detail: any) => { commits[sha] = detail; } };
}
test('GitHub adapter binds observations to repository, base, current reviews, and producer', async () => {
  const f = fixture(); f.reviews([{ id: 10, user: { login: 'reviewer' }, commit_id: head, state: 'APPROVED' }, { id: 11, user: { login: 'reviewer' }, commit_id: head, state: 'CHANGES_REQUESTED', submitted_at: '2026-01-01T00:01:00Z' }]);
  const obs = await f.github.observe(f.work);
  assert.ok(f.calls.some(call => call.path.includes('/check-runs?filter=all')), 'all check-run identities are observed so retries are retained');
  assert.deepEqual(obs.checks, [{ name: 'test', result: 'success', appId: 15368, id: 9 }]);
  assert.deepEqual(obs.reviewIds, [10, 11]); assert.equal(obs.reviews[0].id, 11); assert.equal(obs.reviews[0].submittedAt, '2026-01-01T00:01:00Z'); assert.equal(obs.reviews[0].state, 'CHANGES_REQUESTED'); assert.equal(obs.candidate.baseSha, base); assert.equal(obs.protected, true);
  f.pr.base.ref = 'other'; await assert.rejects(f.github.observe(f.work), /unmanaged/);
  f.pr.base.ref = 'main'; f.pr.head.repo.full_name = 'attacker/fork'; await assert.rejects(f.github.observe(f.work), /same-repository/);
});
test('GY-1060: a required status context is read as a commit status, and protection and rulesets are read once across observations', async () => {
  const f = fixture(), request = f.github.request.bind(f.github);
  f.github.request = async (path, method, body) => {
    if (path.includes('/protection')) { const p = await request(path, method, body); return { ...p, required_status_checks: { ...p.required_status_checks, contexts: ['ci/legacy'] } }; }
    if (path.startsWith('/rules/branches/')) { f.calls.push({ path, method: method ?? 'GET', body }); return [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'secrets', integration_id: 77 }] } }]; }
    if (path === `/commits/${head}/status?per_page=100&page=1`) { f.calls.push({ path, method: method ?? 'GET', body }); return { statuses: [{ context: 'ci/legacy', state: 'error' }, { context: 'unrequired', state: 'failure' }] }; }
    return request(path, method, body);
  };
  const obs = await f.github.observe(f.work);
  assert.deepEqual(obs.requiredChecks, [{ name: 'ci/legacy', appId: null }, { name: 'secrets', appId: 77 }]);
  assert.deepEqual(obs.checks, [{ name: 'test', result: 'success', appId: 15368, id: 9 }, { name: 'ci/legacy', result: 'failure', appId: 0, source: 'status' }],
    'only the required context no check run reports is read from statuses, an error as a failure');
  await f.github.observe(f.work);
  const reads = (pattern: RegExp) => f.calls.filter(call => pattern.test(call.path)).length;
  assert.equal(reads(/\/protection$/), 1, 'the second observation reuses the protection read');
  assert.equal(reads(/^\/rules\/branches\//), 1, 'and the ruleset read');
  assert.equal(reads(/\/status\?/), 1, 'a settled terminal status is cached per head and reused across observations');
  await f.github.protection(); await f.github.protection();
  assert.equal(reads(/\/protection$/), 3, 'a direct protection read is never shared');
});
test('GY-1060: every page of the combined status is read, and another app\'s run of a required context does not hide its status', async () => {
  const f = fixture(), request = f.github.request.bind(f.github);
  const filler = Array.from({ length: 100 }, (_, index) => ({ context: `other/${index}`, state: 'success' }));
  f.github.request = async (path, method, body) => {
    if (path.includes('/protection')) { const p = await request(path, method, body); return { ...p, required_status_checks: { ...p.required_status_checks, contexts: ['ci/legacy'] } }; }
    if (path.startsWith('/rules/branches/')) return [];
    if (path.startsWith(`/commits/${head}/status?`)) { f.calls.push({ path, method: method ?? 'GET', body }); return { statuses: path.endsWith('&page=1') ? filler : [{ context: 'ci/legacy', state: 'success' }] }; }
    if (path.includes('/check-runs') && !path.includes('check_name=')) {
      const runs = await request(path, method, body);
      return { check_runs: [...runs.check_runs, { id: 30, name: 'ci/legacy', status: 'queued', conclusion: null, app: { id: 4242 } }] };
    }
    return request(path, method, body);
  };
  const obs = await f.github.observe(f.work);
  assert.deepEqual(obs.checks.filter(check => check.name === 'ci/legacy').map(check => [check.appId, check.result, check.source]), [[4242, 'queued', undefined], [0, 'success', 'status']],
    'the status on the second page is read beside the stray run');
  assert.equal(f.calls.filter(call => call.path.startsWith(`/commits/${head}/status?`)).length, 2);
});
test('GY-1060: pending statuses re-read, finished PRs skip status reads, and status read errors fail observation', async () => {
  // 1. Pending statuses are re-read across observations (not cached as terminal)
  {
    const f = fixture(), request = f.github.request.bind(f.github);
    f.github.request = async (path, method, body) => {
      if (path.includes('/protection')) { const p = await request(path, method, body); return { ...p, required_status_checks: { ...p.required_status_checks, contexts: ['ci/legacy'] } }; }
      if (path.startsWith('/rules/branches/')) return [];
      if (path === `/commits/${head}/status?per_page=100&page=1`) { f.calls.push({ path, method: method ?? 'GET', body }); return { statuses: [{ context: 'ci/legacy', state: 'pending' }] }; }
      return request(path, method, body);
    };
    const obs1 = await f.github.observe(f.work);
    assert.deepEqual(obs1.checks.filter(c => c.name === 'ci/legacy'), [{ name: 'ci/legacy', result: 'pending', appId: 0, source: 'status' }]);
    await f.github.observe(f.work);
    const reads = (pattern: RegExp) => f.calls.filter(call => pattern.test(call.path)).length;
    assert.equal(reads(/\/status\?/), 2, 'a pending status is re-read on the next observation');
  }
  // 2. Gated on open and unmerged PRs (Finding 20)
  {
    const f = fixture(), request = f.github.request.bind(f.github);
    f.github.request = async (path, method, body) => {
      if (path.includes('/protection')) { const p = await request(path, method, body); return { ...p, required_status_checks: { ...p.required_status_checks, contexts: ['ci/legacy'] } }; }
      if (path.startsWith('/rules/branches/')) return [];
      if (path.startsWith('/pulls/') && !path.includes('/reviews') && !path.includes('/files')) {
        const pr = await request(path, method, body);
        return { ...pr, state: 'closed', merged: true };
      }
      if (path.startsWith(`/commits/${head}/status?`)) { f.calls.push({ path, method: method ?? 'GET', body }); return { statuses: [{ context: 'ci/legacy', state: 'success' }] }; }
      return request(path, method, body);
    };
    const obs = await f.github.observe(f.work);
    const reads = (pattern: RegExp) => f.calls.filter(call => pattern.test(call.path)).length;
    assert.equal(reads(/\/status\?/), 0, 'a closed or merged PR skips requiredStatuses reads');
    assert.equal(obs.checks.some(c => c.name === 'ci/legacy'), false);
  }
  // 3. Status read errors are not swallowed (Finding 23)
  {
    const f = fixture(), request = f.github.request.bind(f.github);
    f.github.request = async (path, method, body) => {
      if (path.includes('/protection')) { const p = await request(path, method, body); return { ...p, required_status_checks: { ...p.required_status_checks, contexts: ['ci/legacy'] } }; }
      if (path.startsWith('/rules/branches/')) return [];
      if (path.startsWith(`/commits/${head}/status?`)) throw new Error('GitHub status endpoint 502 Bad Gateway');
      return request(path, method, body);
    };
    await assert.rejects(f.github.observe(f.work), /GitHub status endpoint 502 Bad Gateway/, 'status read errors fail the observation rather than being swallowed');
  }
});
test('GitHub adapter retains retry history in deterministic check-run identity order', async () => {
  const f = fixture(), request = f.github.request.bind(f.github);
  f.github.request = async (path, method, body) => path.includes('/check-runs')
    ? { check_runs: [
      { id: 103, run_attempt: 2, name: 'test', status: 'completed', conclusion: 'success', app: { id: 15368 } },
      { id: 101, run_attempt: 1, name: 'test', status: 'completed', conclusion: 'failure', app: { id: 15368 } },
    ] }
    : request(path, method, body);
  assert.deepEqual((await f.github.observe(f.work)).checks.map(check => [check.id, check.result]), [[101, 'failure'], [103, 'success']]);
});
test('final verification refuses gate changes after the initial collection', async () => {
  const f = fixture(), request = f.github.request.bind(f.github); let reads = 0;
  f.github.request = async (path, method, body) => {
    const result = structuredClone(await request(path, method, body));
    if (path.includes('/check-runs') && ++reads > 1) result.check_runs[0].conclusion = 'failure';
    return result;
  };
  await assert.rejects(f.github.verify(f.work), /gates changed/);
});
test('App binding is mandatory even when a check with the correct name is required', async () => {
  const f = fixture(); f.protection(false); assert.equal(await f.github.protection(), false);
});
test('a base branch that still requires branches to be up to date is not verified protection', async () => {
  const f = fixture(); assert.equal(await f.github.protection(), true);
  f.requireUpToDate(true);
  assert.equal(await f.github.protection(), false, '`strict` must be off');
});
test('observing a merge preserves the tested pre-merge base candidate', async () => {
  const f = fixture(); f.pr.merged = true; f.pr.base.sha = 'c'.repeat(40);
  assert.equal((await f.github.observe(f.work)).candidate.baseSha, base);
});
test('check publisher updates its own existing check and includes actionable refusal', async () => {
  const f = fixture(); await f.github.publish(f.work);
  const call = f.calls.find(c => c.method === 'PATCH')!;
  assert.equal(call.path, '/check-runs/12'); assert.equal(call.body.conclusion, 'failure'); assert.equal(call.body.head_sha, head); assert.match(call.body.output.summary, /AC-1/);
});
test('publisher refuses a head or base that changed after evaluation', async () => {
  const f = fixture(); f.pr.head.sha = 'c'.repeat(40);
  await assert.rejects(f.github.publish(f.work), /changed/); assert.ok(f.calls.every(c => c.method === 'GET'));
});
test('pagination fetches every page instead of accepting an incomplete check inventory', async () => {
  const f = fixture(); let count = 0;
  f.github.request = async path => { count++; return { check_runs: path.includes('page=2') ? [{ id: 101 }] : Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) }; };
  const rows = await f.github.pages('/commits/sha/check-runs', 'check_runs'); assert.equal(rows.length, 101); assert.equal(count, 2);
});

test('a PR changing during evidence collection is retried, not accepted as one snapshot', async () => {
  const f = fixture(), request = f.github.request.bind(f.github);
  f.github.request = async (path, method, body) => {
    if (path.includes('/reviews')) f.pr.head.sha = 'c'.repeat(40);
    return request(path, method, body);
  };
  await assert.rejects(f.github.observe(f.work), /changed while collecting/);
});

test('publication rechecks ownership and work revision immediately before the write', async () => {
  const f = fixture(); let checked = false;
  await assert.rejects(f.github.publish(f.work, undefined, async () => { checked = true; throw new Error('Ownership superseded'); }), /superseded/);
  assert.equal(checked, true); assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('a previously approved PR cannot publish success after becoming draft or retargeting', async () => {
  for (const change of [{ draft: true }, { base: { sha: base, ref: 'other' } }, { state: 'closed' }]) {
    const f = fixture(); f.work.gates = []; Object.assign(f.pr, change);
    await assert.rejects(f.github.publish(f.work), /closed, draft, or retargeted/);
    assert.ok(f.calls.every(c => c.method === 'GET'));
  }
});

test('Codex dispatch checks candidate and job guard before posting and binds the provider response', async () => {
  const f = fixture(); f.work.policy.reviewProvider = 'codex'; const original = f.github.request;
  f.github.request = async (path, method, body: any) => method === 'POST' ? { id: 456, body: body.body, performed_via_github_app: { id: 1234 }, user: { type: 'Bot' }, created_at: new Date().toISOString() } : original(path, method, body);
  let checked = false;
  const request = await f.github.requestCodex(f.work, async () => { checked = true; });
  assert.equal(checked, true); assert.equal(request.commentId, 456); assert.equal(request.sha, head); assert.equal(request.baseSha, base);
  assert.match(request.body, /^@codex review\n/);
  await assert.rejects(f.github.requestCodex(f.work, async () => { throw Error('Lease lost'); }), /Lease lost/);
  f.pr.head.sha = 'd'.repeat(40); await assert.rejects(f.github.requestCodex(f.work, async () => {}), /changed/);
});

 test('merged Codex observations retain the authorized review base while open rebases require a new review', async () => {
  const f = fixture(); f.work.policy.reviewProvider = 'codex'; f.pr.user.id = 12345;
  const createdAt = '2026-01-01T00:00:00Z', completed = '2026-01-01T00:01:00Z';
  f.work.reviewRequest = { commentId: 12, sha: head, baseSha: base, policyRevision: 1, body: '@codex review', createdAt };
  const bot = { id: CODEX_USER_ID, type: 'Bot' };
  const trigger = { id: 12, body: '@codex review', user: { type: 'Bot' }, performed_via_github_app: { id: 1234 }, created_at: createdAt, updated_at: createdAt };
  const summary = { id: 13, user: bot, performed_via_github_app: { id: CODEX_APP_ID }, body: `<!-- codex-pull-request-review-summary -->\n| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="${completed}">${completed}</relative-time> | \`aaaaaaa\` | Manual request |`, updated_at: completed };
  const original = f.github.request;
  f.github.request = async (path, method, body) => {
    if (path.startsWith('/issues/comments/12/reactions')) return [{ id: 14, user: bot, content: '+1', created_at: '2026-01-01T00:01:01Z' }];
    if (path.startsWith('/issues/10/comments')) return [trigger, summary];
    if (path === '/issues/comments/12') return trigger;
    if (path === '/issues/comments/13') return summary;
    if (path === '/commits/aaaaaaa') return { sha: head };
    return original(path, method, body);
  };
  f.pr.merged = true; f.branch('c'.repeat(40));
  const merged = await f.github.observe(f.work);
  assert.equal(merged.candidate.baseSha, base); assert.equal(merged.agentReview?.approved, true);
  f.pr.merged = false;
  const rebased = await f.github.observe(f.work);
  assert.equal(rebased.candidate.baseSha, 'c'.repeat(40), 'an open candidate binds to the real base branch head'); assert.equal(rebased.agentReview?.approved, false);
 });

 test('native review tasks cannot silently lose GitHub reviewer enforcement after agent migration', async () => {
  const f = fixture(), original = f.github.request;
  f.github.request = async (path, method, body) => {
    const result = await original(path, method, body);
    if (path.includes('/protection')) result.required_pull_request_reviews.required_approving_review_count = 0;
    return result;
  };
  assert.equal((await f.github.observe(f.work)).protected, false);
  f.work.policy.reviewProvider = 'codex';
  assert.equal((await f.github.observe(f.work)).protected, true);
 });

test('unchanged check output avoids redundant writes while still guarding the snapshot', async () => {
  const f = fixture(); const original = f.github.request;
  let saved: any, writes = 0, guards = 0;
  f.github.request = async (path, method, body) => {
    if (path.includes('/check-runs?') && saved) return { check_runs: [{ ...saved, id: 77, app: { id: 1234 } }] };
    if ((method === 'POST' || method === 'PATCH') && path.startsWith('/check-runs')) { saved = structuredClone(body); writes++; return {}; }
    return original(path, method, body);
  };
  await f.github.publish(f.work, undefined, async () => { guards++; });
  await f.github.publish(f.work, undefined, async () => { guards++; });
  assert.equal(writes, 1); assert.equal(guards, 2);
  await f.github.publish(f.work, 'New refusal', async () => { guards++; });
  assert.equal(writes, 2);
});

test('draft and closed PRs expose actionable review waits without requesting provider evidence', async () => {
  for (const state of [{state:'open',draft:true}, {state:'closed',draft:false}]) {
    const f = fixture(); Object.assign(f.pr,state); f.work.policy.reviewProvider='codex';
    const observed = await f.github.observe(f.work);
    assert.equal(observed.prState,state.state); assert.equal(observed.draft,state.draft);
    assert.equal(observed.agentReview?.approved,false); assert.match(observed.agentReview!.reason,/mark it ready|reopen/);
    assert.ok(!f.calls.some(c=>c.path.includes('/comments')));
  }
});

const movedBase = 'c'.repeat(40), mergedHead = 'd'.repeat(40);

test('a head whose bound base is not the base branch tip refuses publication', async () => {
  const f = fixture(); f.work.candidate!.baseSha = movedBase;
  await assert.rejects(f.github.publish(f.work), /changed before check publication/);
});

const reviewerApp = { id: 'claude-reviewer', runtime: 'claude', appId: 55_001, botUserId: 55_002 };
const reviewerProfile = { name: 'claude-reviewer', runtime: 'claude', reviewerApp: 'claude-reviewer', timeoutSeconds: 1800 };
function agentFixture() {
  const f = fixture();
  f.github.config.reviewerApps = [reviewerApp];
  f.work.policy.reviewProvider = 'agent';
  f.work.policy.reviewerProfiles = [reviewerProfile];
  f.pr.user.id = 12_345;
  return f;
}

test('agent dispatch records the profile, identity and correlation marker for the exact candidate', async () => {
  const f = agentFixture(); const original = f.github.request;
  f.github.request = async (path, method, body: any) => method === 'POST'
    ? { id: 456, body: body.body, performed_via_github_app: { id: 1234 }, user: { type: 'Bot' }, created_at: new Date().toISOString() }
    : original(path, method, body);
  let checked = false;
  const request = await f.github.requestAgentReview(f.work, reviewerProfile, reviewerApp, async () => { checked = true; });
  assert.equal(checked, true); assert.equal(request.commentId, 456); assert.equal(request.provider, 'agent');
  assert.equal(request.profile, 'claude-reviewer'); assert.equal(request.reviewerApp, 'claude-reviewer');
  assert.equal(request.sha, head); assert.equal(request.baseSha, base); assert.equal(request.policyRevision, 1);
  assert.match(request.body, new RegExp(`graphyard-verdict:${request.marker} head:${head} verdict:approved`));
  assert.match(request.body, /reviewer-app:claude-reviewer/);
  await assert.rejects(f.github.requestAgentReview(f.work, reviewerProfile, reviewerApp, async () => { throw Error('Lease lost'); }), /Lease lost/);
  // The control-plane App, an unconfigured profile, a mismatched identity and the PR author all refuse.
  await assert.rejects(f.github.requestAgentReview(f.work, reviewerProfile, { ...reviewerApp, appId: 1234 }, async () => {}), /control-plane App/);
  await assert.rejects(f.github.requestAgentReview(f.work, { ...reviewerProfile, name: 'other' }, reviewerApp, async () => {}), /not configured on this policy/);
  await assert.rejects(f.github.requestAgentReview(f.work, { ...reviewerProfile, runtime: 'cursor' }, reviewerApp, async () => {}), /does not match its registered App identity/);
  f.pr.user.id = reviewerApp.botUserId;
  await assert.rejects(f.github.requestAgentReview(f.work, reviewerProfile, reviewerApp, async () => {}), /independent of the pull request author/);
  f.pr.user.id = 12_345; f.pr.head.sha = 'd'.repeat(40);
  await assert.rejects(f.github.requestAgentReview(f.work, reviewerProfile, reviewerApp, async () => {}), /changed/);
  f.work.policy.reviewProvider = 'codex';
  await assert.rejects(f.github.requestAgentReview(f.work, reviewerProfile, reviewerApp, async () => {}), /agent review policy required/);
});

test('agent dispatch refuses a candidate whose bound base is not the base branch tip', async () => {
  const f = agentFixture(); f.work.candidate!.baseSha = movedBase;
  await assert.rejects(f.github.requestAgentReview(f.work, reviewerProfile, reviewerApp, async () => {}), /changed before review dispatch/);
  assert.ok(f.calls.every(call => call.method === 'GET'), 'nothing is posted');
});

test('agent observation resolves the registered identity and never requires native approval', async () => {
  const f = agentFixture();
  const waiting = await f.github.observe(f.work);
  assert.equal(waiting.agentReview?.provider, 'agent'); assert.equal(waiting.agentReview?.approved, false);
  assert.equal(waiting.agentReview?.profile, 'claude-reviewer');
  assert.match(waiting.agentReview!.reason, /must dispatch a review to this profile/);
  // Agent review does not depend on GitHub's own required-approval configuration.
  const unprotected = agentFixture(); const original = unprotected.github.request;
  unprotected.github.request = async (path, method, body) => {
    const result = await original(path, method, body);
    if (path.includes('/protection')) result.required_pull_request_reviews.required_approving_review_count = 0;
    return result;
  };
  assert.equal((await unprotected.github.observe(unprotected.work)).protected, true);
  // An unregistered or control-plane App identity cannot be dispatched to at all.
  const unregistered = agentFixture(); unregistered.github.config.reviewerApps = [];
  assert.match((await unregistered.github.observe(unregistered.work)).agentReview!.reason, /is not registered with this control plane/);
  const selfReview = agentFixture(); selfReview.github.config.reviewerApps = [{ ...reviewerApp, appId: 1234 }];
  assert.match((await selfReview.github.observe(selfReview.work)).agentReview!.reason, /is not registered with this control plane/);
  // Once every profile is exhausted the observation says so instead of falling back.
  const exhausted = agentFixture();
  exhausted.work.candidate = { sha: head, baseSha: base, pr: 10, branch: 'graphyard/task', author: 'author' };
  exhausted.work.reviewFailovers = [{ profile: 'claude-reviewer', reviewerApp: 'claude-reviewer', runtime: 'claude', exhaustion: 'usage-limit', reason: 'quota', at: new Date().toISOString(), sha: head, baseSha: base, policyRevision: 1, requestCommentId: 5, nextProfile: null }];
  assert.match((await exhausted.github.observe(exhausted.work)).agentReview!.reason, /Every configured reviewer profile is exhausted/);
  // Draft and closed pull requests still wait without requesting provider evidence.
  for (const state of [{ state: 'open', draft: true }, { state: 'closed', draft: false }]) {
    const pending = agentFixture(); Object.assign(pending.pr, state);
    const observed = await pending.github.observe(pending.work);
    assert.equal(observed.agentReview?.approved, false);
    assert.match(observed.agentReview!.reason, /mark it ready|reopen/);
    assert.ok(!pending.calls.some(call => call.path.includes('/comments')));
  }
});

function enforcement(overrides: any = {}) {
  const now = '2026-09-17T05:00:00.000Z';
  return {
    repository: 'owner/repo', baseBranch: 'main', appId: 1234, now,
    protection: { required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: 1234 }, { context: 'test', app_id: 15368 }] },
      required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true },
      enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } },
    rulesets: [],
    pull: { number: 10, head: { sha: head }, base: { sha: base, ref: 'main' }, state: 'open', draft: false, merged: false, mergeable: true, mergeable_state: 'clean' },
    checkRuns: [{ name: CHECK_NAME, status: 'completed', conclusion: 'success', app: { id: 1234, slug: 'graphyard' }, pull_requests: [{ number: 10 }] },
      { name: 'test', status: 'completed', conclusion: 'success', app: { id: 15368 } }],
    work: { key: 'GY-1', revision: 7, stage: 'merge', policyRevision: 1, policy: { review: true, reviewProvider: 'codex', checks: ['test'] },
      submission: { pr: 10, epoch: 1 }, candidate: { pr: 10, sha: head, baseSha: base, branch: 'topic', author: 'worker' }, observation: { at: now },
      gates: [{ name: 'acceptance', passed: true, reasons: [] }, { name: 'merge', passed: true, reasons: [] }] },
    ...overrides,
  };
}

test('enforcement inspection permits only a fully proven candidate under App-bound protection', () => {
  const permitted = evaluateEnforcement(enforcement());
  assert.equal(permitted.verdict, 'permitted');
  assert.deepEqual(permitted.refusals, []);
  assert.equal(permitted.app.publishedCheck.appId, 1234);

  const unproven = evaluateEnforcement(enforcement({ work: { ...enforcement().work, stage: 'acceptance', gates: [{ name: 'acceptance', passed: false, reasons: ['AC-1: manual:github-enforcement needs trusted passing evidence'] }] } }));
  assert.equal(unproven.verdict, 'refused');
  assert.match(unproven.refusals.join('\n'), /acceptance gate: AC-1/);

  const unlinked = evaluateEnforcement(enforcement({ checkRuns: [{ name: 'test', status: 'completed', conclusion: 'success', app: { id: 15368 } }] }));
  assert.equal(unlinked.verdict, 'refused');
  assert.match(unlinked.refusals.join('\n'), new RegExp(`${CHECK_NAME} has not been published`));
});

test('enforcement inspection refuses unbound, unenforced or foreign-App protection', () => {
  const cases: [any, RegExp][] = [
    [{ required_status_checks: { strict: false, checks: [{ context: 'test', app_id: 15368 }] } }, /do not include/],
    [{ required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: 999 }] } }, /bound to App 999/],
    // Strict mode is the refusal now: the merge queue lands tips that are deliberately behind the base branch.
    [{ required_status_checks: { strict: true, checks: [{ context: CHECK_NAME, app_id: 1234 }] } }, /still required to be up to date/],
    [{ enforce_admins: { enabled: false } }, /administrators/],
    [{ allow_force_pushes: { enabled: true } }, /Force pushes/],
    [{ allow_deletions: { enabled: true } }, /Deletion/],
  ];
  for (const [override, expected] of cases) {
    const report = evaluateEnforcement(enforcement({ protection: { ...enforcement().protection, ...override } }));
    assert.equal(report.verdict, 'refused');
    assert.match(report.refusals.join('\n'), expected);
  }
  assert.equal(evaluateEnforcement(enforcement({ protection: null })).verdict, 'refused');

  // A check published by another App with the right name cannot satisfy the gate.
  const foreign = evaluateEnforcement(enforcement({ checkRuns: [{ name: CHECK_NAME, status: 'completed', conclusion: 'success', app: { id: 999, slug: 'other' } }, { name: 'test', status: 'completed', conclusion: 'success', app: { id: 15368 } }] }));
  assert.match(foreign.refusals.join('\n'), /published by App 999/);
});

test('enforcement inspection reports the native-review migration boundary and commit-scoped inheritance', () => {
  const native = enforcement();
  native.work.policy.reviewProvider = 'github';
  native.protection.required_pull_request_reviews = { required_approving_review_count: 0, dismiss_stale_reviews: true, require_last_push_approval: false };
  const report = evaluateEnforcement(native);
  assert.equal(report.protection.nativeReviewRequired, true);
  assert.equal(report.verdict, 'refused');
  assert.match(report.refusals.join('\n'), /native GitHub review/);

  const inherited = evaluateEnforcement(enforcement({ checkRuns: [{ name: CHECK_NAME, status: 'completed', conclusion: 'success', app: { id: 1234 }, pull_requests: [{ number: 11 }] }, { name: 'test', status: 'completed', conclusion: 'success', app: { id: 15368 } }] }));
  assert.equal(inherited.verdict, 'permitted');
  assert.match(inherited.notes.join('\n'), /commit-scoped and can be inherited/);
  assert.match(evaluateEnforcement(enforcement({ rulesets: null })).notes.join('\n'), /rulesets could not be read/);
});

test('enforcement inspection binds the exact candidate and refuses stale or blocking observations', () => {
  const mismatches: [any, RegExp][] = [
    [{ pull: { ...enforcement().pull, number: 11 } }, /inspected PR 11/],
    [{ pull: { ...enforcement().pull, head: { sha: 'c'.repeat(40) } } }, /does not match candidate head/],
    [{ pull: { ...enforcement().pull, base: { sha: 'd'.repeat(40), ref: 'main' } } }, /does not match candidate base/],
    [{ pull: { ...enforcement().pull, base: { sha: base, ref: 'release\/v1' } } }, /not the managed base branch/],
    [{ pull: { ...enforcement().pull, mergeable_state: 'blocked' } }, /blocking merge state blocked/],
    [{ work: { ...enforcement().work, observation: { at: '2026-09-17T04:57:59.999Z' } } }, /older than two minutes/],
  ];
  for (const [override, expected] of mismatches) {
    const report = evaluateEnforcement(enforcement(override));
    assert.equal(report.verdict, 'refused');
    assert.match(report.refusals.join('\n'), expected);
  }
});

test('enforcement inspection selects the dedicated App run before a newer same-name foreign run', () => {
  const report = evaluateEnforcement(enforcement({ checkRuns: [
    { name: CHECK_NAME, started_at: '2026-09-17T05:01:00Z', status: 'completed', conclusion: 'failure', app: { id: 999, slug: 'foreign' } },
    { name: CHECK_NAME, started_at: '2026-09-17T05:00:00Z', status: 'completed', conclusion: 'success', app: { id: 1234, slug: 'graphyard' }, pull_requests: [{ number: 10 }] },
    { name: 'test', status: 'completed', conclusion: 'success', app: { id: 15368 } },
  ] }));
  assert.equal(report.verdict, 'permitted');
  assert.equal(report.app.publishedCheck.appId, 1234);
});

test('enforcement inspection refuses snapshots that change during collection', () => {
  const initial = enforcement();
  const changes: [any, RegExp][] = [
    [{ work: { ...initial.work, revision: 8 } }, /work revision changed/],
    [{ work: { ...initial.work, candidate: { ...initial.work.candidate, sha: 'c'.repeat(40) } } }, /candidate head changed/],
    [{ work: { ...initial.work, candidate: { ...initial.work.candidate, baseSha: 'd'.repeat(40) } } }, /candidate base changed/],
    [{ pull: { ...initial.pull, head: { sha: 'c'.repeat(40) } } }, /pull request head changed/],
    [{ pull: { ...initial.pull, base: { ...initial.pull.base, sha: 'd'.repeat(40) } } }, /pull request base changed/],
    [{ pull: { ...initial.pull, base: { ...initial.pull.base, ref: 'release' } } }, /pull request base ref changed/],
    [{ pull: { ...initial.pull, state: 'closed' } }, /pull request state changed/],
    [{ pull: { ...initial.pull, draft: true } }, /pull request draft changed/],
    [{ pull: { ...initial.pull, merged: true } }, /pull request merged changed/],
    [{ pull: { ...initial.pull, mergeable: false } }, /pull request mergeable changed/],
    [{ pull: { ...initial.pull, mergeable_state: 'blocked' } }, /pull request mergeable state changed/],
    [{ protection: { ...initial.protection, enforce_admins: { enabled: false } } }, /branch protection changed/],
    [{ checkRuns: [{ ...initial.checkRuns[0], conclusion: 'failure' }] }, /check state changed/],
    [{ checkRuns: [{ ...initial.checkRuns[0], id: 2, started_at: '2026-09-17T05:01:00Z', status: 'in_progress', conclusion: null }, ...initial.checkRuns] }, /check state changed/],
  ];
  for (const [change, expected] of changes) {
    const report = evaluateEnforcement({ ...initial, recheck: { work: initial.work, pull: initial.pull,
      protection: initial.protection, checkRuns: initial.checkRuns, ...change } });
    assert.equal(report.verdict, 'refused');
    assert.equal(report.revalidated, false);
    assert.match(report.refusals.join('\n'), expected);
  }
});

test('enforcement inspection refuses when any protected required context is unmet', () => {
  const green = { name: CHECK_NAME, status: 'completed', conclusion: 'success', app: { id: 1234, slug: 'graphyard' }, pull_requests: [{ number: 10 }] };
  const cases: [any[], RegExp][] = [
    [[green], /required check test has not been published/],
    [[green, { name: 'test', status: 'in_progress', conclusion: null, app: { id: 15368 } }], /required check test reports in_progress/],
    [[green, { name: 'test', status: 'completed', conclusion: 'failure', app: { id: 15368 } }], /required check test reports failure/],
    [[green, { name: 'test', status: 'completed', conclusion: 'success', app: { id: 999 } }], /required check test was published by App 999 rather than the required App 15368/],
  ];
  for (const [checkRuns, expected] of cases) {
    const report = evaluateEnforcement(enforcement({ checkRuns }));
    assert.equal(report.verdict, 'refused');
    assert.match(report.refusals.join('\n'), expected);
  }
  assert.deepEqual(evaluateEnforcement(enforcement()).requiredChecks.contexts, [CHECK_NAME, 'test']);
});

test('enforcement inspection revalidates every protected required context, not only the Graphyard check', () => {
  const initial = enforcement();
  // The Graphyard check is untouched; another required context turns pending after the pull was read.
  const turned = [initial.checkRuns[0], { name: 'test', status: 'in_progress', conclusion: null, app: { id: 15368 } }];
  const report = evaluateEnforcement({ ...initial, recheck: { work: initial.work, pull: initial.pull, protection: initial.protection, checkRuns: turned } });
  assert.equal(report.verdict, 'refused');
  assert.equal(report.revalidated, false);
  assert.match(report.refusals.join('\n'), /recheck: test check state changed during inspection/);
  assert.doesNotMatch(report.refusals.join('\n'), new RegExp(`recheck: ${CHECK_NAME} check state changed`));
});

test('the enforcement CLI judges observation freshness by server time read after the final re-reads', async () => {
  const { writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path'); const { spawnSync } = await import('node:child_process');
  const dir = await temporaryDirectory('enforcement');
  try {
    const started = '2026-09-17T05:00:00.000Z', finished = '2026-09-17T05:02:30.000Z';
    const work = { key: 'GY-1', revision: 7, stage: 'merge', policyRevision: 1, policy: { review: true, reviewProvider: 'codex', checks: ['test'] },
      submission: { pr: 10, epoch: 1 }, candidate: { pr: 10, sha: head, baseSha: base, branch: 'topic', author: 'worker' },
      observation: { at: started }, gates: [{ name: 'acceptance', passed: true, reasons: [] }, { name: 'merge', passed: true, reasons: [] }] };
    const pull = { number: 10, head: { sha: head }, base: { sha: base, ref: 'main' }, state: 'open', draft: false, merged: false, mergeable: true, mergeable_state: 'clean' };
    const protection = { required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: 1234 }, { context: 'test', app_id: 15368 }] },
      required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true },
      enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
    const runs = [{ name: CHECK_NAME, status: 'completed', conclusion: 'success', app: { id: 1234, slug: 'graphyard' }, pull_requests: [{ number: 10 }] },
      { name: 'test', status: 'completed', conclusion: 'success', app: { id: 15368 } }];
    const reads = join(dir, 'server-reads');
    // The stub advances server time only after the last collection call, so a report that
    // still trusted the pre-collection timestamp would call this observation fresh.
    await writeFile(join(dir, 'cli.cjs'), 'const fs=require("node:fs");\n'
      + 'if (process.argv[3]) { console.log(' + JSON.stringify(JSON.stringify(work)) + '); process.exit(0); }\n'
      + 'const prior = fs.existsSync(' + JSON.stringify(reads) + ') ? fs.readFileSync(' + JSON.stringify(reads) + ', "utf8").length : 0;\n'
      + 'fs.appendFileSync(' + JSON.stringify(reads) + ', "r");\n'
      + 'console.log(JSON.stringify({ repository: "owner/repo", baseBranch: "main", githubAppId: 1234, now: prior ? ' + JSON.stringify(finished) + ' : ' + JSON.stringify(started) + ' }));\n');
    await writeFile(join(dir, 'gh'), '#!' + process.execPath + '\n'
      + 'const args = process.argv.slice(2), path = args[args.length - 1];\n'
      + 'const runs = ' + JSON.stringify(runs) + ';\n'
      + 'const body = path.includes("/pulls/") ? ' + JSON.stringify(pull) + '\n'
      + '  : path.includes("/protection") ? ' + JSON.stringify(protection) + '\n'
      + '  : path.includes("/rulesets") ? []\n'
      + '  : path.includes("/check-runs") ? (args.includes("--slurp") ? [{ check_runs: runs }] : { check_runs: runs })\n'
      + '  : null;\n'
      + 'console.log(JSON.stringify(body));\n', { mode: 0o700 });
    const result = spawnSync(process.execPath, ['scripts/verify-enforcement.mjs', 'GY-1', '10'],
      { encoding: 'utf8', env: { ...process.env, PATH: dir + ':' + process.env.PATH, GRAPHYARD_CLI: join(dir, 'cli.cjs') } });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.observation.serverNow, finished);
    assert.equal(report.observation.fresh, false);
    assert.equal(report.revalidated, true);
    // Everything else about this candidate permits the merge: only the elapsed collection refuses it.
    assert.deepEqual(report.refusals, ['observation: Graphyard observation is missing, future-dated, or older than two minutes']);
    assert.equal(report.verdict, 'refused');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('observation compares every out-of-scope file with the bound base by blob identity and leaves planned files uncompared', async () => {
  const f = fixture();
  const kept = '4'.repeat(40), changed = 'c'.repeat(40), moved = '3'.repeat(40);
  f.files([
    { filename: 'src/claims.ts', status: 'modified', sha: 'a1'.repeat(20), additions: 3, deletions: 1, patch: '@@' },
    { filename: 'src/quarantine.ts', status: 'modified', sha: changed, additions: 0, deletions: 20, patch: '@@' },
    { filename: 'src/reviewer.ts', status: 'removed', sha: 'dead'.repeat(10), additions: 0, deletions: 40, patch: '@@' },
    { filename: 'src/landed.ts', status: 'modified', sha: kept, additions: 2, deletions: 2, patch: '@@' },
    { filename: 'src/brand-new.ts', status: 'added', sha: 'e'.repeat(40), additions: 9, deletions: 0, patch: '@@' },
    { filename: 'web/moved.png', status: 'renamed', previous_filename: 'web/logo.png', sha: moved, additions: 0, deletions: 0 },
  ]);
  f.baseBlobs({ [`${base}:src/quarantine.ts`]: 'b'.repeat(40), [`${base}:src/reviewer.ts`]: 'b'.repeat(40), [`${base}:src/landed.ts`]: kept, [`${base}:web/logo.png`]: moved, [`${base}:src/claims.ts`]: 'never-read' });
  const observation = await f.github.observe(f.work);
  assert.deepEqual(observation.files, ['src/claims.ts', 'src/quarantine.ts', 'src/reviewer.ts', 'src/landed.ts', 'src/brand-new.ts', 'web/moved.png']);
  assert.deepEqual(observation.scopeFiles, [
    { path: 'src/claims.ts', status: 'modified', sha: 'a1'.repeat(20), additions: 3, deletions: 1, binary: false },
    { path: 'src/quarantine.ts', status: 'modified', sha: changed, additions: 0, deletions: 20, binary: false, baseSha: 'b'.repeat(40) },
    { path: 'src/reviewer.ts', status: 'removed', sha: null, additions: 0, deletions: 40, binary: false, baseSha: 'b'.repeat(40) },
    { path: 'src/landed.ts', status: 'modified', sha: kept, additions: 2, deletions: 2, binary: false, baseSha: kept },
    { path: 'src/brand-new.ts', status: 'added', sha: 'e'.repeat(40), additions: 9, deletions: 0, binary: false, baseSha: null },
    { path: 'web/moved.png', status: 'renamed', previousPath: 'web/logo.png', sha: moved, additions: 0, deletions: 0, binary: true, baseSha: null, previousBaseSha: moved },
  ]);
  const lookups = f.calls.filter(call => call.path.startsWith('/contents/')).map(call => call.path);
  assert.ok(lookups.every(path => path.endsWith(`?ref=${base}`)), 'comparisons are made against the bound base commit');
  assert.ok(!lookups.some(path => path.includes('src%2Fclaims') || path.includes('src/claims')), 'a planned file is never looked up');
  assert.equal(await f.github.verify(f.work).then(() => true), true);
});

test('a missing blob at the bound base is a new file, and a provider failure other than absence is not', async () => {
  const f = fixture(), request = f.github.request.bind(f.github);
  assert.equal(await f.github.blobAt('src/none.ts', base), null);
  f.baseBlobs({ [`${base}:src/dir/with space.ts`]: 'b'.repeat(40) });
  assert.equal(await f.github.blobAt('src/dir/with space.ts', base), 'b'.repeat(40));
  assert.ok(f.calls.some(call => call.path === `/contents/src/dir/with%20space.ts?ref=${base}`), 'path segments are encoded individually');
  // Blobs at a commit SHA never change, so the client memoizes them; this fixture rewrites the answer for the same commit.
  const forget = () => (f.github as any).blobs.clear();
  forget(); f.github.request = async (path, method, body) => { if (path.startsWith('/contents/')) throw new Refusal(`GitHub GET ${path} failed (503)`, 502); return request(path, method, body); };
  await assert.rejects(f.github.blobAt('src/none.ts', base), /503/);
  forget(); f.github.request = async () => ({ type: 'file', sha: 'not-a-sha' });
  await assert.rejects(f.github.blobAt('src/none.ts', base), /readable blob/);
  f.github.request = async () => [{ type: 'file', sha: 'b'.repeat(40) }];
  assert.equal(await f.github.blobAt('src', base), null, 'a directory is not a file the guard compares');
});

test('out-of-scope lookups beyond the budget stay uncompared so the guard refuses rather than passes them', async () => {
  const f = fixture();
  const many = Array.from({ length: scopeLookupBudget + 3 }, (_, i) => ({ filename: `src/generated/${i}.ts`, status: 'modified', sha: 'a'.repeat(40), additions: 1, deletions: 1, patch: '@@' }));
  f.files(many);
  const observation = await f.github.observe(f.work);
  assert.equal(observation.scopeFiles!.filter(file => file.baseSha === undefined).length, 3);
  assert.equal(f.calls.filter(call => call.path.startsWith('/contents/')).length, scopeLookupBudget);
});

// GY-57: the base tip comes from the branch ref; what Graphyard's merge produced is recorded with the base refresh.
test('unit:queue-real-base-tip — the observed base tip and tree come from refs/heads/<base>, never from the pull request\'s cached base', async () => {
  const f = fixture(); const moved = 'c'.repeat(40);
  f.branch(moved); // GitHub's pr.base.sha still says `base`: it is refreshed only when the pull request is recomputed.
  const observation = await f.github.observe(f.work);
  assert.equal(f.pr.base.sha, base, 'the fixture leaves the cached pull-request base behind on purpose');
  assert.equal(observation.baseTip, moved, 'the base tip is the ref head');
  assert.equal(observation.baseTree, `f${'c'.repeat(39)}`, 'and its tree is read from that commit');
  assert.equal(observation.candidate.baseSha, moved, 'an unpublished candidate binds to the ref head, not the cached base');
  assert.ok(f.calls.some(call => call.path === '/git/ref/heads/main'), 'the branch ref is read');
  assert.equal(observation.baseTipContained, true, 'GitHub compares the head with the branch head');
  f.compare('diverged');
  // Real commits never change ancestry, so the client memoizes it; this fixture rewrites the answer for the same pair.
  (f.github as any).ancestry.clear();
  assert.equal((await f.github.observe(f.work)).baseTipContained, false, 'a head behind the branch does not contain its tip');
});

test('unit:queue-real-base-tip — a review is never requested for a head that does not contain the base tip and does not merge cleanly (GY-191)', async () => {
  const f = fixture(); f.work.policy.reviewProvider = 'codex';
  f.work.observation = { candidate: { ...f.work.candidate! }, baseTip: 'c'.repeat(40), baseTipContained: false } as any;
  await assert.rejects(f.github.requestCodex(f.work, async () => {}), /does not contain the base branch tip cccccccccccc/);
  assert.ok(f.calls.every(call => call.method === 'GET'), 'nothing is posted');
});

/** A candidate whose base failure the base branch has since repaired (GY-528): the coordinator asked for the repaired base to be merged in. */
function requestedRefresh(f: ReturnType<typeof fixture>) {
  f.branch(movedBase);
  f.work.observation = { candidate: { ...f.work.candidate! }, baseTip: movedBase, baseTipContained: false, merged: false, prState: 'open', draft: false } as any;
  f.work.baseRefreshRequest = { head, base: movedBase, policyRevision: 1, by: 'master', at: '2026-09-17T00:00:00.000Z', reason: 'the base failure is repaired' };
  return f;
}

test('unit:queue-real-base-tip — a requested base refresh records the merge\'s parents, author and the files the base changed, from GitHub\'s account of the commit', async () => {
  const f = requestedRefresh(fixture());
  f.mutations['/merges'] = () => ({ sha: mergedHead });
  f.commit(mergedHead, { parents: [{ sha: head }, { sha: movedBase }], author: { login: 'graphyard-owner-repo[bot]', type: 'Bot' } });
  f.compare('ahead', [{ filename: 'src/other.ts' }, { filename: 'docs/renamed.md', previous_filename: 'docs/old.md' }]);
  const refresh = await f.github.refreshCandidateBase(f.work);
  assert.deepEqual([refresh.head, refresh.base, refresh.trigger, refresh.conflict], [mergedHead, movedBase, 'base failure repaired', null]);
  assert.deepEqual(refresh.merge, { from: head, parents: [head, movedBase], author: 'graphyard-owner-repo[bot]', authoredByApp: true, conflicts: false, baseChanges: ['src/other.ts', 'docs/renamed.md', 'docs/old.md'] });
  assert.deepEqual(f.calls.find(call => call.path === '/merges')!.body.base, 'graphyard/task', 'the repaired base is merged into the candidate branch');
  assert.ok(f.calls.some(call => call.path.startsWith(`/compare/${base}...${movedBase}`)), 'the changes are listed between the bound base and the base it was merged onto');
  f.commit(mergedHead, { parents: [{ sha: head }, { sha: movedBase }], author: { login: 'worker', type: 'User' } });
  assert.equal((await f.github.refreshCandidateBase(f.work)).merge!.authoredByApp, false, 'a merge GitHub attributes to anyone else is recorded as such');
  f.commit(mergedHead, { parents: [{ sha: head }, { sha: movedBase }], author: null, commit: { tree: { sha: 't'.repeat(40) }, author: { email: '9001+graphyard-owner-repo[bot]@users.noreply.github.com' } } });
  assert.equal((await f.github.refreshCandidateBase(f.work)).merge!.authoredByApp, true, 'an unresolved author is recognised by the App bot\'s noreply address');
  f.mutations['/merges'] = () => null;
  const unchanged = await f.github.refreshCandidateBase(f.work);
  assert.deepEqual([unchanged.head, unchanged.merge], [head, null], 'a head that already contains its base produced no merge and carries nothing');
});

test('unit:queue-real-base-tip — a change list at GitHub\'s compare cap is recorded as incomplete, so nothing can be carried over a diff the API may have truncated', async () => {
  const f = requestedRefresh(fixture());
  f.mutations['/merges'] = () => ({ sha: mergedHead });
  f.commit(mergedHead, { parents: [{ sha: head }, { sha: movedBase }], author: { login: 'graphyard-owner-repo[bot]', type: 'Bot' } });
  const changed = (count: number) => Array.from({ length: count }, (_, i) => ({ filename: `src/generated/file-${i}.ts` }));
  f.compare('ahead', changed(compareFileCap - 1));
  assert.equal((await f.github.refreshCandidateBase(f.work)).merge!.baseChanges!.length, compareFileCap - 1, 'a list short of the cap is complete');
  f.compare('ahead', changed(compareFileCap));
  assert.equal((await f.github.refreshCandidateBase(f.work)).merge!.baseChanges, null, 'a list that reaches the cap cannot be told from a truncated one');
  f.compare('ahead', changed(compareFileCap + 50));
  assert.equal((await f.github.refreshCandidateBase(f.work)).merge!.baseChanges, null, 'GitHub returns only the first page of files, so a longer diff looks exactly like one at the cap');
  assert.ok(f.calls.filter(call => call.path.startsWith(`/compare/${base}...${movedBase}`)).every(call => !/[?&]page=(?!1(&|$))/.test(call.path)), 'no later page is requested: it would never extend the file list');
  f.compare('ahead', changed(3));
  f.calls.length = 0;
  const sync = (await f.github.refreshCandidateBase(f.work)).merge!;
  assert.equal(sync.baseChanges!.length, 3);
  assert.equal(f.calls.filter(call => call.path.startsWith(`/compare/${base}...${movedBase}`)).length, 1, 'the comparison is read once');
});

// GY-1329: GitHub answers 403 to a rerun of a workflow run whose other jobs are still running, and
// that 403 was filed as a missing App permission. An owed rerun now waits for the run to complete.
const { checkRerunStatus, checkRerunVisibilityMs, owedCheckReruns, reconcileCheckReruns } = mergeQueue;
const owedRerunAfter: typeof mergeQueue.owedRerunAfter = (...args) => { assert.equal(typeof mergeQueue.owedRerunAfter, 'function', 'owedRerunAfter records an owed rerun\'s outcome'); return mergeQueue.owedRerunAfter(...args); };
function rerunFixture() {
  const github = new GitHub({ repository: 'owner/repo', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used-in-adapter-test' });
  const calls: { path: string; method: string }[] = [];
  let status = 'in_progress';
  github.request = async (path, method = 'GET') => {
    calls.push({ path, method });
    if (path === '/actions/jobs/77') return { id: 77, run_id: 500, run_attempt: 1 };
    if (path === '/actions/runs/500') return { id: 500, status, conclusion: status === 'completed' ? 'failure' : null, run_attempt: 1 };
    if (path === '/actions/runs/500/rerun-failed-jobs' && method === 'POST') return null;
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  const sha = 'd'.repeat(40);
  const work = (checkReruns: CheckRerun[]) => ({ key: 'GY-1329', policy: { review: true, checks: ['test'] }, candidate: { sha, baseSha: base, pr: 10 }, checkReruns,
    observation: { candidate: { sha, baseSha: base, pr: 10 }, checks: [{ name: 'test', result: 'failure', appId: 15368, id: 77 }], merged: false } }) as unknown as Work;
  return { github, calls, sha, work, posts: () => calls.filter(call => call.method === 'POST').length, status: (next: string) => { status = next; } };
}
test('unit:rerun-owed-holds-while-run-in-progress — an owed rerun whose workflow run is unfinished is not asked of GitHub; it stays owed and waiting, and is requested once the run completes', async () => {
  const f = rerunFixture();
  const t0 = Date.parse('2026-10-05T20:00:00Z');
  let [owed] = reconcileCheckReruns(f.work([]), [15368], 1, new Date(t0)).reruns;
  assert.equal(owed.state, 'owed');

  // The failed test job's workflow run is still running other jobs: no POST, a wait.
  const held = await f.github.rerunFailedJobs(77, { completedOnly: true });
  assert.deepEqual(held, { runId: 500, attempt: 1, waiting: 'in_progress' });
  assert.equal(f.posts(), 0, 'rerun-failed-jobs is not POSTed while the run is unfinished');
  owed = owedRerunAfter(owed, { state: 'waiting', runId: 500, attempt: 1, status: 'in_progress' }, new Date(t0 + 60_000).toISOString());
  assert.equal(owed.state, 'owed', 'still owed');
  assert.equal(owed.resolvedAt, undefined, 'not resolved');
  assert.equal(owed.detail, undefined, 'no refusal, permission or otherwise, is recorded');
  assert.deepEqual(owed.waiting, { status: 'in_progress', at: new Date(t0 + 60_000).toISOString() });
  assert.match(checkRerunStatus(f.work([owed]), 'test'), /one rerun of its failed jobs is owed, once its workflow run 500 completes \(now in progress\)/);

  // Read again each observation, it keeps holding past the visibility bound, still owed.
  const later = t0 + 2 * checkRerunVisibilityMs;
  owed = owedRerunAfter(owed, { state: 'waiting', runId: 500, attempt: 1, status: 'in_progress' }, new Date(later - 60_000).toISOString());
  assert.equal(owed.waiting!.at, new Date(t0 + 60_000).toISOString(), 'an unchanged wait keeps when it began');
  const reconciled = reconcileCheckReruns(f.work([owed]), [15368], 1, new Date(later));
  assert.deepEqual(reconciled.transitions, [], 'a wait read within the bound neither expires nor adds a rerun');
  assert.deepEqual(owedCheckReruns(f.work(reconciled.reruns), [15368]).map(entry => entry.state), ['owed'], 'GitHub is asked again on the next observation');
  // A wait no longer read lapses as an owed rerun always did.
  assert.equal(reconcileCheckReruns(f.work([owed]), [15368], 1, new Date(later - 60_000 + checkRerunVisibilityMs)).reruns[0].state, 'expired');

  // The run completes: the rerun is POSTed and recorded as requested, timed from the request.
  f.status('completed');
  const requested = await f.github.rerunFailedJobs(77, { completedOnly: true });
  assert.deepEqual(requested, { runId: 500, attempt: 1 });
  assert.equal(f.posts(), 1);
  const at = new Date(later).toISOString();
  const after = owedRerunAfter(owed, { state: 'requested', runId: 500, attempt: 1 }, at);
  assert.deepEqual(after, { sha: f.sha, check: 'test', failedRunId: 77, state: 'requested', at, runId: 500, attempt: 1 });
});
test('unit:rerun-requested-when-run-completed — an owed rerun whose workflow run completed is POSTed and recorded requested with its run and attempt, as before', async () => {
  const f = rerunFixture();
  f.status('completed');
  const t0 = new Date('2026-10-05T21:00:00Z');
  const [owed] = reconcileCheckReruns(f.work([]), [15368], 1, t0).reruns;
  const requested = await f.github.rerunFailedJobs(77, { completedOnly: true });
  assert.deepEqual(requested, { runId: 500, attempt: 1 });
  assert.deepEqual(f.calls.map(call => `${call.method} ${call.path}`), ['GET /actions/jobs/77', 'GET /actions/runs/500', 'POST /actions/runs/500/rerun-failed-jobs']);
  assert.deepEqual(owedRerunAfter(owed, { state: 'requested', ...requested }, new Date(t0.getTime() + 1000).toISOString()),
    { sha: f.sha, check: 'test', failedRunId: 77, state: 'requested', at: t0.toISOString(), runId: 500, attempt: 1 });
  // The probe paths' reruns, asked of a run they already read, POST without the extra read.
  f.calls.length = 0;
  assert.deepEqual(await f.github.rerunFailedJobs(77), { runId: 500, attempt: 1 });
  assert.deepEqual(f.calls.map(call => `${call.method} ${call.path}`), ['GET /actions/jobs/77', 'POST /actions/runs/500/rerun-failed-jobs']);
  // A refusal still resolves the rerun at once.
  const refused = owedRerunAfter(owed, { state: 'refused', detail: 'no' }, t0.toISOString());
  assert.deepEqual([refused.state, refused.detail, refused.resolvedAt], ['refused', 'no', t0.toISOString()]);
});
test('unit:github-403-keeps-github-body — a 403 with no missing permission in the preflight carries GitHub\'s own answer and the preflight reading, never a guessed shortfall', async () => {
  const github = new GitHub({ repository: 'owner/repo', base: 'main', appId: 1234, installationId: 161493384, privateKey: 'not-used-in-adapter-test' });
  const refuse = (body: string) => (github as any).refusal(new Response(body, { status: 403 }), 'POST /repos/owner/repo/actions/runs/500/rerun-failed-jobs') as Promise<Error>;
  const report = { app: 'graphyard-owner-repo', installationUrl: 'https://github.com/settings/installations/161493384', observedAt: '2026-10-05T20:01:00.000Z', verifiedAt: '2026-10-05T20:01:00.000Z', error: null, suspended: false, missing: [] };
  Object.assign(github, { preflightState: report });
  const refused = await refuse(JSON.stringify({ message: 'This workflow run is not completed', documentation_url: 'https://docs.github.com/rest' }));
  assert.equal(refused.message, 'GitHub POST /repos/owner/repo/actions/runs/500/rerun-failed-jobs failed (403): GitHub said "This workflow run is not completed"; the App permission preflight at 2026-10-05T20:01:00.000Z found no missing permission');
  assert.doesNotMatch(refused.message, /lacks a permission|update-permissions/);
  // A body that is not JSON is carried as GitHub sent it; an empty one says so.
  assert.match((await refuse('Forbidden by policy\n')).message, /GitHub said "Forbidden by policy"; the App permission preflight/);
  assert.match((await refuse('')).message, /\(403\): GitHub gave no reason; the App permission preflight at 2026-10-05T20:01:00.000Z found no missing permission$/);
  // An unreadable installation is the preflight's reading, not a shortfall.
  Object.assign(github, { preflightState: { ...report, verifiedAt: null, error: 'GitHub GET /app/installations failed (502)' } });
  assert.match((await refuse('{"message":"Resource not accessible by integration"}')).message, /GitHub said "Resource not accessible by integration"; the App permission preflight at 2026-10-05T20:01:00.000Z could not read the installation: GitHub GET \/app\/installations failed \(502\)$/);
  Object.assign(github, { preflightState: null });
  assert.match((await refuse('{"message":"Nope"}')).message, /GitHub said "Nope"; no App permission preflight has run yet$/);
  // A shortfall the preflight did find is still named.
  Object.assign(github, { preflightState: { ...report, missing: [{ permission: 'actions', required: 'write', granted: 'read', features: ['check-rerun'], reasons: ['rerun failed workflow jobs'] }] } });
  assert.match((await refuse('{"message":"Resource not accessible by integration"}')).message, /lacks Actions: write/);
});
