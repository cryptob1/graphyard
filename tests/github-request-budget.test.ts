import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GitHub, CHECK_NAME, etagCacheEntries, idleObservationSeconds, mergeObservationSeconds, peerContainmentConcurrency, processJob } from '../src/github.js';
import { Store } from '../src/store/store.js';
import type { Work } from '../src/model.js';

// GY-142: one observation round must fit the App's hourly request budget, and an observation of a
// candidate with many open peers must finish well inside the 25-second merge window.
const sha = (label: string) => createHash('sha1').update(label).digest('hex');
const head = sha('head'), base = sha('base'), baseBlob = sha('base-blob');

/** A fake GitHub behind `fetch`: every GET carries an ETag and a matching If-None-Match is answered 304, as GitHub does. */
function fakeGitHub(options: { contained?: Set<string>; compareDelayMs?: (base: string) => number } = {}) {
  const requests: { path: string; status: number }[] = [];
  let inFlight = 0, maxInFlight = 0;
  const pr = { number: 10, head: { sha: head, ref: 'graphyard/gy-142-1', repo: { full_name: 'owner/repo' } }, base: { sha: base, ref: 'main', repo: { full_name: 'owner/repo' } },
    user: { login: 'author' }, merged: false, mergeable: true, draft: false, state: 'open', merge_commit_sha: null, created_at: '2026-09-23T00:00:00Z' };
  const route = async (path: string): Promise<{ status: number; body: any }> => {
    if (path === '/pulls/10') return { status: 200, body: pr };
    if (path.startsWith('/commits/') && path.includes('/check-runs')) return { status: 200, body: { check_runs: [{ id: 9, name: 'test', status: 'completed', conclusion: 'success', app: { id: 15368 } }] } };
    if (path.startsWith('/pulls/10/reviews')) return { status: 200, body: [] };
    if (path.startsWith('/pulls/10/files')) return { status: 200, body: [{ filename: 'src/github.ts', status: 'modified', sha: sha('own'), additions: 1, deletions: 1 }] };
    if (path.includes('/protection')) return { status: 200, body: { required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } } };
    if (path === '/git/ref/heads/main') return { status: 200, body: { ref: 'refs/heads/main', object: { type: 'commit', sha: base } } };
    if (/^\/commits\/[a-f0-9]{40}$/.test(path)) return { status: 200, body: { sha: path.slice(9), commit: { tree: { sha: sha(`tree:${path.slice(9)}`) } } } };
    if (path.startsWith('/compare/')) {
      const [from, to] = path.slice(9, path.indexOf('?')).split('...');
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try { await new Promise(resolve => setTimeout(resolve, options.compareDelayMs?.(from) ?? 0)); }
      finally { inFlight--; }
      const status = from === base || options.contained?.has(from) ? 'ahead' : 'diverged';
      return { status: 200, body: { status, files: [], compared: `${from}...${to}` } };
    }
    // Every peer's out-of-scope file stands in the head exactly as the base holds it: a dropped change.
    if (path.startsWith('/contents/')) return { status: 200, body: { type: 'file', sha: baseBlob, path: decodeURIComponent(path.slice(10, path.indexOf('?'))) } };
    throw new Error(`Unexpected request ${path}`);
  };
  const fetch = async (url: unknown, init: any) => {
    const path = String(url).replace('https://api.github.com/repos/owner/repo', '');
    const { status, body } = await route(path);
    const etag = `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;
    const answered = init.headers['If-None-Match'] === etag ? 304 : status;
    requests.push({ path, status: answered });
    return answered === 304 ? new Response(null, { status: 304 }) : new Response(JSON.stringify(body), { status, headers: { etag } });
  };
  const github = new GitHub({ repository: 'owner/repo', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used' });
  Object.assign(github, { token: 'fixture-token', expires: Date.now() + 3_600_000 });
  return { github, fetch, requests, maxInFlight: () => maxInFlight };
}
function item(): Work {
  return { id: 'item', key: 'GY-142', stage: 'review', policy: { review: false, checks: ['test'] }, plannedFiles: ['src/github.ts'], submission: { pr: 10, epoch: 1 },
    candidate: { sha: head, baseSha: base, pr: 10 }, policyRevision: 1, revision: 3, gates: [], violations: [] } as unknown as Work;
}
function peers(count: number): Work[] {
  return Array.from({ length: count }, (_, index) => {
    const peerHead = sha(`peer-${index}`);
    return { id: `peer-${index}`, key: `GY-${200 + index}`, stage: 'review', submission: { pr: 100 + index, epoch: 1 }, candidate: { sha: peerHead, baseSha: base, pr: 100 + index },
      observation: { merged: false, prState: 'open', candidate: { sha: peerHead }, scopeFiles: [{ path: `lib/peer-${index}.ts`, status: 'modified', sha: sha(`peer-blob-${index}`) }] } } as unknown as Work;
  });
}
const compares = (requests: { path: string }[]) => requests.filter(request => request.path.startsWith('/compare/')).map(request => request.path);

test('unit:github-request-budget-bounded — a second observation asks no compare for a commit pair already answered, and every path GitHub answered 304 stays cached', async t => {
  const others = peers(6), contained = new Set([others[1].candidate!.sha, others[4].candidate!.sha]);
  const f = fakeGitHub({ contained });
  t.mock.method(globalThis, 'fetch', f.fetch);
  const work = item();
  const first = await f.github.observe(work, others);
  const firstRound = f.requests.splice(0);
  const asked = compares(firstRound);
  assert.equal(asked.length, 1 + others.length, 'the base tip and every open peer are compared once in the first round');
  // The same item observed again: the landing cache is not in play (no previous observation), so only memoized ancestry spares the compares.
  const second = await f.github.observe(work, others);
  const secondRound = f.requests.splice(0);
  assert.deepEqual(compares(secondRound).filter(path => asked.includes(path)), [], 'no compare is repeated for a pair already answered');
  assert.deepEqual(compares(secondRound), []);
  assert.deepEqual(second.landing?.foreign, first.landing?.foreign);
  assert.deepEqual(second.landing?.carried, first.landing?.carried);
  // Everything else was asked conditionally and answered 304, which GitHub does not count against the budget.
  const notModified = secondRound.filter(request => request.status === 304).map(request => request.path);
  assert.ok(notModified.length > 0);
  assert.deepEqual(secondRound.filter(request => request.status !== 304), [], 'a repeated round costs no rate budget');
  const cache = (f.github as any).cache as Map<string, unknown>;
  for (const path of notModified) assert.ok(cache.has(`/repos/owner/repo${path}`), `${path} keeps its cache entry after a 304`);
  // A third round is still served from the cache: a 304 never drops its entry.
  await f.github.observe(work, others);
  assert.deepEqual(f.requests.filter(request => request.status !== 304), []);
});

test('unit:github-request-budget-bounded — the ETag cache holds a whole observation round and a 304 refreshes an entry\'s recency', async t => {
  assert.ok(etagCacheEntries >= 4096, 'room for ~10 paths per PR across hundreds of open PRs');
  const github = new GitHub({ repository: 'owner/repo', base: 'main', appId: 1, installationId: 2, privateKey: 'not-used' });
  Object.assign(github, { token: 'fixture-token', expires: Date.now() + 3_600_000 });
  const statuses: number[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: any) => {
    const etag = `"${String(url)}"`;
    const status = init.headers['If-None-Match'] === etag ? 304 : 200;
    statuses.push(status);
    return status === 304 ? new Response(null, { status }) : new Response(JSON.stringify({ url: String(url) }), { headers: { etag } });
  });
  const cache = (github as any).cache as Map<string, unknown>;
  // A round of several hundred paths (more than the 256 the cache used to hold) is served 304 on the next round.
  for (let n = 0; n < 600; n++) await github.request(`/pulls/${n}`);
  statuses.length = 0;
  for (let n = 0; n < 600; n++) await github.request(`/pulls/${n}`);
  assert.deepEqual(new Set(statuses), new Set([304]), 'every path of the round is answered 304');
  // Fill the cache; the oldest entry is kept alive by its 304 and the next-oldest is evicted instead.
  for (let n = 600; n < etagCacheEntries; n++) await github.request(`/pulls/${n}`);
  assert.equal(cache.size, etagCacheEntries);
  statuses.length = 0;
  await github.request('/pulls/0');
  assert.deepEqual(statuses, [304]);
  await github.request('/pulls/overflow');
  assert.equal(cache.size, etagCacheEntries);
  assert.ok(cache.has('/repos/owner/repo/pulls/0'), 'the entry served 304 was refreshed, not evicted');
  assert.ok(!cache.has('/repos/owner/repo/pulls/1'), 'the least recently used entry is the one evicted');
});

test('unit:github-request-budget-bounded — finishJob schedules the next observation 20 s out for a merge-stage item and 90 s out otherwise', async () => {
  assert.equal(mergeObservationSeconds, 20); assert.equal(idleObservationSeconds, 90);
  const settled: Record<string, number | undefined> = {};
  for (const stage of ['merge', 'review', 'build', 'test', 'acceptance'] as const) {
    const finished: any[][] = [];
    const engine = { store: {
      takeJob: async () => ({ work_id: 'item', token: 'token', attempts: 0 }),
      // No submission: nothing is observed, so the job settles on the success path alone.
      list: async () => [{ id: 'item', key: 'GY-142', stage } as unknown as Work],
      finishJob: async (...args: any[]) => { finished.push(args); },
      holdJob: async () => { throw new Error('nothing is held'); },
    } } as any;
    await processJob(engine, {} as GitHub);
    assert.equal(finished.length, 1);
    assert.deepEqual(finished[0].slice(0, 4), ['item', 'token', undefined, false]);
    settled[stage] = finished[0][4];
  }
  assert.deepEqual(settled, { merge: 20, review: 90, build: 90, test: 90, acceptance: 90 });
  // The store turns that delay into the job's next availability after a success.
  for (const seconds of [20, 90]) {
    const queries: { sql: string; params: any[] }[] = [];
    const store = new Store('postgres://unused@localhost/unused');
    await store.pool.end();
    store.pool = { query: async (sql: string, params: any[]) => { queries.push({ sql, params }); return { rows: [], rowCount: 1 }; } } as any;
    await store.finishJob('item', 'token', undefined, false, seconds);
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /WHEN \$3::text IS NULL THEN make_interval\(secs => \$5::int\)/);
    assert.equal(queries[0].params[4], seconds);
  }
});

test('unit:peer-containment-concurrent — an observation with 30 open peers completes in a small multiple of one compare, never exceeds the concurrency bound, and names the same foreign and carried peers as the sequential order', async t => {
  const delay = 150;
  const others = peers(30);
  const contained = new Set(others.filter((_, index) => index % 4 === 1).map(peer => peer.candidate!.sha));
  // Later peers answer sooner, so completion order differs from peer order; the lists must not.
  const delays = new Map(others.map((peer, index) => [peer.candidate!.sha, index < 15 ? delay : delay / 3]));
  const f = fakeGitHub({ contained, compareDelayMs: from => delays.get(from) ?? delay });
  t.mock.method(globalThis, 'fetch', f.fetch);
  const started = performance.now();
  const observation = await f.github.observe(item(), others);
  const elapsed = performance.now() - started;
  assert.ok(peerContainmentConcurrency > 1 && peerContainmentConcurrency <= 8, 'the documented bound');
  assert.equal(f.maxInFlight(), peerContainmentConcurrency, 'compares are asked concurrently, up to the bound and never beyond it');
  // Sequentially this is 1 + 30 compares (~3.4 s here, ~27 s in production); concurrently about ceil(30/8) + 1 compare delays.
  assert.ok(elapsed < delay * 10, `observe took ${Math.round(elapsed)} ms, more than ten compare delays`);
  // The sequential answer: the peers in order, those whose head the candidate contains.
  const sequential = others.filter(peer => contained.has(peer.candidate!.sha));
  assert.deepEqual(observation.landing?.foreign, sequential.map(peer => ({ key: peer.key, pr: peer.candidate!.pr, head: peer.candidate!.sha })));
  assert.deepEqual(observation.landing?.carried, sequential.map(peer => ({ key: peer.key, pr: peer.candidate!.pr, head: peer.candidate!.sha,
    dropped: [{ path: peer.observation!.scopeFiles![0].path, detail: 'the file is held exactly as the commit it would land on holds it' }] })));
  assert.equal(compares(f.requests).length, 1 + others.length, 'one compare per peer, none repeated');
});
