import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GitHub, GitHubPermissionRefusal} from '../src/github.js';
function client() {
  const github = new GitHub({ repository: 'fixture/repo', base: 'main', appId: 1, installationId: 2, privateKey: 'not-used' });
  Object.assign(github, { token: 'fixture-token', expires: Date.now() + 3600000 });
  return github;
}
test('conditional reads require a fresh provider response and isolate cached snapshots', async t => {
  const github = client(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: any) => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ sha: 'first' }), { headers: { etag: 'version-1' } });
    assert.equal(options.headers['If-None-Match'], 'version-1'); assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    if (calls === 2) return new Response(null, { status: 304 });
    if (calls === 3) return new Response('failure', { status: 503 });
    return new Response(JSON.stringify({ sha: 'second' }), { headers: { etag: 'version-2' } });
  });
  const first = await github.request('/pulls/1'); first.sha = 'caller mutation';
  assert.equal((await github.request('/pulls/1')).sha, 'first');
  await assert.rejects(github.request('/pulls/1'), /503/);
  assert.equal((await github.request('/pulls/1')).sha, 'second'); assert.equal(calls, 4);
});
test('rate-limit responses pause every endpoint and never serve stale cache as proof', async t => {
  const github = client(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ sha: 'first' }), { headers: { etag: 'v1' } });
    return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 600), 'retry-after': '120' } });
  });
  await github.request('/pulls/1');
  await assert.rejects(github.request('/pulls/1'), /403.*paused until/);
  await assert.rejects(github.request('/pulls/2'), /paused until/);
  assert.equal(calls, 2);
  assert.ok((github as any).blockedUntil >= Date.now() + 590000);
});
test('an exhausted budget pauses until its reset, never past it, however many refusals were in flight', async t => {
  const github = client(); const reset = Math.ceil(Date.now() / 1000) + 600;
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }));
  await Promise.allSettled(Array.from({ length: 8 }, (_, i) => github.request(`/pulls/${i}`)));
  assert.equal((github as any).blockedUntil, reset * 1000);
});
test('an unsolicited not-modified response cannot become evidence', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 304 }));
  await assert.rejects(client().request('/pulls/1'), /304/);
});

test('concurrent token refreshes share authentication and honor authentication backoff', async t => {
  const {generateKeyPairSync} = await import('node:crypto');
  const {privateKey} = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const github = new GitHub({ repository: 'fixture/repo', base: 'main', appId: 1, installationId: 2, privateKey: privateKey.export({type:'pkcs8',format:'pem'}).toString() });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    calls++; assert.match(String(url), /access_tokens$/);
    await new Promise(resolve => setTimeout(resolve, 10));
    return new Response('{}', { status: 429, headers: { 'retry-after': '120' } });
  });
  const results = await Promise.allSettled([1,2,3,4].map(n => github.request(`/pulls/${n}`)));
  assert.ok(results.every(r => r.status === 'rejected')); assert.equal(calls, 1);
  await assert.rejects(github.request('/pulls/5'), /paused/); assert.equal(calls, 1);
  assert.ok((github as any).blockedUntil >= Date.now() + 119000);
});

 test('review capability reads actual installation-token permissions and fails closed on refresh errors', async t => {
  const {generateKeyPairSync}=await import('node:crypto');const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const github=new GitHub({repository:'fixture/repo',base:'main',appId:1,installationId:2,privateKey:privateKey.export({type:'pkcs8',format:'pem'}).toString()});
  let permissions:any={pull_requests:'read',issues:'read',checks:'write'},failed=false,calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return failed?new Response('{}',{status:403}):new Response(JSON.stringify({token:'fixture',expires_at:new Date(Date.now()+3600000).toISOString(),permissions}))});
  assert.equal((await github.reviewPermissions()).pull_requests,'read');
  permissions={pull_requests:'write',issues:'read',checks:'write'};Object.assign(github,{expires:0});
  const result=await github.reviewPermissions();assert.equal(result.pull_requests,'write');result.pull_requests='spoof';assert.equal((await github.reviewPermissions()).pull_requests,'write');assert.equal(calls,2);
  failed=true;Object.assign(github,{expires:0});assert.deepEqual(await github.reviewPermissions(),{});assert.deepEqual(await github.reviewPermissions(),{});assert.equal(calls,3);
 });

 test('review capability verifies installation repository membership across pages and rejects unknown scope', async t => {
  const github=client();let mode='member',calls=0;
  t.mock.method(globalThis,'fetch',async(url:unknown)=>{
    calls++;assert.match(String(url),/\/installation\/repositories\?per_page=100&page=/);
    if(mode==='failure')return new Response('{}',{status:503});
    if(mode==='invalid')return new Response('{}');
    if(mode==='absent')return new Response(JSON.stringify({repositories:[{id:9,full_name:'other/repo'}]}));
    return new Response(JSON.stringify({repositories:String(url).endsWith('page=1')?Array.from({length:100},(_,i)=>({id:i+1,full_name:`other/repo-${i}`})):[{id:999,full_name:'FIXTURE/Repo'}]}));
  });
  assert.deepEqual(await github.reviewRepository(),{id:999,fullName:'FIXTURE/Repo'});assert.equal(calls,2);
  assert.deepEqual(await github.reviewRepository(),{id:999,fullName:'FIXTURE/Repo'});assert.equal(calls,2,'the identity is cached between status reads');
  // The fixture changes the installation's answer; clear the cache so each mode is read afresh.
  for(mode of ['absent','invalid','failure']){(github as any).repositoryIdentity=null;assert.equal(await github.reviewRepository(),null);}
 });

