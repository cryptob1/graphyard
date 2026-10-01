import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { GitHub } from '../src/github.js';
import { BoundedCache, EtagCache, blobContentBytes, etagCacheBytes, etagCacheEntries } from '../src/github-response-cache.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { standingEscalations, type Observation, type Principal, type Work } from '../src/model.js';

// GY-975: the production server's heap climbed to its 4 GB limit every ten to fifteen minutes. What
// retained it was the GitHub adapter's conditional-request cache: 4096 entries of parsed answers and
// no byte bound, while every new commit pair's compare answer carried each changed file's patch.
// These tests drive the requests every client polls — status, escalation context, action claims and
// the agent registry — beside the observation workers' compares, over a GitHub that answers large,
// and assert what the process retains after a full collection stays under a fixed bound.

setFlagsFromString('--expose-gc');
const collect = runInNewContext('gc') as () => void;
/** Heap in use after full collections, so only what something still references counts. */
const retained = () => { collect(); collect(); return process.memoryUsage().heapUsed; };
const MB = 1024 * 1024;

const repository = 'owner/heap';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const implementer: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const roster = [operator, coordinator, implementer];
const credentials = roster.map(principal => ({ ...principal, token: `heap-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
const sha = (n: number) => n.toString(16).padStart(40, '0');
const head = 'c'.repeat(40), base = 'd'.repeat(40);

/** A compare answer the size GitHub sends for a busy range: every changed file with its patch, whatever `per_page` says. */
const compareAnswer = (from: string, to: string) => JSON.stringify({ status: 'ahead', ahead_by: 40, behind_by: 0, total_commits: 40, base_commit: { sha: from }, merge_base_commit: { sha: from },
  commits: [{ sha: to }], files: Array.from({ length: 300 }, (_, index) => ({ filename: `src/module-${index}.ts`, status: 'modified', additions: 40, deletions: 12, patch: `@@ -1,12 +1,40 @@ ${to}\n${`+ line of ${from.slice(0, 8)} changed in file ${index}\n`.repeat(90)}` })) });
const rulesText = `# Rules\n\n${'Never weaken a criterion to pass. '.repeat(8_000)}\n`;

let database: EmbeddedPostgres, store: Store, engine: Engine, github: GitHub, http: ReturnType<typeof server>, url: string, scratch: string;
const realFetch = globalThis.fetch;
before(async () => {
  const port = Number(process.env.GRAPHYARD_HEAP_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 975);
  scratch = await temporaryDirectory('heap');
  database = new EmbeddedPostgres({ databaseDir: join(scratch, 'pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('heap_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/heap_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  github = new GitHub({ repository, base: 'main', appId: 1234, installationId: 7, privateKey: 'not-used' });
  Object.assign(github as any, { token: 'installation-token', expires: Date.now() + 3600_000, permissions: { pull_requests: 'write', issues: 'write', checks: 'write', contents: 'write' } });
  // GitHub, answering from the recorded shapes: the loopback server's own requests pass through.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input);
    if (!target.startsWith('https://api.github.com')) return realFetch(input as any, init);
    const path = new URL(target).pathname;
    const answer = (body: string) => new Response(body, { status: 200, headers: { etag: `"${createEtag(target)}"`, 'content-type': 'application/json' } });
    if (path === '/installation/repositories') return answer(JSON.stringify({ total_count: 1, repositories: [{ id: 42, full_name: repository }] }));
    const compared = /\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path);
    if (compared) return answer(compareAnswer(compared[1], compared[2]));
    if (path.endsWith('/contents/AGENTS.md')) return answer(JSON.stringify({ type: 'file', sha: 'e'.repeat(40), encoding: 'base64', content: Buffer.from(rulesText).toString('base64') }));
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  }) as typeof fetch;
  http = server(engine, credentials, github);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { globalThis.fetch = realFetch; if (http) await new Promise<void>(resolve => http.close(() => resolve())); await store?.close(); await database?.stop(); });
const createEtag = (target: string) => Buffer.from(target).toString('base64url').slice(-40);

async function call(principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  assert.equal(response.status, 200, `${method} ${path}: ${text.slice(0, 300)}`);
  return text.length;
}

function observation(work: Work): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: work.submission!.pr, branch: work.workspaces.at(-1)!.branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, files: ['src/heap.ts'], scopeFiles: [], baseTip: base, baseTree: 'f'.repeat(40), baseTipContained: true, at: new Date().toISOString() };
}
/** An item with a standing escalation, so its context read asks GitHub for the repository's rules. */
async function escalated() {
  let work = await engine.execute(operator, 'create', null, { title: 'heap', description: 'Why heap matters', plannedFiles: ['src/heap.ts'], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }, { id: 'AC-2', text: 'Audited', proofs: ['manual:audit'] }], reason: 'Operator goal' }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, { reason: 'Priority one' }, randomUUID());
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(implementer, 'workspace', work.id, { epoch: work.epoch, host: 'heap-host', path: `/tmp/heap/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, randomUUID());
  work = await engine.execute(implementer, 'submit', work.id, { epoch: work.epoch, pr: 975 }, randomUUID());
  work = await engine.observe(work.id, work.revision, observation(work));
  work = await engine.execute(operator, 'requirements', work.id, { expectedPolicyRevision: work.policyRevision, criteria: [work.criteria[0]], dependencies: work.dependencies, plannedFiles: work.plannedFiles, exclusiveResources: [], producerProofs: [], reason: 'AC-2 moves to a follow-up item' }, randomUUID());
  assert.deepEqual(standingEscalations(work).map(entry => entry.trigger), ['requirement-weakening']);
  return work;
}

test('unit:server-heap-bounded-under-repeated-requests — repeated status, context, claim and registry requests beside the observation compares retain a bounded heap', async () => {
  const work = await escalated();
  const cache = (github as any).cache as EtagCache;
  let pair = 0;
  // One polling round: every read a client repeats, and the compares the observation workers make
  // for commit pairs they have not seen. The rules are read at the base tip the item was observed
  // against, which moves as the base branch does, so each round reads them at a new ref as well.
  const round = async () => {
    const tip = sha(++pair);
    await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{observation,baseTip}', to_jsonb($2::text)) WHERE id=$1`, [work.id, tip]);
    await Promise.all([
      call(coordinator, 'GET', 'status'), call(operator, 'GET', 'status'),
      call(coordinator, 'GET', `work/${work.key}/context`),
      call(coordinator, 'POST', 'actions/claim', { executor: 'heap-executor', host: 'heap-host', kinds: ['dispatch'] }),
      call(implementer, 'POST', 'assignments/claim', {}),
      call(coordinator, 'GET', 'agent-registry'),
    ]);
    await github.contains(tip, head);
    await github.changedFiles(tip, head);
    assert.ok(cache.size <= etagCacheEntries && cache.bytes <= etagCacheBytes, `the answer cache holds ${cache.size} entries and ${cache.bytes} bytes`);
  };
  for (let n = 0; n < 20; n++) await round();
  const baseline = retained();
  const samples: number[] = [];
  for (let block = 0; block < 6; block++) {
    for (let n = 0; n < 50; n++) await round();
    samples.push(retained() - baseline);
  }
  const growth = samples.map(bytes => `${(bytes / MB).toFixed(1)} MB`).join(', ');
  // 300 rounds read 600 compare answers of about 1.2 MB each and 300 rule files of about 350 KB: kept
  // whole, that is well over a gigabyte. The bound is what the caches may hold plus working slack.
  const bound = etagCacheBytes / 2 + 64 * MB;
  assert.ok(samples.at(-1)! < bound, `retained heap grew ${growth} over the baseline across 300 rounds; the bound is ${(bound / MB).toFixed(0)} MB`);
  // Once the caches are full the heap plateaus: the last 150 rounds retain no more than slack.
  assert.ok(samples.at(-1)! - samples[2] < 32 * MB, `retained heap kept climbing after the caches filled: ${growth}`);
  console.log(`retained heap over baseline, every 50 rounds: ${growth}; answer cache ${cache.size} entries, ${(cache.bytes / MB).toFixed(1)} MB accounted`);
});

