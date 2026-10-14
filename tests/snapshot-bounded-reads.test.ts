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
      // The worker names its item; the CLI reads that one document, never the fleet (GY-1377).
      if (path === '/api/work') { control.state.violations.push('fleet read (GET /api/work)'); response.statusCode = 500; return response.end('{"error":"fleet reads are refused here"}'); }
      if (path === '/api/work/GY-1') return response.end(JSON.stringify(task));
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

test('integration:api-work-bounded-read — GET /api/work serves the fleet (open items whole, settled deliveries as their stored summaries) and ?pr=N only the item naming that pull request, without reading a settled document whole', async () => {
  // A fleet in production's shape (GY-1778): over a thousand settled deliveries, each weighing
  // what its session history weighs, behind a handful of open items. store.list() served every
  // one of them whole: 134 MB, past the CI plan's abort on every acceptance run.
  const heavy = 'h'.repeat(16 * 1024), settledCount = 1000, now = Date.now();
  const stamp = (offsetMs = 0) => new Date(now - offsetMs).toISOString();
  const document = (index: number, overrides: Record<string, unknown>) => ({
    id: randomUUID(), key: `GY-${5000 + index}`, title: `Fleet item ${index}`, plannedFiles: ['src/'], dependencies: [], criteria: [{ id: 'AC-1', text: 'test', proofs: ['unit:test'] }],
    gates: [], violations: [], workspaces: [], evidence: [], policy: { checks: [], review: false }, revision: 3, policyRevision: 1, epoch: 1, lease: null,
    actionQueue: { actions: [], history: [] }, reworkRequested: false, scenarioRequirements: [], observation: null, ready: true, blocker: null, priority: 1,
    createdAt: stamp(3 * 86_400_000), updatedAt: stamp(86_400_000), stageEnteredAt: stamp(86_400_000),
    sessions: [{ id: `worker:${index}`, kind: 'implementation', state: 'finished', principal: 'worker', startedAt: stamp(2 * 86_400_000), endedAt: stamp(2 * 86_400_000), updatedAt: stamp(2 * 86_400_000), outcome: heavy }],
    ...overrides,
  });
  // Every tenth delivery was settled without a candidate, its submission alone naming its pull
  // request: the shape tests/master-verification.test.ts delivers, which the index's `pr` column
  // (the candidate's) never carries.
  const settled = Array.from({ length: settledCount }, (_, index) => document(index, { stage: 'done', candidate: index % 10 === 5 ? null : { sha: hex('c'), baseSha: hex('b'), pr: 3000 + index }, submission: { epoch: 1, pr: 3000 + index }, delivery: { mergeSha: hex('a'), mergedAt: stamp(86_400_000) } }));
  const candidateOpen = document(settledCount, { stage: 'build', candidate: { sha: hex('d'), baseSha: hex('b'), pr: 7777 }, submission: { epoch: 1, pr: 7777 }, lease: { owner: 'worker', epoch: 1, expiresAt: stamp(-600_000) } });
  const submittedOpen = document(settledCount + 1, { stage: 'build', candidate: null, submission: { epoch: 1, pr: 7778 }, lease: { owner: 'worker', epoch: 1, expiresAt: stamp(-600_000) } });
  await store.pool.query('INSERT INTO work_items(id, document) SELECT (d->>\'id\')::uuid, d FROM jsonb_array_elements($1::jsonb) AS d', [JSON.stringify([...settled, candidateOpen, submittedOpen])]);
  assert.equal(Number((await store.pool.query('SELECT count(*) FROM work_index WHERE settled')).rows[0].count), settledCount, 'the work index holds every settled delivery as settled');

  // Every row the store returns while a route answers is watched: a settled document read whole
  // carries its session history, which its stored summary (no running session, settled) does not.
  const settledReadWhole = async <T>(run: () => Promise<T>) => {
    const pool = store.pool as any, original = { query: pool.query, connect: pool.connect };
    let whole = 0;
    const count = (result: any) => { for (const row of result?.rows ?? []) if (row?.document?.stage === 'done' && Array.isArray(row.document.sessions) && row.document.sessions.length) whole++; return result; };
    pool.query = function (...args: any[]) { return original.query.apply(this, args).then(count); };
    pool.connect = async function (...args: any[]) {
      if (args.length) return original.connect.apply(this, args);
      const client = await original.connect.call(this), query = client.query;
      client.query = function (...args: any[]) { return query.apply(this, args).then(count); };
      const release = client.release;
      client.release = function (...args: any[]) { client.query = query; client.release = release; return release.apply(this, args); };
      return client;
    };
    try { return { result: await run(), whole }; } finally { pool.query = original.query; pool.connect = original.connect; }
  };
  const items = (body: any) => body as (Work & { summary?: boolean; sessions?: unknown[] })[];

  // The unfiltered form: the fleet GY-1376 defined, every settled delivery as its summary.
  const fleet = await settledReadWhole(() => get('work'));
  assert.equal(fleet.result.status, 200, JSON.stringify(fleet.result.body).slice(0, 300));
  const served = items(fleet.result.body), servedSettled = served.filter(item => item.stage === 'done');
  assert.ok(servedSettled.length >= settledCount, `the fleet carries every settled delivery (${servedSettled.length})`);
  assert.ok(served.some(item => item.key === candidateOpen.key && item.sessions?.length === 1), 'an open item is served whole, its sessions included');
  assert.ok(servedSettled.every(item => !(item.sessions?.length) && !JSON.stringify(item).includes(heavy)), 'a settled delivery is served as its stored summary, never its history');
  assert.equal(fleet.whole, 0, 'the fleet read reads no settled document whole');
  assert.ok(fleet.result.bytes < settledCount * heavy.length / 4, `the fleet weighs ${fleet.result.bytes} bytes against ${settledCount * heavy.length} bytes of settled history behind it`);

  // The filtered form: the item whose candidate or submission names the pull request, and nothing else.
  const byCandidate = await settledReadWhole(() => get('work?pr=7777'));
  assert.deepEqual(items(byCandidate.result.body).map(item => item.key), [candidateOpen.key], 'the pull request\'s candidate item, whole');
  assert.equal(items(byCandidate.result.body)[0].sessions?.length, 1);
  assert.equal(byCandidate.whole, 0, 'the filtered read reads no settled document whole');
  const bySubmission = await settledReadWhole(() => get('work?pr=7778'));
  assert.deepEqual(items(bySubmission.result.body).map(item => item.key), [submittedOpen.key], 'an item whose submission alone names the pull request is found');
  assert.equal(bySubmission.whole, 0);
  const settledMatch = await settledReadWhole(() => get('work?pr=3006'));
  assert.deepEqual(items(settledMatch.result.body).map(item => [item.key, item.stage, item.sessions?.length ?? 0]), [[settled[6].key, 'done', 0]], 'a settled match is its stored summary');
  assert.equal(settledMatch.whole, 0);
  assert.equal((settled[5] as { candidate?: unknown }).candidate, null, 'the fixture settles item 5 without a candidate');
  const settledBySubmission = await settledReadWhole(() => get('work?pr=3005'));
  assert.deepEqual(items(settledBySubmission.result.body).map(item => [item.key, item.stage, item.candidate, item.submission?.pr, item.sessions?.length ?? 0]), [[settled[5].key, 'done', null, 3005, 0]], 'a delivery settled without a candidate, its submission alone naming the pull request, is found as its stored summary');
  assert.equal(settledBySubmission.whole, 0, 'the submission match reads no settled document whole');
  const none = await settledReadWhole(() => get('work?pr=99999'));
  assert.deepEqual(none.result.body, [], 'a pull request no item names answers an empty list');
  assert.equal(none.whole, 0);
  assert.equal((await get('work?pr=abc')).status, 400);
  assert.equal((await get('work?pr=0')).status, 400);
  assert.equal((await get('work?pr=-7')).status, 400);

  // The settled fleet behind both forms: the route this replaced read all of it whole.
  const listed = await settledReadWhole(() => store.list());
  assert.ok(listed.whole >= settledCount, `store.list() reads every settled document whole (${listed.whole}); the route no longer does`);
});