// integration:github-error-classification
test('a 403 without rate-limit signals is a permission refusal that carries GitHub\'s answer and never pauses the client', async t => {
  const github = client(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    calls++;
    if (String(url).endsWith('/merges')) return new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403 });
    return new Response(JSON.stringify({ number: 1 }));
  });
  await assert.rejects(github.request('/merges', 'POST', { base: 'x', head: 'y' }), (error: Error) => error instanceof GitHubPermissionRefusal && error.kind === 'permission'
    && /POST \/repos\/fixture\/repo\/merges failed \(403\) "Resource not accessible by integration": no App permission preflight has run yet$/.test(error.message));
  assert.equal((github as any).blockedUntil, 0, 'a permission refusal is not a rate limit');
  assert.equal((await github.request('/pulls/1')).number, 1, 'other requests continue immediately');
  assert.equal((github as any).preflightDueAt, 0, 'the refusal brings the permission preflight forward');
  assert.equal(calls, 2);
});
test('a 401 is a credential refusal, while a 403 with rate-limit headers or wording still pauses', async t => {
  const github = client(); let mode = 'unauthorized';
  t.mock.method(globalThis, 'fetch', async () => mode === 'unauthorized' ? new Response('{}', { status: 401 })
    : mode === 'worded' ? new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit' }), { status: 403 })
    : new Response('{}', { status: 403, headers: { 'retry-after': '90' } }));
  await assert.rejects(github.request('/pulls/1'), (error: Error) => error instanceof GitHubPermissionRefusal && error.kind === 'authentication' && /401/.test(error.message) && /GITHUB_APP_ID/.test(error.message));
  assert.equal((github as any).blockedUntil, 0);
  mode = 'worded';
  await assert.rejects(github.request('/pulls/1'), (error: Error) => !(error instanceof GitHubPermissionRefusal) && /rate limited/.test(error.message));
  assert.ok((github as any).blockedUntil >= Date.now() + 59_000);
  Object.assign(github, { blockedUntil: 0, rateFailures: 0 }); mode = 'header';
  await assert.rejects(github.request('/pulls/1'), /403.*paused until/);
  assert.ok((github as any).blockedUntil >= Date.now() + 89_000);
});
test('a rejected App key during token refresh is reported as a credential refusal rather than a pause', async t => {
  const {generateKeyPairSync} = await import('node:crypto');
  const {privateKey} = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const github = new GitHub({ repository: 'fixture/repo', base: 'main', appId: 1, installationId: 2, privateKey: privateKey.export({type:'pkcs8',format:'pem'}).toString() });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('{}', { status: 401 }); });
  await assert.rejects(github.request('/pulls/1'), (error: Error) => error instanceof GitHubPermissionRefusal && /installation authentication failed \(401\)/.test(error.message));
  assert.equal((github as any).blockedUntil, 0);
  // The same refusal answers every request for a minute; the credential is not re-tried per job.
  await assert.rejects(github.request('/pulls/2'), /installation authentication failed \(401\)/);
  assert.equal(calls, 1);
});

