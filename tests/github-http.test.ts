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
  for(mode of ['absent','invalid','failure'])assert.equal(await github.reviewRepository(),null);
 });
