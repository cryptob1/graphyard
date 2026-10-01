import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { approveScopeRequest, masterStatusReport } from '../src/cli/master-status.js';
import { coordinationViewHeader } from '../src/server/work-view.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-864: CLI reads use a bounded snapshot: master status, master scope and the worker commands
 * in src/cli/workspace.ts read the trimmed coordination snapshot or a single item by key, never
 * the full work-snapshot; and GET /api/work-snapshot is paged (cursor and page size) so any
 * remaining full reader streams instead of loading every document at once.
 *
 * unit:cli-reads-bounded-snapshot — against a recording control plane holding 900 items whose
 * delivered documents weigh 300 KB each, master status, master scope and the worker's sync are
 * driven for real: each issues no full work-snapshot read, and the bytes each reads stay flat
 * while the delivered weight grows.
 *
 * unit:work-snapshot-paged — against the real server, a paged walk (cursor, pageSize) of the
 * full and default views covers every item exactly once, a page reads only its own documents
 * however large the ledger grows, unpaged responses are unchanged, and the coordination view
 * stays the loop's unpaged bounded poll.
 */

const execFile = promisify(execFileCallback);
const launcher = new URL('../bin/graphyard.mjs', import.meta.url).pathname;
const hex = (letter: string) => letter.repeat(40);
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const credentials = [operator].map(principal => ({ ...principal, token: `bounded-${principal.id}-${'x'.repeat(32)}` }));
const operatorToken = credentials[0].token;

let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 864;
  database = new EmbeddedPostgres({
    databaseDir: await temporaryDirectory('bounded-reads'),
    user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {},
    postgresFlags: ['-h', '127.0.0.1'],
  });
  await database.initialise();
  await database.start();
  await database.createDatabase('graphyard_bounded_reads');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_bounded_reads`);
  await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = credentials;
  engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});

after(async () => {
  http?.close();
  if (store) await store.close();
  if (database) await database.stop();
});

const get = async (path: string, token = operatorToken) => {
  const response = await fetch(`${url}/api/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as any, bytes: text.length };
};

