import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeCodex, CODEX_APP_ID, CODEX_USER_ID } from '../src/codex-review.js';
const head = 'a'.repeat(40), base = 'b'.repeat(40);
function fixture() {
  const bot = { id: CODEX_USER_ID, type: 'Bot' };
  const createdAt = '2026-01-01T00:00:00Z', completed = '2026-01-01T00:01:00.200Z';
  const request = { commentId: 12, sha: head, baseSha: base, policyRevision: 1, body: '@codex review\n\n<!-- graphyard-review:test -->', createdAt };
  const trigger: any = { id: 12, body: request.body, user: { type: 'Bot' }, performed_via_github_app: { id: 1234 }, created_at: createdAt, updated_at: createdAt };
  const summary: any = { id: 13, user: bot, performed_via_github_app: { id: CODEX_APP_ID }, body: `<!-- codex-pull-request-review-summary -->\n| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="${completed}">${completed}</relative-time> | \`aaaaaaa\` | Manual request |`, updated_at: '2026-01-01T00:01:00Z' };
  const reactions: any[] = [{ id: 14, user: bot, content: '+1', created_at: '2026-01-01T00:01:01Z' }];
  const reviews: any[] = []; let resolved = head;
  const source = { async pages(path: string) { return structuredClone(path.endsWith('/reactions') ? reactions : path.endsWith('/reviews') ? reviews : [summary, trigger]); }, async request(path: string) { return structuredClone(path.startsWith('/commits/') ? { sha: resolved } : path.endsWith('/13') ? summary : trigger); } };
  return { request, trigger, summary, reactions, reviews, source, resolve: (sha: string) => { resolved = sha; }, run: () => observeCodex(source, 1, head, reviews, 12345, request, base, 1, 1234) };
}
test('a clean Codex response approves only the recorded full candidate and policy', async () => {
  const f = fixture(); const result = await f.run(); assert.equal(result.approved, true); assert.equal(result.sha, head); assert.equal(result.requestId, 12);
  f.request.baseSha = 'c'.repeat(40); assert.equal((await f.run()).approved, false);
  f.request.baseSha = base; f.request.policyRevision = 2; assert.equal((await f.run()).approved, false);
});
test('spoofed producers, edited requests, stale reactions, findings and running reviews refuse', async () => {
  const changes = [
    (f: ReturnType<typeof fixture>) => { f.summary.performed_via_github_app.id = 99; },
    (f: ReturnType<typeof fixture>) => { f.summary.user.id = 99; },
    (f: ReturnType<typeof fixture>) => { f.trigger.updated_at = '2026-01-01T00:00:01Z'; },
    (f: ReturnType<typeof fixture>) => { f.reactions[0].user.id = 99; },
    (f: ReturnType<typeof fixture>) => { f.reactions[0].created_at = '2025-12-31T23:00:00Z'; },
    (f: ReturnType<typeof fixture>) => { f.summary.body = f.summary.body.replace('Completed', 'Running'); },
    (f: ReturnType<typeof fixture>) => { f.reviews.push({ user: { id: CODEX_USER_ID, type: 'Bot' }, submitted_at: '2026-01-01T00:00:30Z', state: 'COMMENTED' }); },
    (f: ReturnType<typeof fixture>) => { f.resolve('c'.repeat(40)); },
    (f: ReturnType<typeof fixture>) => { f.reactions.push({ user: { id: CODEX_USER_ID, type: 'Bot' }, content: 'eyes' }); },
  ];
  for (const change of changes) { const f = fixture(); change(f); assert.equal((await f.run()).approved, false); }
});
test('provider resolution failure and changed evidence never produce approval', async () => {
  const f = fixture(); f.source.request = async () => { throw new Error('Ambiguous abbreviated commit'); }; await assert.rejects(f.run(), /Ambiguous/);
  const g = fixture(), original = g.source.request;
  g.source.request = async path => { const result = await original(path); if (path.endsWith('/13')) result.body += 'changed'; return result; };
  assert.equal((await g.run()).approved, false);
});

test('the same Codex numeric identity cannot review its own PR after a login rename', async () => {
 const f = fixture(); const result = await observeCodex(f.source, 1, head, [], CODEX_USER_ID, f.request, base, 1, 1234); assert.equal(result.approved, false); assert.match(result.reason, /independent/);
});

