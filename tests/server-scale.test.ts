import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { isSummary } from '../src/model/work-summary.js';
import { buildMasterStatus, masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, writeDaemonState } from '../src/master-daemon.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { boardFromStatus } from '../src/model/board.js';
import { views } from '../web/pages/index.js';
import WorkDetails from '../web/pages/work-details.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import { unknownFeatures } from '../web/features.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-422. On 2026-09-25, after a day of 2,000+ sessions, 180 new items and 137 closures, the routes
 * every reader polls had grown with history: GET /api/interventions?window=7 failed after 36 s on a
 * statement timeout the log did not attribute, GET /api/work-snapshot answered 22 MB in 47 s, and
 * `master status` returned nothing because one panel's route failed.
 *
 * This file seeds a store of that shape and larger — 200,000 ledger events over 120 days, 600
 * delivered or closed items holding 3,000 finished sessions between them (five attempts each), 170
 * open items — on the test Postgres, and holds each route to its budget over it. The live store
 * had about 420 items when it was measured.
 */

const coordinator: Principal = { id: 'coordinator-1', role: 'coordinator' };
const admin: Principal = { id: 'operator', role: 'admin' };
const tokens = { coordinator: 'c'.repeat(32), admin: 'a'.repeat(32) };
const EVENTS = 200_000, SETTLED = 600, OPEN = 170, SESSIONS_PER_SETTLED = 5;
const hour = 3_600_000, day = 24 * hour;

let database: EmbeddedPostgres; let store: Store; let engine: Engine; let databaseUrl: string;
let http: ReturnType<typeof server>; let url: string;
let seededAt: number;

const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const sha = (index: number, salt: string) => `${salt}${String(index).padStart(39, '0')}`.slice(0, 40);
const iso = (ms: number) => new Date(ms).toISOString();

