import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_APP_ID, CODEX_USER_ID } from '../src/codex-review.js';
import { GitHub, CHECK_NAME } from '../src/github.js';
import type { Work } from '../src/model.js';
const head = 'a'.repeat(40), base = 'b'.repeat(40);
function fixture() {
  const calls: { path: string; method: string; body: any }[] = [];
  const pr: any = { number: 10, head: { sha: head, ref: 'graphyard/task', repo: { full_name: 'owner/repo' } }, base: { sha: base, ref: 'main', repo: { full_name: 'owner/repo' } }, user: { login: 'author' }, merged: false, mergeable: true, draft: false, state: 'open', merge_commit_sha: null };
  let reviews: any[] = [];
  let protectedBranch = true;
  const github = new GitHub({ repository: 'owner/repo', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used-in-adapter-test' });
  github.request = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (method !== 'GET') return { id: 12 };
    if (path === '/pulls/10') return structuredClone(pr);
    if (path.includes('/protection')) return { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: true, checks: [{ context: CHECK_NAME, app_id: protectedBranch ? 1234 : 999 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
    if (path.includes('/reviews')) return reviews;
    if (path.includes('/files')) return [{ filename: 'src/claims.ts' }];
    if (path.includes('check_name=')) return { check_runs: [{ id: 12, name: CHECK_NAME, app: { id: 1234 } }] };
    if (path.includes('/check-runs')) return { check_runs: [{ id: 9, name: 'test', status: 'completed', conclusion: 'success', app: { id: 15368 } }, { id: 12, name: CHECK_NAME, status: 'completed', conclusion: 'failure', app: { id: 1234 } }] };
    throw new Error(`Unexpected request ${path}`);
  };
  const work = { id: 'task-id', policy: { review: true, checks: ['test'] }, submission: { pr: 10, epoch: 1 }, candidate: { sha: head, baseSha: base, pr: 10 }, policyRevision: 1, revision: 3, gates: [{ name: 'acceptance', passed: false, reasons: ['AC-1 requires proof'] }], violations: [] } as unknown as Work;
  return { github, calls, pr, work, reviews: (r: any[]) => { reviews = r; }, protection: (p: boolean) => { protectedBranch = p; } };
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
  f.pr.merged = true; f.pr.base.sha = 'c'.repeat(40);
  const merged = await f.github.observe(f.work);
  assert.equal(merged.candidate.baseSha, base); assert.equal(merged.agentReview?.approved, true);
  f.pr.merged = false;
  const rebased = await f.github.observe(f.work);
  assert.equal(rebased.candidate.baseSha, f.pr.base.sha); assert.equal(rebased.agentReview?.approved, false);
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