// @ts-expect-error The deployment helper intentionally runs as standalone JavaScript.
import { assertReviewServer } from '../scripts/review-server.mjs';
test('native approval migration refuses a different, disconnected or unsupported live installation', () => {
 const app = { appId: 1234, installationId: 7 };
 const status = { github: true, repository: 'owner/repo', githubAppId: 1234, githubInstallationId: 7, reviewProviders: ['codex'] };
 assert.doesNotThrow(() => assertReviewServer(status, 'owner/repo', app));
 assert.doesNotThrow(() => assertReviewServer({...status, repository:'OWNER/Repo'}, 'owner/repo', app));
 for (const override of [{github:false}, {repository:'other/repo'}, {githubAppId:987}, {githubInstallationId:8}, {reviewProviders:[]}]) assert.throws(() => assertReviewServer({...status,...override}, 'owner/repo', app), /does not manage/);
});

 test('automatic reviews use the PR clean result and must complete after candidate binding', async () => {
  for (const kind of ['PR opened', 'New commits']) {
    const f = fixture(); f.summary.body = f.summary.body.replace('Manual request', kind);
    const original = f.source.pages; const paths: string[] = [];
    f.source.pages = async path => { paths.push(path); return original(path); };
    assert.equal((await f.run()).approved, true);
    assert.ok(paths.includes('/issues/1/reactions'));
    assert.ok(!paths.includes('/issues/comments/12/reactions'));
    f.request.createdAt = f.trigger.created_at = f.trigger.updated_at = '2026-01-01T00:01:00Z';
    assert.equal((await f.run()).approved, false);
    f.request.createdAt = f.trigger.created_at = f.trigger.updated_at = '2026-01-01T00:02:00Z';
    assert.equal((await f.run()).approved, false);
  }
 });

function commentFixture() {
  const f = fixture();
  f.summary.body = f.summary.body.replace('Completed', 'Running');
  const result: any = { id: 15, user: { id: CODEX_USER_ID, type: 'Bot' }, performed_via_github_app: { id: CODEX_APP_ID }, body: "Codex Review: Didn't find any major issues. :+1:\n\n**Reviewed commit:** `aaaaaaaaaa`\n", created_at: '2026-01-01T00:02:00Z', updated_at: '2026-01-01T00:02:00Z' };
  const comments = [f.summary, f.trigger, result];
  const originalPages = f.source.pages, originalRequest = f.source.request;
  f.source.pages = async path => path.endsWith('/comments') ? structuredClone(comments) : originalPages(path);
  f.source.request = async path => path.endsWith('/15') ? structuredClone(result) : originalRequest(path);
  return { ...f, result, comments };
}
test('authenticated explicit clean result supersedes an older stuck summary', async () => {
  const f = commentFixture(); const result = await f.run(); assert.equal(result.approved, true); assert.equal(result.resultId, 15);
});
test('explicit results refuse stale, edited, spoofed, conflicting and changing evidence', async () => {
  const changes = [
    (f: ReturnType<typeof commentFixture>) => { f.result.user.id = 99; },
    (f: ReturnType<typeof commentFixture>) => { f.result.performed_via_github_app.id = 99; },
    (f: ReturnType<typeof commentFixture>) => { f.result.created_at = f.result.updated_at = f.request.createdAt; },
    (f: ReturnType<typeof commentFixture>) => { f.result.updated_at = '2026-01-01T00:03:00Z'; },
    (f: ReturnType<typeof commentFixture>) => { f.summary.updated_at = f.result.created_at; },
    (f: ReturnType<typeof commentFixture>) => { f.trigger.body += 'edited'; },
    (f: ReturnType<typeof commentFixture>) => { f.resolve('c'.repeat(40)); },
    (f: ReturnType<typeof commentFixture>) => { f.reviews.push({ user: f.result.user, submitted_at: f.result.created_at }); },
    (f: ReturnType<typeof commentFixture>) => { f.reactions.push({ user: f.result.user, content: 'eyes' }); },
    (f: ReturnType<typeof commentFixture>) => { const original = f.source.request; f.source.request = async path => { const value = await original(path); if (path.endsWith('/15')) value.body += 'edited'; return value; }; },
    (f: ReturnType<typeof commentFixture>) => { const original = f.source.pages; let reads = 0; f.source.pages = async path => { const rows = await original(path); if (path.endsWith('/comments') && ++reads > 1) rows.push({ id: 16, user: f.result.user, created_at: '2026-01-01T00:03:00Z' }); return rows; }; },
  ];
  for (const change of changes) { const f = commentFixture(); change(f); assert.equal((await f.run()).approved, false); }
});

 test('same-second clean reactions cannot prove they followed review completion', async () => {
  const f = fixture(); f.reactions[0].created_at = '2026-01-01T00:01:00Z';
  assert.equal((await f.run()).approved, false);
  f.summary.body = f.summary.body.replace('00:01:00.200Z', '00:01:00Z');
  assert.equal((await f.run()).approved, false);
 });

 test('known standalone result variants retain the same strict verdict and commit binding', async () => {
  for (const suffix of ['', ' :tada:', ' What shall we delve into next?']) {
    const f = commentFixture(); f.result.body = f.result.body.replace(' :+1:', suffix);
    assert.equal((await f.run()).approved, true);
  }
  const unknown = commentFixture(); unknown.result.body = unknown.result.body.replace(' :+1:', ' However, a critical issue remains.');
  assert.equal((await unknown.run()).approved, false);
 });

 test('clean comments accept the exact provider footer but refuse all unknown trailing output', async () => {
  const {readFile} = await import('node:fs/promises');
  const real = await readFile(new URL('./fixtures/codex-clean-result.txt', import.meta.url), 'utf8');
  const valid = commentFixture(); valid.result.body = real; assert.equal((await valid.run()).approved, true);
  for (const body of [real + '\nP1: a serious issue', real.replace('Codex can also answer questions', 'Critical bug found. Codex can also answer questions'), commentFixture().result.body + '\nAdditional findings']) {
    const f = commentFixture(); f.result.body = body; assert.equal((await f.run()).approved, false);
  }
 });