/** A document as the control plane keeps it; a delivered one carries its whole history. */
function document(index: number, settled: boolean, now: number): Work {
  const key = `GY-${index}`, created = now - (index % 120) * day - 6 * hour;
  const session = (n: number, state: string) => ({ id: `graphyard-worker-${n}:${index}`, kind: 'implementation', state, host: 'machine-a', runtime: 'claude', principal: `graphyard-worker-${n}`,
    startedAt: iso(created + n * hour), endedAt: state === 'running' ? null : iso(created + (n + 1) * hour), updatedAt: iso(created + (n + 1) * hour), subject: `${key}: an item of the seeded history`,
    outcome: state === 'running' ? null : `the attempt ended: ${'x'.repeat(120)}`, launch: sha(n, 'l').slice(0, 32), workspace: 'w1', pane: null, tab: null, attach: null, agentName: null, role: null, epoch: n, head: null, transcript: null });
  const evidence = (n: number) => ({ id: uuid(index * 100 + n), proof: `unit:proof-${n}`, sha: sha(index * 10 + n, 'e'), baseSha: sha(index, 'b'), policyRevision: 1, result: 'pass', executed: 12, skipped: 0,
    producer: 'ci-runner', trusted: true, at: iso(created + n * hour), artifacts: Array.from({ length: 4 }, (_, a) => ({ name: `report-${a}.json`, sha256: sha(a, 'a'), bytes: 2048 })),
    scopeFiles: Array.from({ length: 6 }, (_, f) => ({ path: `src/module-${f}.ts`, digest: sha(f, 'd') })), provenance: { runner: 'github-actions', run: index * 10 + n, attempt: 1 } });
  const candidate = { sha: sha(index, 'c'), baseSha: sha(index, 'b'), pr: 1000 + index };
  const base = {
    id: uuid(index), key, title: `Item ${key} of the seeded history`, description: `What ${key} was for. `.repeat(20), type: 'feature', priority: 2, dependencies: index > 2 ? [uuid(index - 1)] : [],
    criteria: [{ id: 'AC-1', text: `The behaviour ${key} asked for holds`, proofs: ['unit:proof-1'] }], policy: { checks: ['test'], review: true }, 
    revision: 40, policyRevision: 1, createdAt: iso(created), updatedAt: iso(created + 5 * hour), stageEnteredAt: iso(created + 5 * hour), ready: true, epoch: SESSIONS_PER_SETTLED,
    workspaces: Array.from({ length: 2 }, (_, w) => ({ host: 'machine-a', path: `/srv/worktrees/${key}-${w + 1}`, epoch: w + 1, owner: 'graphyard-worker-1', branch: `graphyard/${key.toLowerCase()}-${w + 1}` })),
    candidate, submission: { epoch: SESSIONS_PER_SETTLED, pr: candidate.pr }, reworkRequested: false, scenarioRequirements: [], blocker: null, gates: [], violations: [],
    observation: { prState: 'closed', merged: settled, mergeSha: settled ? sha(index, 'm') : null, mergedAt: settled ? iso(created + 5 * hour) : null, mergeable: true, protected: true, candidate, checks: [{ name: 'test', result: 'success', appId: 15368 }],
      reviews: [{ reviewer: 'reviewer[bot]', sha: candidate.sha, state: 'APPROVED' }], files: ['src/module-1.ts'], at: iso(created + 5 * hour), scopeFiles: Array.from({ length: 20 }, (_, f) => ({ path: `src/module-${f}.ts`, status: 'modified', digest: sha(f, 's') })) },
    pipeline: { attempts: Array.from({ length: SESSIONS_PER_SETTLED }, (_, a) => ({ epoch: a + 1, claimedAt: iso(created + a * hour), submittedAt: iso(created + (a + 1) * hour), outcome: 'rework' })), submittedAt: iso(created + hour), reworkRounds: 2, interventions: { blocked: 0, requirements: 0 }, backfill: { truncated: false, events: 10, fromEvent: 1, toEvent: 10, retained: 10, passes: 1 } },
  };
  if (settled) return {
    ...base, stage: 'done', lease: null, closure: index % 5 === 0 ? { reason: 'superseded by a later item', by: 'operator', at: iso(created + 5 * hour) } : null,
    delivery: index % 5 === 0 ? undefined : { mergedAt: iso(created + 5 * hour), mergeSha: sha(index, 'm'), authorizationRevision: 1 },
    evidence: Array.from({ length: 6 }, (_, n) => evidence(n)), sessions: Array.from({ length: SESSIONS_PER_SETTLED }, (_, n) => session(n + 1, 'finished')),
    actionQueue: { actions: [], history: Array.from({ length: 12 }, (_, n) => ({ id: `${key}:review:${n}`, kind: 'review', state: 'done', result: 'done', requestedAt: iso(created + n * hour), resolvedAt: iso(created + n * hour + 60_000), resolution: 'approved', history: Array.from({ length: 4 }, (_, h) => ({ at: iso(created + n * hour + h), executor: 'executor-1', result: 'done' })) })) },
  } as unknown as Work;
  return { ...base, stage: 'build', lease: null, evidence: [evidence(1)], sessions: [session(1, 'finished')], observation: null, candidate: null, submission: null, pipeline: { ...base.pipeline, attempts: [] } } as unknown as Work;
}

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 422;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('scale'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_scale');
  databaseUrl = `postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_scale`;
  store = new Store(databaseUrl);
  await store.init();
  engine = new Engine(store, 120, 'owner/project');
  http = server(engine, [{ ...coordinator, token: tokens.coordinator }, { ...admin, token: tokens.admin }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  seededAt = Date.now();
  // 1,000 settled deliveries and closures, then 170 open items, as whole documents.
  const documents = [...Array.from({ length: SETTLED }, (_, index) => document(index + 1, true, seededAt)), ...Array.from({ length: OPEN }, (_, index) => document(SETTLED + index + 1, false, seededAt))];
  for (let from = 0; from < documents.length; from += 100)
    await store.pool.query('INSERT INTO work_items(id, document) SELECT (d->>\'id\')::uuid, d FROM jsonb_array_elements($1::jsonb) AS d', [JSON.stringify(documents.slice(from, from + 100))]);
  // 200,000 ledger rows over 120 days: routine observations and heartbeats, blocked reports and
  // their clearing, and one recorded session nudge in forty — each half an hour off the hour, so no
  // row lies within seconds of a window's edge.
  await store.pool.query(`INSERT INTO events(work_id, actor, kind, payload, created_at)
    SELECT w.id, 'graphyard', k.kind,
      CASE k.kind
        WHEN 'intervention.recorded' THEN jsonb_build_object('id', gen_random_uuid(), 'kind', 'session-nudge', 'work', jsonb_build_object('id', w.id, 'key', 'GY-' || w.n, 'title', 'Item'), 'stage', 'build', 'blocked', 'a quiet session', 'since', to_char(t.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'at', to_char(t.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'resolution', 're-prompted')
        WHEN 'blocked' THEN jsonb_build_object('work', jsonb_build_object('key', 'GY-' || w.n, 'stage', 'build', 'title', 'Item', 'epoch', 1), 'details', jsonb_build_object('reason', 'waiting on a vendor', 'epoch', 1))
        WHEN 'unblock' THEN jsonb_build_object('work', jsonb_build_object('key', 'GY-' || w.n, 'stage', 'build', 'title', 'Item', 'epoch', 1), 'details', jsonb_build_object('reason', 'the vendor answered'))
        ELSE jsonb_build_object('details', jsonb_build_object('pass', g)) END,
      t.at
    FROM generate_series(1, $1::int) AS g
    CROSS JOIN LATERAL (SELECT (g % ${SETTLED + OPEN}) + 1 AS n) AS pick
    CROSS JOIN LATERAL (SELECT ('00000000-0000-4000-8000-' || lpad(pick.n::text, 12, '0'))::uuid AS id, pick.n) AS w
    CROSS JOIN LATERAL (SELECT CASE WHEN g % 40 = 0 THEN 'intervention.recorded' WHEN g % 40 = 1 THEN 'blocked' WHEN g % 40 = 2 THEN 'unblock' WHEN g % 2 = 0 THEN 'github.observed' ELSE 'heartbeat' END AS kind) AS k
    CROSS JOIN LATERAL (SELECT to_timestamp($2::double precision / 1000) - ((g % 2880) * interval '1 hour') - interval '30 minutes' AS at) AS t`, [EVENTS, seededAt]);
  await store.pool.query('ANALYZE');
});
after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
  if (database) await database.stop();
});

