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
 for (const override of [{github:false}, {repository:'other/repo'}, {githubAppId:987}, {githubInstallationId:8}, {reviewProviders:[]}]) assert.throws(() => assertReviewServer({...status,...override}, 'owner/repo', app), /does not manage/);
});