// integration:app-permissions-preflight
test('the permission preflight compares the installation with the declaration, holds only the blocked features, and retains the last verified reading through an outage', async t => {
  const {generateKeyPairSync} = await import('node:crypto');
  const {privateKey} = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const github = new GitHub({ repository: 'fixture/repo', base: 'main', appId: 77, installationId: 4242, privateKey: privateKey.export({type:'pkcs8',format:'pem'}).toString() });
  let permissions: Record<string, string> = { actions: 'write', administration: 'read', checks: 'write', contents: 'read', deployments: 'read', issues: 'read', metadata: 'read', pull_requests: 'write', workflows: 'write' };
  let failing = false; const seen: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, options: any) => {
    seen.push(String(url));
    assert.equal(String(url), 'https://api.github.com/app/installations/4242');
    assert.match(options.headers.Authorization, /^Bearer eyJ/, 'App-level endpoints use the App JWT, not an installation token');
    if (failing) return new Response('{}', { status: 503 });
    return new Response(JSON.stringify({ id: 4242, app_slug: 'graphyard-fixture-repo', html_url: 'https://github.com/settings/installations/4242', account: { login: 'fixture' }, permissions, suspended_at: null }));
  });
  assert.equal(github.permissionReport(), null, 'nothing is held before a preflight has run');
  assert.equal(github.permissionShortfall('merge-queue'), null);
  const first = await github.preflight(1_000);
  assert.equal(first.error, null); assert.equal(first.app, 'graphyard-fixture-repo'); assert.equal(first.account, 'fixture');
  assert.deepEqual(first.missing.map(shortfall => shortfall.permission), ['contents']);
  assert.deepEqual(first.blockedFeatures, ['merge-queue']);
  assert.deepEqual(first.attention, ['App graphyard-fixture-repo lacks Contents: write (installed with read), which branch refresh needs to push base refreshes and main-guard revert branches onto the managed repository; accept the pending permission request at https://github.com/settings/installations/4242']);
  assert.equal(github.permissionShortfall('merge-queue'), first.attention[0]);
  assert.equal(github.permissionShortfall('observation'), null); assert.equal(github.permissionShortfall('check'), null); assert.equal(github.permissionShortfall('review-dispatch'), null);
  assert.equal(await github.preflightIfDue(1_000 + github.preflightIntervalMs - 1), null, 'the periodic preflight waits for its interval');
  // An outage keeps the verified shortfall and says the reading is stale; it never lifts the hold.
  failing = true;
  const stale = (await github.preflightIfDue(1_000 + github.preflightIntervalMs))!;
  assert.match(stale.error!, /503/); assert.equal(stale.verifiedAt, first.verifiedAt);
  assert.deepEqual(stale.missing, first.missing);
  assert.match(stale.attention[0], /could not be verified since/); assert.equal(stale.attention[1], first.attention[0]);
  assert.equal(github.permissionShortfall('merge-queue'), first.attention[0]);
  // Acceptance clears the shortfall and every hold reason with it.
  failing = false; permissions = { ...permissions, contents: 'write' };
  const accepted = await github.preflight(5_000_000);
  assert.deepEqual(accepted.missing, []); assert.deepEqual(accepted.attention, []); assert.equal(accepted.error, null);
  assert.equal(github.permissionShortfall('merge-queue'), null);
  const report = github.permissionReport()!; report.missing.push({ permission: 'x', required: 'write', granted: null, features: ['check'], reasons: [] });
  assert.deepEqual(github.permissionReport()!.missing, [], 'reports are snapshots');
  assert.equal(seen.length, 3);
});
test('a suspended installation holds every feature and a permission refusal reports it', async t => {
  const {generateKeyPairSync} = await import('node:crypto');
  const {privateKey} = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const github = new GitHub({ repository: 'fixture/repo', base: 'main', appId: 1, installationId: 2, privateKey: privateKey.export({type:'pkcs8',format:'pem'}).toString() });
  Object.assign(github, { token: 'fixture-token', expires: Date.now() + 3600000 });
  t.mock.method(globalThis, 'fetch', async (url: unknown) => String(url).includes('/app/installations/')
    ? new Response(JSON.stringify({ id: 2, app_slug: 'graphyard-fixture', html_url: 'https://github.com/settings/installations/2', permissions: { actions: 'write', administration: 'read', checks: 'write', contents: 'write', deployments: 'read', issues: 'read', metadata: 'read', pull_requests: 'write', workflows: 'write' }, suspended_at: '2026-09-18T00:00:00Z' }))
    : new Response('{}', { status: 403 }));
  const report = await github.preflight();
  assert.equal(report.suspended, true); assert.deepEqual(report.missing, []);
  assert.match(github.permissionShortfall('observation')!, /installation is suspended; restore it at https:\/\/github\.com\/settings\/installations\/2/);
  await assert.rejects(github.request('/pulls/1'), /403.*installation is suspended/);
});