async function read(path: string, token = tokens.coordinator) {
  const started = performance.now();
  const response = await fetch(`${url}/api/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await response.text();
  return { status: response.status, ms: performance.now() - started, bytes: Buffer.byteLength(text), body: JSON.parse(text) };
}

function dashboard(work: Work[], now: number, overrides: Partial<Dashboard> = {}): Dashboard {
  const noop = () => {};
  const status = { actor: { id: 'operator', role: 'admin' }, humanOnly: [], executors: { live: 0, liveMs: 60_000, served: [], unserved: [], attention: [] }, delegation: null, github: false, reviewProviders: ['github'], reviewerApps: [], jobs: [], heldJobs: 0, now: iso(now) };
  const d: Dashboard = {
    token: 'scale', work, status, error: '', connected: true, lastUpdated: '12:00:00', view: 'work', setView: noop, filter: null, setFilter: noop,
    selected: null, setSelected: noop, creating: false, setCreating: noop, busy: false, setBusy: noop, observedAt: now, jobs: [], query: '', setQuery: noop,
    operatorAgents: [], operatorAgentsError: null, features: unknownFeatures, events: [], editingRequirements: false, setEditingRequirements: noop, codexAvailable: false,
    sessionEpoch: { current: 0 }, api: async () => ({}), refresh: async () => {}, action: async () => {}, setError: noop, signOut: noop, ...overrides,
  };
  return { ...d, board: boardFromStatus(work, now, status) };
}

test('unit:snapshot-bounded — the work snapshot sends open items whole and settled deliveries as summaries, under 3 MB and within 3 s over the seeded store; each item\'s history is read on request, and the loop, master status and the dashboard render from the summary', async () => {
  const whole = await read('work-snapshot?view=full');
  assert.ok(whole.bytes > 3_000_000, `the seeded history is heavy: the whole-document export is ${whole.bytes} bytes`);

  const snapshot = await read('work-snapshot');
  assert.equal(snapshot.status, 200);
  assert.ok(snapshot.bytes < 3_000_000, `GET /api/work-snapshot is ${snapshot.bytes} bytes`);
  assert.ok(snapshot.ms < 3_000, `GET /api/work-snapshot took ${Math.round(snapshot.ms)}ms`);
  const work = snapshot.body.work as Work[];
  assert.equal(work.length, SETTLED + OPEN, 'every item is in the snapshot');
  assert.equal(snapshot.body.view, 'bounded');

  // Settled deliveries and closures: key, stage and delivery, and none of their history.
  const summaries = (work as unknown[]).filter(isSummary);
  assert.equal(summaries.length, SETTLED);
  for (const entry of summaries) {
    assert.equal(entry.stage, 'done');
    assert.ok(entry.key && entry.title && entry.id);
    assert.equal(Object.hasOwn(entry, 'description'), false, `${entry.key} carries no description`);
    // Its histories are bounded: sessions of the last day only (the seeded ones are months old),
    // no resolved action rows but their count, evidence only where it binds the candidate and
    // without artifacts, and the timeline as the speed report reads it.
    assert.ok(entry.sessions!.every(handle => Date.parse(handle.endedAt ?? '') >= seededAt - day), `${entry.key} keeps only sessions that ended in the last day`);
    assert.deepEqual(entry.actionQueue!.history, []);
    assert.equal(entry.completedActions, 12);
    assert.ok(entry.evidence!.every(record => !('artifacts' in record)));
    assert.equal(entry.pipeline!.attempts.length, SESSIONS_PER_SETTLED);
    assert.deepEqual(Object.keys(entry.pipeline!.attempts[0]).sort(), ['claimedAt', 'endedAt']);
  }
  const recent = summaries.flatMap(entry => entry.sessions!);
  assert.ok(recent.length > 0 && recent.length <= 2 * SESSIONS_PER_SETTLED * Math.ceil(SETTLED / 120), `the last day's ${recent.length} sessions of settled items are kept for the Workers page, not the 3,000 before them`);
  const delivered = summaries.find(entry => entry.delivery)!, closed = summaries.find(entry => entry.closure)!;
  assert.equal(delivered.delivery!.mergeSha.length, 40);
  assert.equal(delivered.observation!.merged, true);
  assert.ok(!('scopeFiles' in delivered.observation!), 'the observation keeps its merge facts, not its per-file comparison');
  assert.equal(closed.closure!.reason, 'superseded by a later item');

  // Open items are whole, exactly as stored.
  const open = work.filter(entry => !isSummary(entry));
  assert.equal(open.length, OPEN);
  const stored = (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [open[0].id])).rows[0].document;
  assert.deepEqual(open[0], stored);

  // A settled item's history is available on request, by id or key.
  const history = await read(`work/${delivered.key}`);
  assert.equal(history.status, 200);
  assert.equal(history.body.sessions.length, SESSIONS_PER_SETTLED);
  assert.equal(history.body.evidence.length, 6);
  assert.equal((await read(`work/${delivered.id}`)).body.key, delivered.key);
  assert.equal((await read('work/GY-999999')).status, 404);

  // The loop polls the coordination view, which is unchanged; the bounded snapshot is what its
  // guarded merge re-reads, and the status rows it builds from it are those of the open items.
  const rows = buildMasterStatus({ work, now: snapshot.body.now }, [], []);
  assert.equal(rows.work.filter((row: { stage: string }) => row.stage !== 'done').length, OPEN);

  // The dashboard: every page renders from the summaries, and a settled item's page renders from
  // the document read on request.
  const now = Date.parse(snapshot.body.now);
  for (const view of views) assert.doesNotThrow(() => renderToStaticMarkup(createElement('div', null, view.render(dashboard(work, now, { view: view.id })))), `the ${view.id} page renders`);
  const page = renderToStaticMarkup(createElement(WorkDetails, { ...dashboard(work, now), item: history.body as Work }));
  assert.match(page, new RegExp(delivered.key));
});