/** A recording control plane: a ledger of 900 items whose delivered documents weigh 300 KB each. */
function recordingControlPlane() {
  const heavyBytes = 300 * 1024;
  const state = { delivered: 890, reads: [] as { path: string; coordination: boolean }[], violations: [] as string[], bytes: 0 };
  const items = (): Work[] => Array.from({ length: 900 }, (_, index): Work => {
    const key = `GY-${index + 1}`, delivered = index < state.delivered;
    return {
      id: `work-${index + 1}`, key, stage: delivered ? 'done' : 'build', title: `Item ${index + 1}`,
      plannedFiles: ['docs/'], dependencies: [], criteria: [], gates: [], violations: [], workspaces: [], evidence: [],
      policy: { checks: [], review: false },
      revision: 1, policyRevision: 1, epoch: 0,
      lease: key === 'GY-900'
        ? { owner: 'worker', epoch: 4, expiresAt: new Date(Date.now() + 600_000).toISOString() }
        : delivered ? null : { owner: 'worker', epoch: 1, expiresAt: new Date(Date.now() + 600_000).toISOString() },
      candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], observation: null,
      ready: false, blocker: null, priority: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stageEnteredAt: new Date().toISOString(),
      ...(key === 'GY-900' ? { scopeRequest: { epoch: 4, paths: ['docs/b.md'], reason: 'the extra doc is part of the layout work', requestedBy: 'worker', at: new Date().toISOString() } } : {}),
      ...(delivered ? { delivery: { mergeSha: hex('a'), mergedAt: new Date().toISOString() } } : {}),
    } as unknown as Work;
  });
  // What one whole document weighs; only the single-item route ever materializes it.
  const whole = (item: Work) => ({ ...item, history: 'x'.repeat(heavyBytes) });
  const trimmed = (item: Work) => ({ ...item, history: undefined });
  const json = (response: ServerResponse, body: unknown) => {
    const text = JSON.stringify(body);
    state.bytes += text.length;
    response.setHeader('Content-Type', 'application/json');
    response.end(text);
  };
  const httpServer = createServer((request: IncomingMessage, response: ServerResponse) => {
    const [path, query = ''] = (request.url ?? '').split('?');
    const view = new URLSearchParams(query).get('view');
    if (request.method === 'GET' && path === '/api/work-snapshot') {
      const coordination = view === 'coordination' || String(request.headers[coordinationViewHeader.toLowerCase()]) === 'coordination';
      state.reads.push({ path: 'work-snapshot', coordination });
      if (!coordination) { state.violations.push(`full work-snapshot read (${request.url})`); return json(response, { error: 'full reads are refused here' }); }
      return json(response, { now: new Date().toISOString(), view: 'coordination', omitted: { evidence: 0, dispatchHistory: 0, queueHistory: 0, actionHistory: 0, sessions: 0 }, jobs: [], work: items().map(trimmed) });
    }
    const single = /^\/api\/work\/(GY-\d+)$/.exec(path);
    if (request.method === 'GET' && single) {
      state.reads.push({ path: `single ${single[1]}`, coordination: false });
      return json(response, whole(items()[Number(single[1].slice(3)) - 1]));
    }
    if (request.method === 'GET' && path === '/api/work') return json(response, items());
    if (request.method === 'GET' && path === '/api/status') return json(response, { baseBranch: 'main', repository: 'owner/project', actor: { id: 'worker-a', role: 'worker' } });
    if (request.method === 'POST') return json(response, { plannedFiles: ['docs/a.md', 'docs/b.md'], recorded: true });
    return json(response, { decisions: [] });
  });
  const listen = new Promise<string>(resolve => httpServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(httpServer.address() as { port: number }).port}`)));
  return { state, listen, close: () => new Promise<void>(resolve => { httpServer.close(() => resolve()); httpServer.closeAllConnections(); }) };
}

const masterFixture = async () => {
  const root = await temporaryDirectory('bounded-reads-master');
  const directory = await temporaryDirectory('bounded-reads-credentials');
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile,
    cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  return { root, master, dispose: () => Promise.all([rm(root, { recursive: true, force: true }), rm(directory, { recursive: true, force: true })]) };
};

test('unit:cli-reads-bounded-snapshot — CLI commands read bounded snapshot or single item, not full work-snapshot', async () => {
  const control = recordingControlPlane();
  const origin = await control.listen;
  const { root, master, dispose: disposeFixture } = await masterFixture();
  const weight = () => control.state.delivered * 300 * 1024;
  try {
    // Master status: one trimmed coordination read, and its bytes ignore the delivered weight.
    const statusReads = async () => {
      control.state.reads.length = 0; control.state.violations.length = 0; control.state.bytes = 0;
      const coordinationApi = (path: string, credential?: string, timeoutMs?: number, headers?: Record<string, string>) =>
        fetch(`${origin}/api/${path}`, { headers: { ...(headers ?? {}), Authorization: 'Bearer coordinator-token' } }).then(response => response.json());
      await masterStatusReport(root, master, coordinationApi as unknown as Parameters<typeof masterStatusReport>[2], { actor: { id: 'coordinator-1' } }, { commit: null });
      return { reads: [...control.state.reads], violations: [...control.state.violations], bytes: control.state.bytes };
    };
    const first = await statusReads();
    assert.deepEqual(first.violations, [], 'master status issues no full work-snapshot read');
    assert.deepEqual(first.reads.filter(read => read.path === 'work-snapshot').map(read => read.coordination), [true], 'master status reads the coordination view, by header, on the work-snapshot path');
    assert.ok(first.bytes < 5_000_000 && weight() > 250_000_000, `master status read ${first.bytes} bytes of an otherwise ${weight()}-byte ledger`);
    control.state.delivered = 40;
    const second = await statusReads();
    assert.deepEqual(second.violations, []);
    assert.ok(second.bytes <= first.bytes && second.bytes < 5_000_000 && weight() < 15_000_000, `the bytes master status reads stay flat (${second.bytes} against ${first.bytes}) while the delivered weight drops from over 250 MB to under 15 MB`);
    control.state.delivered = 890;

    // Master scope: the one item by key, and no snapshot read at all.
    control.state.reads.length = 0; control.state.violations.length = 0;
    const workRoot = await temporaryDirectory('bounded-reads-scope');
    const decided = await approveScopeRequest(workRoot, { url: origin } as unknown as MasterConfig, ['GY-900', 'The extra doc is part of the layout work'],
      { coordinator: path => fetch(`${origin}/api/${path}`).then(response => response.json()), operatorToken: async () => 'operator-agent-token-'.padEnd(40, 'o') });
    assert.deepEqual(control.state.violations, [], 'master scope issues no full work-snapshot read');
    assert.deepEqual(control.state.reads.map(read => read.path), ['single GY-900'], 'master scope reads the one item by key');
    assert.equal(decided.recorded, true);
    await rm(workRoot, { recursive: true, force: true });

    // The worker's sync: the attribution read on a conflict is the trimmed coordination view.
    const cwd = await temporaryDirectory('bounded-reads-sync');
    const originRepo = join(cwd, 'origin'), clone = join(cwd, 'clone');
    const git = async (repo: string, ...args: string[]) => (await execFile('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], { cwd: repo })).stdout.trim();
    const commit = async (repo: string, message: string) => { await execFile('git', ['add', '-A'], { cwd: repo }); await git(repo, 'commit', '-q', '-m', message); return git(repo, 'rev-parse', 'HEAD'); };
    const task = { id: 'task', key: 'GY-1', plannedFiles: ['src/scoped/'], workspaces: [{ epoch: 1, host: hostname(), path: clone, branch: 'graphyard/gy-1-1' }] };
    const syncServer = createServer((request: IncomingMessage, response: ServerResponse) => {
      const [path] = (request.url ?? '').split('?');
      response.setHeader('Content-Type', 'application/json');
      if (path === '/api/status') return response.end(JSON.stringify({ baseBranch: 'main', repository: 'owner/project', actor: { id: 'worker-a', role: 'worker' } }));
      if (path === '/api/work') return response.end(JSON.stringify([task]));
      if (path === '/api/work-snapshot') {
        control.state.reads.push({ path: 'work-snapshot', coordination: (request.url ?? '').includes('view=coordination') });
        if (!(request.url ?? '').includes('view=coordination')) { control.state.violations.push(`full work-snapshot read (${request.url})`); response.statusCode = 500; return response.end('{"error":"full reads are refused here"}'); }
        return response.end(JSON.stringify({ now: new Date().toISOString(), work: [task] }));
      }
      return response.end(JSON.stringify({}));
    });
    // The CLI's reads ride one keep-alive connection; the git steps between them can outlast
    // node's 5 s idle close, so the fixture holds connections as long as the test runs.
    syncServer.keepAliveTimeout = 120_000;
    control.state.reads.length = 0; control.state.violations.length = 0;
    await new Promise<void>(resolve => syncServer.listen(0, '127.0.0.1', resolve));
    const syncOrigin = `http://127.0.0.1:${(syncServer.address() as { port: number }).port}`;
    try {
      await mkdir(originRepo, { recursive: true });
      await execFile('git', ['init', '-q', '--initial-branch', 'main'], { cwd: originRepo });
      await writeFile(join(originRepo, 'shared.txt'), 'base\n');
      await commit(originRepo, 'Base');
      await execFile('git', ['clone', '-q', originRepo, clone]);
      // The sync command runs git itself, without this fixture's per-call -c identity flags, so
      // the clone carries its own identity: a runner without a global git config would otherwise
      // fail the merge before the attribution read is ever issued.
      await execFile('git', ['config', 'user.name', 'Test'], { cwd: clone });
      await execFile('git', ['config', 'user.email', 'test@localhost'], { cwd: clone });
      await execFile('git', ['checkout', '-q', '-b', 'graphyard/gy-1-1'], { cwd: clone });
      await writeFile(join(clone, 'shared.txt'), 'mine\n');
      await commit(clone, 'Mine');
      await writeFile(join(originRepo, 'shared.txt'), 'theirs\n');
      await commit(originRepo, 'Theirs');
      const sync = execFile(process.execPath, [launcher, 'sync', 'GY-1'], { cwd: clone, env: { ...process.env, GRAPHYARD_URL: syncOrigin, GRAPHYARD_TOKEN: 'fixture' } });
      const outcome = await sync.then(() => ({ code: 0, output: '' }), (error: { code?: number | string; stdout?: string; stderr?: string }) =>
        ({ code: error.code, output: `stdout: ${error.stdout ?? ''}\nstderr: ${error.stderr ?? ''}`.trim() }));
      assert.equal(outcome.code, 1, `sync reports the conflict and exits non-zero\n${outcome.output}`);
      assert.deepEqual(control.state.violations, [], `the sync attribution read is not a full work-snapshot read\n${outcome.output}`);
      assert.deepEqual(control.state.reads.filter(read => read.path === 'work-snapshot').map(read => read.coordination), [true], `the sync attribution read is the coordination view\n${outcome.output}`);
    } finally { syncServer.closeAllConnections(); await new Promise<void>(resolve => { syncServer.close(() => resolve()); setTimeout(resolve, 2_000).unref(); }); await rm(cwd, { recursive: true, force: true }); }

    // The watch supervisor's containment revalidation reads the same view (the source carries
    // both workspace reads, and master status's read rides the coordination header from the
    // report-cache module).
    const workspaceSource = await readFile(new URL('../src/cli/workspace.ts', import.meta.url), 'utf8');
    assert.equal(workspaceSource.split('work-snapshot?view=coordination').length - 1, 2, 'sync attribution and containment revalidation read the coordination view');
    assert.doesNotMatch(workspaceSource, /work-snapshot\?view=bounded/, 'no CLI read asks for the unbounded default');
    const statusSource = await readFile(new URL('../src/cli/master-status.ts', import.meta.url), 'utf8');
    assert.match(statusSource, /coordinationStep\(run => timedStep\('snapshot', run\), masterApi\)/, 'master status reads through the coordination snapshot step');
    const stepSource = await readFile(new URL('../src/cli/coordination-snapshot.ts', import.meta.url), 'utf8');
    assert.match(stepSource, /read\('work-snapshot', undefined, undefined, \{ \[coordinationViewHeader\]: 'coordination' \}\)/, 'the coordination step sends the coordination header');
  } finally { await control.close(); await disposeFixture(); }
});