test('unit:server-heap-bounded-under-repeated-requests — the answer caches evict by bytes as well as entries and never keep an oversized answer', () => {
  const cache = new BoundedCache<string>(10, 100, 40, value => value.length);
  for (let index = 0; index < 10; index++) assert.equal(cache.set(`k${index}`, 'x'.repeat(30)), true);
  assert.ok(cache.bytes <= 100 && cache.size === 3, 'the byte bound evicts the least recently used entries first');
  assert.deepEqual([...cache.keys()], ['k7', 'k8', 'k9']);
  assert.equal(cache.set('big', 'x'.repeat(41)), false, 'an answer larger than one entry may be is not kept');
  assert.equal(cache.has('big'), false);
  cache.set('k7', 'y'); assert.deepEqual([...cache.keys()], ['k8', 'k9', 'k7'], 'a re-set entry becomes the most recent');
  for (let index = 0; index < 20; index++) cache.set(`n${index}`, 'z');
  assert.equal(cache.size, 10, 'the entry bound still holds');

  const answers = new EtagCache(4, 1_000, 500);
  answers.set('/persisted', { etag: '"p"', value: { number: 5 } });
  assert.deepEqual(answers.read('/persisted')!.value(), { number: 5 }, 'a persisted parsed value is kept as its text');
  answers.keep('/pulls/1', '"a"', JSON.stringify({ title: 'first' }));
  const served = answers.read('/pulls/1')!.value(); served.title = 'mutated by a caller';
  assert.deepEqual(answers.read('/pulls/1')!.value(), { title: 'first' }, 'every read parses a fresh copy');
  assert.equal(answers.keep('/compare/huge', '"h"', 'x'.repeat(300)), false, 'a text beyond the per-answer bound is not kept');
  assert.ok(blobContentBytes <= etagCacheBytes, 'blob bytes are bounded too');
});