function masterConfig(credentialFile: string, worktreeRoot: string): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:9', credentialFile, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [], run: { worktreeRoot } });
}

test('unit:status-degrades-per-section — master status returns every section from the bounded snapshot; a failed request is logged with its route and the SQL statement that timed out', async () => {
  const root = await temporaryDirectory('scale-root'), secrets = await temporaryDirectory('scale-secrets');
  try {
    execFileSync('git', ['init', '-q', root]);
    const credential = join(secrets, 'coordinator.token');
    await writeFile(credential, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const master = masterConfig(credential, join(secrets, 'checkouts'));
    await writeDaemonState(master, emptyDaemonState(master));
    // The real server over the seeded store.
    const masterApi = async (path: string, _credential?: string, _timeoutMs?: number) => {
      const answer = await read(path);
      if (answer.status !== 200) throw new Error(`GET ${path} answered ${answer.status}`);
      return answer.body;
    };
    const status = (await read('status')).body;
    const started = Date.now();
    const report = await masterStatusReport(root, master, masterApi, status, { commit: null }) as Record<string, any>;
    assert.ok(Date.now() - started < 20_000, `master status returned in ${Date.now() - started}ms`);
    assert.deepEqual(report.unavailable, [], 'no section is unavailable');
    // Every section is there, built from the bounded snapshot.
    for (const section of ['work', 'counts', 'attentionItems', 'board', 'actions', 'sessions', 'requests', 'disk', 'daemon', 'dispatch', 'setup', 'liveness', 'actionless', 'runtime', 'timings'])
      assert.ok(section in report && report[section] !== undefined, `master status returned its ${section} section`);
    assert.ok(report.work.length >= OPEN, 'the open items are reported');

  } finally { await rm(root, { recursive: true, force: true }); await rm(secrets, { recursive: true, force: true }); }

  // The server's request error log names the route and the statement that timed out.
  const strict = new Store(databaseUrl);
  // The report runs on the report pool (GY-491), under its own statement timeout.
  strict.reportPool.options.statement_timeout = 1;
  const slowServer = server(new Engine(strict, 120, 'owner/project'), [{ ...coordinator, token: tokens.coordinator }]);
  await new Promise<void>(resolve => slowServer.listen(0, '127.0.0.1', resolve));
  const logged: string[] = [], original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    const response = await fetch(`http://127.0.0.1:${(slowServer.address() as AddressInfo).port}/api/analytics/attribution`, { headers: { Authorization: `Bearer ${tokens.coordinator}` } });
    assert.equal(response.status, 500);
  } finally {
    console.error = original;
    await new Promise<void>(resolve => slowServer.close(() => resolve()));
    await strict.close();
  }
  const line = logged.find(entry => entry.startsWith('request failed'));
  assert.ok(line, logged.join('\n'));
  assert.match(line, /^request failed GET \/api\/analytics\/attribution: canceling statement due to statement timeout \(statement: /);
});