test('unit:work-snapshot-paged — GET /api/work-snapshot supports paging with cursor and pageSize', async () => {
  for (let index = 0; index < 30; index++) {
    const item = await engine.execute(operator, 'create', null, {
      title: `Paged item ${index + 1}`, plannedFiles: ['src/'],
      criteria: [{ id: 'AC-1', text: 'test', proofs: ['unit:test'] }],
    }, randomUUID()) as Work;
    if (index % 3 === 0) await engine.execute(operator, 'ready', item.id, {}, randomUUID());
  }
  const keys = (body: any) => (body.work as Work[]).map(item => Number((/(\d+)$/.exec(item.key ?? '') ?? [])[1]));
  const whole = await get('work-snapshot?view=full');
  const defaultWhole = await get('work-snapshot');
  const every = keys(whole.body).sort((a, b) => a - b);
  assert.equal(every.length, 30, 'the ledger holds the items');
  assert.equal(whole.body.view, undefined, 'the full view response is unchanged');
  assert.equal(defaultWhole.body.view, 'bounded', 'the default view response is unchanged');
  assert.equal(defaultWhole.body.hasMore, undefined, 'an unpaged response carries no paging fields');
  assert.equal(defaultWhole.body.nextCursor, undefined, 'an unpaged response names no cursor');

  // A paged walk of the full view covers every item exactly once, in order.
  const walked: number[] = []; let cursor: number | undefined; let pages = 0;
  while (true) {
    const page = await get(`work-snapshot?view=full&pageSize=7${cursor === undefined ? '' : `&cursor=${cursor}`}`);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    const numbers = keys(page.body);
    assert.ok(numbers.length <= 7 && numbers.length > 0, 'each page carries at most pageSize items');
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), 'each page is ordered by work number');
    walked.push(...numbers);
    pages++;
    if (!page.body.hasMore) { assert.equal(page.body.nextCursor, undefined, 'the last page names no next cursor'); break; }
    assert.equal(page.body.nextCursor, numbers.at(-1), 'the next cursor is the page it ended on');
    cursor = page.body.nextCursor;
    assert.ok(pages < 10, 'the walk terminates');
  }
  assert.deepEqual(walked.sort((a, b) => a - b), every, 'the paged walk covers every item exactly once');
  assert.ok(pages > 1, 'the walk took more than one page');

  // The default (bounded) view pages the same way, and never invents or loses items.
  const boundedPage = await get('work-snapshot?pageSize=5');
  assert.equal(boundedPage.body.view, 'bounded');
  assert.equal(keys(boundedPage.body).length, 5);
  assert.equal(boundedPage.body.hasMore, true);
  assert.equal(boundedPage.body.nextCursor, keys(boundedPage.body).at(-1));

  // A page is chosen in the database: it reads only its own documents, however large the ledger
  // grows. Every row the store returns while one page is answered is counted by whether it
  // carries a document (or a settled summary), and that count stays at pageSize as the ledger doubles.
  const documentsReadFor = async (path: string) => {
    const pool = store.pool as any, original = { query: pool.query, connect: pool.connect };
    let documents = 0;
    const count = (result: any) => { for (const row of result?.rows ?? []) if (row && 'document' in row) documents++; return result; };
    pool.query = function (...args: any[]) { return original.query.apply(this, args).then(count); };
    // pg's own pool.query checks a client out through connect(callback); only promise callers are wrapped.
    pool.connect = async function (...args: any[]) {
      if (args.length) return original.connect.apply(this, args);
      const client = await original.connect.call(this), query = client.query;
      client.query = function (...args: any[]) { return query.apply(this, args).then(count); };
      const release = client.release;
      client.release = function (...args: any[]) { client.query = query; client.release = release; return release.apply(this, args); };
      return client;
    };
    try { const page = await get(path); assert.equal(page.status, 200, JSON.stringify(page.body)); return { documents, items: keys(page.body).length }; }
    finally { pool.query = original.query; pool.connect = original.connect; }
  };
  await get('work-snapshot?view=full');
  const before = { full: await documentsReadFor('work-snapshot?view=full&pageSize=7&cursor=3'), bounded: await documentsReadFor('work-snapshot?pageSize=7&cursor=3') };
  for (let index = 0; index < 30; index++) {
    await engine.execute(operator, 'create', null, { title: `Growth item ${index + 1}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'test', proofs: ['unit:test'] }] }, randomUUID());
  }
  await get('work-snapshot?view=full');
  const grown = { full: await documentsReadFor('work-snapshot?view=full&pageSize=7&cursor=3'), bounded: await documentsReadFor('work-snapshot?pageSize=7&cursor=3') };
  for (const view of ['full', 'bounded'] as const) {
    assert.deepEqual(before[view], { documents: 7, items: 7 }, `a ${view} page reads only its own seven documents`);
    assert.deepEqual(grown[view], before[view], `a ${view} page reads no more once the ledger doubles`);
  }

  // A scoped operator agent's page is chosen from its own work: the rows, `hasMore` and the cursor
  // disclose nothing of the items outside its scope.
  const scopedKeys = [whole.body.work[4].key, whole.body.work[20].key] as string[];
  const scopedToken = `bounded-scoped-reader-${'s'.repeat(32)}`;
  const provisioned = await fetch(`${url}/api/operator-agents`, { method: 'POST', headers: { Authorization: `Bearer ${operatorToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ id: 'scoped-reader', displayName: 'scoped-reader', capabilities: ['intent:create'], scope: { repositories: ['owner/project'], workItems: scopedKeys }, token: scopedToken, reason: 'A scoped reader pages only its own work' }) });
  assert.equal(provisioned.status, 200, await provisioned.text());
  const scopedNumbers = scopedKeys.map(key => Number(/(\d+)$/.exec(key)![1]));
  const firstScoped = await get('work-snapshot?view=full&pageSize=1', scopedToken);
  assert.equal(firstScoped.status, 200, JSON.stringify(firstScoped.body));
  assert.deepEqual(keys(firstScoped.body), [scopedNumbers[0]], 'a scoped page holds the first visible item, not an empty page');
  assert.equal(firstScoped.body.nextCursor, scopedNumbers[0], 'the cursor names only visible work');
  const lastScoped = await get(`work-snapshot?view=full&pageSize=1&cursor=${scopedNumbers[0]}`, scopedToken);
  assert.deepEqual(keys(lastScoped.body), [scopedNumbers[1]]);
  assert.equal(lastScoped.body.hasMore, false, 'no page is promised beyond the visible work');
  assert.equal(lastScoped.body.nextCursor, undefined);

  // Paging is opt-in and validated; the coordination view stays the loop's unpaged poll.
  assert.equal((await get('work-snapshot?pageSize=0')).status, 400);
  assert.equal((await get('work-snapshot?pageSize=1001')).status, 400);
  assert.equal((await get('work-snapshot?cursor=-1')).status, 400);
  assert.equal((await get('work-snapshot?cursor=soon')).status, 400);
  assert.equal((await get('work-snapshot?view=coordination&pageSize=5')).status, 400);
  const coordination = await get('work-snapshot?view=coordination');
  assert.equal(coordination.body.view, 'coordination');
  assert.equal(keys(coordination.body).length, 60, 'the coordination view is not paged');
  assert.equal(coordination.body.hasMore, undefined, 'the coordination view carries no paging fields');
});