test('a head\'s added history is one compare per SHA pair, and a truncated list falls back to per-commit ancestry', async t => {
  const github = client(); const base = 'a'.repeat(40), head = 'b'.repeat(40), peer = 'c'.repeat(40); let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    calls++; assert.match(String(url), new RegExp(`/compare/${base}\\.\\.\\.${head}\\?per_page=100&page=1$`));
    return new Response(JSON.stringify({ total_commits: 2, commits: [{ sha: peer }, { sha: head }] }));
  });
  const added = await github.historySince(base, head);
  assert.deepEqual([...added!].sort(), [head, peer].sort());
  assert.equal(await github.historySince(base, head), added, 'a SHA pair is asked once');
  assert.equal(calls, 1);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ total_commits: 500, commits: [{ sha: peer }] })));
  assert.equal(await github.historySince(head, base), null, 'a truncated list gives no shortcut');
});

test('unit:github-http.approve-revert-then-merge-under-last-push-approval — the guard\'s revert is approved by the independent approver App at the verified head and merges head-bound under main\'s last-push-approval rule; without the approver every merge is refused, and the abandonment names the missing approver and keeps main red visible', async () => {
  // GY-1335: main requires one approval from someone other than the last pusher (require_last_push_approval,
  // enforce_admins, no bypass). The control-plane App pushes every revert, so this GitHub refuses its
  // head-bound merge unless an App other than it approved exactly that head — the 2026-10-05 refusal.
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const { runMainGuard, applyMainGuardRevert, mainGuardAttention } = await import('../src/main-guard.js');
  const head = 'e9'.repeat(20), mergeSha = 'a1'.repeat(20), pr = 900;
  const lastPusher = 'New changes require approval from someone other than the last pusher.';
  function world(approver: boolean) {
    const github = new GitHub({ repository: 'fixture/repo', base: 'main', appId: 1, installationId: 2, privateKey: 'not-used', ...(approver ? { revertApprover: { appId: 5678, installationId: 9, privateKey } } : {}) });
    Object.assign(github, { token: 'control-plane-token', expires: Date.now() + 3600000 });
    const state = { reviews: [] as any[], merged: null as string | null, merges: [] as { head: string; refused: boolean }[], approvals: [] as { auth: string; commit: string }[] };
    github.fetch = (async (input: string, init: RequestInit = {}) => {
      const url = new URL(String(input)), method = init.method ?? 'GET', body = init.body ? JSON.parse(String(init.body)) : undefined;
      const auth = String((init.headers as Record<string, string>)?.Authorization);
      if (url.pathname === '/app/installations/9/access_tokens') return Response.json({ token: 'approver-installation-token', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
      if (url.pathname === `/repos/fixture/repo/pulls/${pr}/reviews` && method === 'GET') return Response.json(state.reviews);
      if (url.pathname === `/repos/fixture/repo/pulls/${pr}/reviews` && method === 'POST') {
        state.approvals.push({ auth, commit: body.commit_id });
        const review = { id: state.reviews.length + 1, state: 'APPROVED', commit_id: body.commit_id, performed_via_github_app: { id: auth === 'Bearer approver-installation-token' ? 5678 : 1 } };
        state.reviews.push(review);
        return Response.json(review);
      }
      if (url.pathname === `/repos/fixture/repo/pulls/${pr}`) return Response.json({ number: pr, state: state.merged ? 'closed' : 'open', merged: !!state.merged, merge_commit_sha: state.merged, mergeable: true, head: { sha: head } });
      if (url.pathname.endsWith('/check-runs') && method === 'GET') return Response.json({ total_count: 0, check_runs: [] });
      if (url.pathname === '/repos/fixture/repo/check-runs' && method === 'POST') return Response.json({ id: 1, ...body }, { status: 201 });
      if (url.pathname === '/graphql') {
        if (/mergePullRequest/.test(body.query)) {
          // Branch protection: the merger is the control-plane App, which pushed the revert, so only an
          // approval at exactly the merged head from an App other than it satisfies the rule.
          const approvedByAnother = state.reviews.some(review => review.state === 'APPROVED' && review.commit_id === body.variables.head && review.performed_via_github_app?.id !== 1);
          state.merges.push({ head: body.variables.head, refused: !approvedByAnother });
          if (!approvedByAnother) return Response.json({ data: null, errors: [{ message: lastPusher }] });
          state.merged = 'c3'.repeat(20);
          return Response.json({ data: { mergePullRequest: { pullRequest: { id: 'PR_900' } } } });
        }
        return Response.json({ data: { repository: { mergeQueue: null, pullRequest: { id: 'PR_900', headRefOid: head, isInMergeQueue: false, mergeQueueEntry: null, autoMergeRequest: null, mergeStateStatus: 'BLOCKED' } } } });
      }
      return new Response(`unexpected ${method} ${url.pathname}`, { status: 500 });
    }) as typeof fetch;
    const work = { id: 'work-1', key: 'GY-1', stage: 'done', delivery: { mergeSha }, submission: { pr: 800 },
      mainGuardReverts: [{ mergeSha, pr: 800, failing: ['test'], revert: { pr, head }, state: 'opened', at: new Date().toISOString(), settledAt: null, revertSha: null, reason: null }] } as any;
    const patch = { forward: '@@ -1 +1 @@\n-old\n+new', backward: '@@ -1 +1 @@\n-new\n+old' };
    const closed: string[] = [];
    const ports = {
      reverting: async () => work.mainGuardReverts.some((revert: any) => revert.state === 'opened') ? [work] : [],
      culprit: async () => null, history: async () => [], checks: async () => [{ name: 'test', result: 'success', appId: 15368 }],
      openRevert: async () => ({ refusal: 'not opened here' }),
      pull: (number: number) => github.revertPull(number),
      mergeChanges: async () => [{ filename: 'src/a.ts', status: 'modified', patch: patch.forward }],
      revertChanges: async () => [{ filename: 'src/a.ts', status: 'modified', patch: patch.backward }],
      approveRevert: (number: number, at: string, text: string) => github.approveRevert(number, at, text),
      mergeRevert: (item: any, revert: { pr: number; head: string; failing: string[] }) => github.mergeRevert(item, revert),
      closeRevert: async (_number: number, reason: string) => { closed.push(reason); },
      record: async (item: any, revert: any) => { applyMainGuardRevert(item, revert, new Date()); },
    };
    return { github, state, work, ports, closed };
  }
  const options = { required: ['test'], ciAppIds: [15368], approved: new Set<string>() };

  // Configured: one tick approves the verified head as the approver App and merges it, head-bound, under the rule.
  const configured = world(true);
  assert.deepEqual((await runMainGuard(configured.ports as any, options)).errors, []);
  assert.deepEqual(configured.state.approvals, [{ auth: 'Bearer approver-installation-token', commit: head }], 'the approver App approved exactly the verified head');
  assert.deepEqual(configured.state.merges, [{ head, refused: false }], 'the head-bound merge passed the last-push-approval rule');
  assert.equal(configured.work.mainGuardReverts[0].state, 'merged');
  assert.equal(configured.work.mainGuardReverts[0].revertSha, 'c3'.repeat(20));
  assert.equal(configured.work.stage, 'ready', 'the reverted item is reopened for rework');
  assert.deepEqual(configured.closed, []);

  // Unconfigured: nothing approves, so every merge is refused by the rule; after its landing attempts
  // the revert is abandoned naming the rule and the missing approver, and main stays visibly red.
  const unconfigured = world(false), retries = { ...options, approved: new Set<string>() };
  for (let tick = 0; tick < 3; tick++) assert.deepEqual((await runMainGuard(unconfigured.ports as any, retries)).errors, []);
  assert.deepEqual(unconfigured.state.approvals, [], 'no approval was ever posted');
  assert.deepEqual(unconfigured.state.merges.map(merge => merge.refused), [true, true, true]);
  const abandoned = unconfigured.work.mainGuardReverts[0];
  assert.equal(abandoned.state, 'abandoned'); assert.equal(abandoned.cause, 'approval-refused'); assert.equal(abandoned.red, true);
  assert.match(abandoned.reason, /other than the last pusher/);
  assert.match(abandoned.reason, /no revert approver App is configured \(GRAPHYARD_REVERT_APPROVER_APP_ID, GRAPHYARD_REVERT_APPROVER_INSTALLATION_ID, GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY\)/);
  assert.equal(unconfigured.closed.length, 1, 'the revert pull request is closed once');
  const [line] = mainGuardAttention([unconfigured.work]);
  assert.match(line.text, /\[approval-rule refusal\]/); assert.match(line.text, /Main is still red/); assert.deepEqual(line.red, ['test']);
});