test('migration refuses required code-owner review before making any external changes', async () => {
  const {mkdtemp,writeFile,readFile,rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os'); const {join} = await import('node:path'); const {spawnSync} = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(),'graphyard-protection-'));
  try {
    const log = join(dir,'calls.jsonl');
    await writeFile(join(dir,'gh'), `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');console.log(JSON.stringify({required_pull_request_reviews:{require_code_owner_reviews:true}}));\n`, {mode:0o700});
    const result = spawnSync(process.execPath, ['scripts/protect-github.mjs','--agent-reviews','--apply'], {encoding:'utf8',env:{...process.env,PATH:`${dir}:${process.env.PATH}`,GRAPHYARD_APP_ID:'1234'}});
    assert.equal(result.status,1); assert.match(result.stderr,/CODEOWNERS.*No protection settings were changed/);
    const calls=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(calls.length,1); assert.deepEqual(calls[0],['api','repos/cryptob1/graphyard/branches/main/protection']);
  } finally {await rm(dir,{recursive:true,force:true});}
});

 test('clean-result courtesy normalization excludes contradictory or unknown verdict suffixes', async () => {
  for (const suffix of ['Delightful!', 'Bravo.', 'Nice work!', 'Keep it up!', 'Well done!', 'Great work!', 'Excellent!', 'LGTM.', 'Hooray!', 'Hurrah!', 'Hurray!', 'Huzzah!', 'Woohoo!', 'Yay!']) {
    const f = commentFixture(); f.result.body = f.result.body.replace(':+1:', suffix);
    assert.equal((await f.run()).approved, true, suffix);
  }
  for (const suffix of ['P1: fix authentication', 'Nice work! However, a bug remains.', 'Critical!', 'Please fix the review findings.', 'Unknown protocol payload']) {
    const f = commentFixture(); f.result.body = f.result.body.replace(':+1:', suffix);
    assert.equal((await f.run()).approved, false, suffix);
  }
 });

 test('clean approval refuses edits visible only in the final list snapshot', async () => {
  for (const target of ['result', 'trigger'] as const) {
    const f = commentFixture(), original = f.source.pages; let reads = 0;
    f.source.pages = async path => {
      const rows = await original(path);
      if (path.endsWith('/comments') && ++reads > 1) rows.find(c => c.id === f[target].id).body += ' edited';
      return rows;
    };
    assert.equal((await f.run()).approved, false);
  }
 });
