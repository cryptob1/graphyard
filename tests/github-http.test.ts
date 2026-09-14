import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GitHub} from '../src/github.js';
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
test('an unsolicited not-modified response cannot become evidence', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 304 }));
  await assert.rejects(client().request('/pulls/1'), /304/);
});
