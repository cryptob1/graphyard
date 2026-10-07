import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { Store } from '../src/store.js';
import { main } from '../src/server/main.js';
import { GitHub } from '../src/github.js';
import { invalidateFlowReports, pooledFlowDrilldown, projectFlow } from '../src/flow-analytics.js';
import { daemonEffects, emptyDaemonState, runCycle, writeDaemonState, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { coordinationViewHeader } from '../src/server/work-view.js';
import { loopPresenceHeader } from '../src/model/executor-presence.js';
import type { Principal, Work } from '../src/model.js';
import { readStepRows } from '../web/step-moves.js';
import { mergeTime } from '../web/flow-analytics.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1383. On 2026-10-06 one browser dashboard — about 200 flow drill-downs per ten minutes, each
 * reading every open item's document — beside whole-fleet CLI reads pushed production into 502s
 * and lease-loss deadlocks: workers could not mint their push credentials inside their two-minute
 * lease. GY-1376 and GY-1377 narrowed those reads; nothing proved the plane holds when more than
 * one person uses it at once.
 *
 * This file runs the process entry (`main`, with its reconciliation tick) on a real Postgres
 * holding 1,500 work items and 500,000 ledger events, and for ten minutes puts on it what several
 * people and a full fleet do together:
 *
 *   - three dashboards, each polling as web/main.tsx does — the work snapshot, status and board
 *     every 5 s, and the step moves (web/step-moves.ts `readStepRows`, every steps page) every
 *     minute — two of them on the Flow page (the report and its merge-time drill-downs every
 *     30 s, web/flow-analytics.tsx `mergeTime`) and one opening a drill-down every 10 s;
 *   - ten workers, each claiming an item, renewing its lease every 30 s and minting its push
 *     credential after the claim and each renewal (src/cli/workspace.ts `watch`), releasing it
 *     after a few renewals and claiming the next;
 *   - the master loop cycling every 20 s (`runCycle` over the real routes, its default interval)
 *     and its dispatcher reading the coordination view every 10 s. The loop's writes are recorded,
 *     not applied: these workers have no Herdr panes for it to find, so it would otherwise end
 *     their attempts as dead sessions, which is the loop's decision and not the plane's load.
 *
 * GitHub answers from a fake with a fixed latency; the observation workers it would drive do not
 * run. No request may answer 5xx, the claim, renewal and push-credential p99 must stay under 2 s,
 * and no lease may lapse.
 */

const ITEMS = 1_500, OPEN = 150, SETTLED = ITEMS - OPEN, EVENTS = 500_000;
const DASHBOARDS = 3, WORKERS = 10, LOAD_MS = 10 * 60_000;
const SNAPSHOT_POLL_MS = 5_000, STEP_MOVES_POLL_MS = 60_000, FLOW_POLL_MS = 30_000, DRILL_MS = 10_000;
const HEARTBEAT_MS = 30_000, LOOP_MS = 20_000, DISPATCH_MS = 10_000, GITHUB_LATENCY_MS = 150;
const P99_BUDGET_MS = 2_000;
const SLICE = 'narrow-slice';
const hour = 3_600_000, day = 24 * hour;
const repository = 'owner/project';
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));

const credential = (id: string, role: Principal['role']) => ({ id, role, token: `${id}-token-`.padEnd(40, 'x') });
const operator = credential('operator', 'admin'), coordinator = credential('graphyard-master', 'coordinator');
const viewers = Array.from({ length: DASHBOARDS }, (_, index) => credential(`dashboard-${index + 1}`, 'admin'));
const workers = Array.from({ length: WORKERS }, (_, index) => credential(`graphyard-worker-${index + 1}`, 'worker'));
const credentials = [operator, coordinator, ...viewers, ...workers];

const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const sha = (index: number, salt: string) => `${salt}${String(index).padStart(39, '0')}`.slice(0, 40);
const iso = (ms: number) => new Date(ms).toISOString();

// ---- Every statement the server runs, and what it returned ---------------------------------------

/** The statements a `statements` call is collecting, in its own async context. */
const watching = new AsyncLocalStorage<{ text: string; rows: any[] }[]>();
/**
 * Installed before any pool opens a connection: each connection binds `query` when the pool opens
 * it (src/store/statements.ts), so a patch made later would never see that connection. A statement
 * is collected by the `statements` call it was made under, so the reconciliation tick running
 * beside it is not.
 */
{
  const original = pg.Client.prototype.query as (...args: any[]) => any;
  (pg.Client.prototype as any).query = function (this: unknown, ...args: any[]) {
    const seen = watching.getStore();
    if (!seen || typeof args[0]?.submit === 'function') return original.apply(this, args);
    const text = typeof args[0] === 'string' ? args[0] : String(args[0]?.text ?? '');
    const callback = typeof args.at(-1) === 'function' ? args.pop() : null;
    const promise = original.apply(this, args).then((result: any) => { for (const each of [result].flat()) seen.push({ text, rows: each?.rows ?? [] }); return result; });
    if (!callback) return promise;
    promise.then((result: any) => callback(null, result), (error: unknown) => callback(error));
  };
}
/** The statements `run` made, with their results. */
async function statements<T>(run: () => Promise<T>) {
  const seen: { text: string; rows: any[] }[] = [];
  return { value: await watching.run(seen, run), seen };
}

// ---- The seeded installation --------------------------------------------------------------------

/** A settled delivery as the control plane keeps it, with the history its attempts left. */
function delivered(n: number, now: number): Work {
  const key = `GY-${n}`, created = now - (n % 30) * day - 6 * hour, merged = created + 3 * hour;
  const candidate = { sha: sha(n, 'c'), baseSha: sha(n, 'b'), pr: 1000 + n };
  return {
    id: uuid(n), key, title: `Item ${key} of the seeded history`, description: `What ${key} was for. `.repeat(10), type: 'feature', priority: 2, dependencies: [],
    criteria: [{ id: 'AC-1', text: `The behaviour ${key} asked for holds`, proofs: ['unit:proof-1'] }], policy: { checks: ['test'], review: true },
    plannedFiles: [n === 1 ? `${SLICE}/delivered.ts` : 'src/module.ts'], revision: 30, policyRevision: 1, createdAt: iso(created), updatedAt: iso(merged), stageEnteredAt: iso(merged),
    ready: true, epoch: 2, stage: 'done', lease: null, workspaces: [{ host: 'machine-a', path: `/srv/worktrees/${key}-2`, epoch: 2, owner: 'graphyard-worker-1', branch: `graphyard/${key.toLowerCase()}-2` }],
    candidate, submission: { epoch: 2, pr: candidate.pr }, reworkRequested: false, scenarioRequirements: [], blocker: null, gates: [], violations: [], closure: null,
    delivery: { mergedAt: iso(merged), mergeSha: sha(n, 'm'), authorizationRevision: 1 },
    evidence: Array.from({ length: 3 }, (_, e) => ({ id: uuid(n * 10 + e + 5_000_000), proof: 'unit:proof-1', sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 1, result: 'pass', executed: 12, skipped: 0, producer: 'ci-runner', trusted: true, at: iso(created + 2 * hour) })),
    observation: { prState: 'closed', merged: true, mergeSha: sha(n, 'm'), mergedAt: iso(merged), mergeable: true, protected: true, candidate, checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'graphyard-reviewer[bot]', sha: candidate.sha, state: 'APPROVED' }], files: [n === 1 ? `${SLICE}/delivered.ts` : 'src/module.ts'], at: iso(merged) },
    sessions: Array.from({ length: 2 }, (_, s) => ({ id: `graphyard-worker-1:${n}:${s}`, kind: 'implementation', state: 'finished', host: 'machine-a', runtime: 'claude', principal: 'graphyard-worker-1', startedAt: iso(created + s * hour), endedAt: iso(created + (s + 1) * hour), updatedAt: iso(created + (s + 1) * hour), subject: `${key}: seeded`, outcome: 'the attempt ended', launch: sha(s, 'l').slice(0, 32), workspace: 'w1', pane: null, tab: null, attach: null, agentName: null, role: null, epoch: s + 1, head: null, transcript: null })),
    pipeline: { attempts: [1, 2].map(epoch => ({ epoch, claimedAt: iso(created + (epoch - 1) * hour), endedAt: iso(created + epoch * hour), end: epoch === 1 ? 'rework' : 'submitted' })), submittedAt: iso(created + 2 * hour), reworkRounds: 1, interventions: { blocked: 0, requirements: 0 } },
    actionQueue: { actions: [], history: [] },
  } as unknown as Work;
}

let database: EmbeddedPostgres; let databaseUrl: string;
let instance: Awaited<ReturnType<typeof main>>; let url: string;
let openItems: Work[] = [];
const sliceItems: string[] = [];
let mints = 0;
const savedEnv: Record<string, string | undefined> = {};
const scratch: string[] = [];

/** GitHub as the push-credential mint and the status route read it, each answer after `GITHUB_LATENCY_MS`. */
function fakeGitHub() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const github = new GitHub({ repository, base: 'main', appId: 1234, installationId: 5678, privateKey });
  const permissions = { contents: 'write', pull_requests: 'write', workflows: 'write', issues: 'write', checks: 'write', metadata: 'read' };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  github.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    await sleep(GITHUB_LATENCY_MS);
    const path = new URL(String(input)).pathname;
    if (path === '/app/installations/5678/access_tokens') {
      if (init?.body) mints++;
      return json(201, { token: `ghs_${randomUUID().replaceAll('-', '')}`, expires_at: iso(Date.now() + hour), permissions });
    }
    if (path === '/app/installations/5678') return json(200, { id: 5678, account: { login: 'owner' }, permissions });
    if (path === '/installation/repositories') return json(200, { total_count: 1, repositories: [{ id: 1, full_name: repository }] });
    if (path === `/repos/${repository}/rules/branches/main`) return json(200, []);
    return json(404, { message: 'Not Found' });
  }) as typeof fetch;
  return github;
}

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1383;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('plane-load'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_plane_load');
  databaseUrl = `postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_plane_load`;

  // 1,350 settled deliveries, as whole documents, and the facts their flow left: created, at Review,
  // at Merge, merged and delivered, over the last 30 days; and 20,000 check runs in the last week.
  const now = Date.now();
  const seeding = new Store(databaseUrl);
  await seeding.init();
  const documents = Array.from({ length: SETTLED }, (_, index) => delivered(index + 1, now));
  for (let from = 0; from < documents.length; from += 100)
    await seeding.pool.query("INSERT INTO work_items(id, document) SELECT (d->>'id')::uuid, d FROM jsonb_array_elements($1::jsonb) AS d", [JSON.stringify(documents.slice(from, from + 100))]);
  await seeding.pool.query(`INSERT INTO flow_facts(work_id,work_key,kind,observed_at,recorded_at,source,source_event,stage,work_type,slices,details,dedupe)
    SELECT w.id, w.document->>'key', f.kind, f.at, f.at, 'graphyard', 0, f.stage, 'feature', CASE WHEN w.number = 1 THEN ARRAY[$1] ELSE ARRAY['src'] END, f.details, concat(f.kind, ':', w.id, ':', f.ordinal)
    FROM work_items w CROSS JOIN LATERAL (SELECT (w.document->>'createdAt')::timestamptz AS created, (w.document->'candidate'->>'pr')::int AS pr) c
    CROSS JOIN LATERAL (VALUES
      (1, 'work.created', c.created, 'backlog', jsonb_build_object('type', 'feature', 'priority', 2)),
      (2, 'gates.changed', c.created + interval '1 hour', 'review', jsonb_build_object('stage', 'review', 'unmet', jsonb_build_array('review', 'acceptance', 'merge'), 'hasCandidate', true, 'released', true, 'pr', c.pr)),
      (3, 'gates.changed', c.created + interval '2 hours', 'merge', jsonb_build_object('stage', 'merge', 'unmet', jsonb_build_array('merge'), 'hasCandidate', true, 'released', true, 'pr', c.pr)),
      (4, 'merged', c.created + interval '3 hours', 'done', jsonb_build_object('pr', c.pr, 'mergeSha', w.document->'delivery'->>'mergeSha')),
      (5, 'delivered', c.created + interval '3 hours', 'done', jsonb_build_object('pr', c.pr, 'mergeSha', w.document->'delivery'->>'mergeSha')),
      (6, 'gates.changed', c.created + interval '3 hours', 'done', jsonb_build_object('stage', 'done', 'unmet', jsonb_build_array(), 'merged', true, 'hasCandidate', true, 'pr', c.pr))
    ) AS f(ordinal, kind, at, stage, details)`, [SLICE]);
  await seeding.pool.query(`INSERT INTO flow_facts(work_id,work_key,kind,observed_at,recorded_at,source,source_event,stage,work_type,slices,details,dedupe)
    SELECT w.id, w.document->>'key', 'check.observed', to_timestamp($1::double precision / 1000) - g * interval '30 seconds', to_timestamp($1::double precision / 1000), 'ci', 0, 'done', 'feature', ARRAY['src'],
      jsonb_build_object('name', 'test', 'result', 'success'), concat('check:', g)
    FROM generate_series(1, 20000) g JOIN work_items w ON w.number = 2 + g % ${SETTLED - 1}`, [now]);
  await seeding.close();

  // The process entry, as the deployment starts it, on this database.
  for (const name of ['DATABASE_URL', 'GRAPHYARD_PRINCIPALS', 'GITHUB_APP_ID', 'GITHUB_CI_APP_IDS']) savedEnv[name] = process.env[name];
  process.env.DATABASE_URL = databaseUrl; process.env.GRAPHYARD_PRINCIPALS = JSON.stringify(credentials);
  process.env.GITHUB_CI_APP_IDS = '15368'; delete process.env.GITHUB_APP_ID;
  instance = await main({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(instance.http.address() as AddressInfo).port}`;
  for (let waited = 0; !instance.isReady(); waited += 200) { assert.ok(waited < 120_000, 'startup validation finished'); await sleep(200); }
  // Workers mint through the control-plane App, which here answers from the fake.
  instance.http.services.github = fakeGitHub();

  // 150 open items, created and released as an operator does; two of them, and the first
  // delivery, in a slice of their own for the drill-down proof.
  const engine = instance.http.services.engine;
  for (let index = 0; index < OPEN; index++) {
    const area = index < 2 ? SLICE : `area-${index % 12}`;
    let work = await engine.execute(operator, 'create', null, { title: `Open item ${index + 1}`, plannedFiles: [`${area}/file-${index}.ts`],
      criteria: [{ id: 'AC-1', text: 'The plane carries it', proofs: ['integration:plane-load-multi-user'] }] }, randomUUID());
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    openItems.push(work);
  }
  sliceItems.push(uuid(1), openItems[0].id, openItems[1].id);
  while ((await projectFlow(instance.store)).processed > 0);

  // The ledger's history: 500,000 rows in all, routine observations and heartbeats with blocked
  // reports and their clearing among them, inside the retention window so compaction keeps them.
  const existing = Number((await instance.store.pool.query('SELECT count(*) FROM events')).rows[0].count);
  await instance.store.pool.query(`INSERT INTO events(work_id, actor, kind, payload, created_at)
    SELECT w.id, 'graphyard', k.kind,
      CASE WHEN k.kind IN ('blocked', 'unblock') THEN jsonb_build_object('work', jsonb_build_object('key', w.document->>'key', 'stage', 'build', 'title', 'Item', 'epoch', 1), 'details', jsonb_build_object('reason', 'waiting on a vendor', 'epoch', 1))
        ELSE jsonb_build_object('details', jsonb_build_object('pass', g)) END,
      to_timestamp($2::double precision / 1000) - (g % 1200) * interval '15 minutes' - interval '7 minutes'
    FROM generate_series(1, $1::int) AS g
    JOIN work_items w ON w.number = 1 + g % ${ITEMS}
    CROSS JOIN LATERAL (SELECT CASE WHEN g % 50 = 1 THEN 'blocked' WHEN g % 50 = 2 THEN 'unblock' WHEN g % 2 = 0 THEN 'github.observed' ELSE 'heartbeat' END AS kind) AS k`, [EVENTS - existing, now]);
  // The projection has read the history (it carries no work document to project).
  await instance.store.pool.query('UPDATE flow_projection SET last_event=(SELECT max(seq) FROM events) WHERE id=1');
  await instance.store.pool.query('ANALYZE');
});

after(async () => {
  if (instance) await instance.close();
  if (database) await database.stop();
  for (const [name, value] of Object.entries(savedEnv)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  for (const directory of scratch) await rm(directory, { recursive: true, force: true });
});

// ---- One reader's request, as each client makes it -----------------------------------------------

async function request(token: string, method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 60_000) {
  const started = performance.now();
  const response = await fetch(`${url}/api/${path}`, { method, signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, ms: performance.now() - started, body: text ? JSON.parse(text) : null };
}
/** A reader that throws on a refusal, as the dashboard's `api` does. */
const reader = (token: string) => async (path: string) => {
  const answer = await request(token, 'GET', path);
  if (answer.status >= 400) throw new Error(`GET ${path} answered ${answer.status}: ${JSON.stringify(answer.body).slice(0, 300)}`);
  return answer.body;
};

/**
 * One drill-down as GET /api/analytics/flow/drilldown answers `path` (src/server/routes/flow-analytics.ts),
 * made in this async context so `statements` sees exactly the statements it made.
 */
const drill = (path: string) => {
  const search = new URL(path, 'http://localhost').searchParams;
  return pooledFlowDrilldown(instance.store, { days: Number(search.get('window') ?? 30) as 7, slice: search.get('slice'), productionEnvironment: 'production', production: null },
    { metric: search.get('metric') ?? 'bottleneck', key: search.get('key'), authorized: true });
};
const workItemsRead = (seen: { text: string }[]) => seen.filter(entry => /\bwork_items\b/.test(entry.text)).map(entry => entry.text.slice(0, 160));

test('unit:flow-drilldown-narrow-read — a flow drill-down reads only the work-index and fact rows of the items and window it shows, never a work_items document, and concurrent identical drill-downs share one in-flight read', async () => {
  const store = instance.store;
  const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  // The steps drill-down of one slice: two open items and one delivery.
  invalidateFlowReports(store);
  const sliced = await statements(() => drill(`analytics/flow/drilldown?window=7&metric=steps&slice=${SLICE}`));
  assert.deepEqual(workItemsRead(sliced.seen), [], 'no statement reads work_items');
  // Every row the index and the facts returned belongs to the slice's items.
  const items = new Set<string>();
  for (const entry of sliced.seen.filter(entry => /^\s*SELECT/i.test(entry.text) && /\b(flow_facts|work_index)\b/.test(entry.text)))
    for (const row of entry.rows) for (const field of ['work_id', 'id']) if (typeof row[field] === 'string' && uuidShape.test(row[field])) items.add(row[field]);
  assert.deepEqual([...items].sort(), [...sliceItems].sort(), 'the read returned the slice\'s items\' rows and no other item\'s');
  // The delivery's moves end with its exit from Deploy, read from its work-index summary.
  const delivery = sliced.value.rows.filter(row => row.workKey === 'GY-1').map(row => row.detail);
  assert.ok(delivery.includes('deploy to outside'), `the delivery leaves the flow at its merge: ${delivery.join(', ')}`);
  assert.equal(sliced.value.coverage.truncated, false);
  // The route answers exactly that.
  const served = await reader(viewers[0].token)(`analytics/flow/drilldown?window=7&metric=steps&slice=${SLICE}`);
  assert.deepEqual(served.rows, sliced.value.rows);
  // Its open items, released and waiting for a builder, are outside the steps; work in progress shows them.
  const waiting = await statements(() => drill(`analytics/flow/drilldown?window=7&metric=wip&slice=${SLICE}`));
  assert.deepEqual(waiting.value.rows.map(row => row.workKey).sort(), [openItems[0].key, openItems[1].key].sort());
  assert.deepEqual(workItemsRead(waiting.seen), [], 'no statement reads work_items');

  // The dashboard's own read — every item, every steps page — and each other narrowed metric reads no document either.
  invalidateFlowReports(store);
  const whole = await statements(() => readStepRows(drill));
  assert.equal(whole.value.complete, true);
  assert.ok(whole.value.rows.length > 200, `the week's step moves span pages: ${whole.value.rows.length} rows`);
  assert.deepEqual(workItemsRead(whole.seen), [], 'the paged steps read reads no work_items row');
  for (const metric of ['bottleneck', 'wip', 'throughput', 'lead-time', 'merge-ready', 'stage-dwell', 'evidence', 'review', 'blockers', 'deployments']) {
    invalidateFlowReports(store);
    const drilled = await statements(() => drill(`analytics/flow/drilldown?window=7&metric=${metric}`));
    assert.equal(drilled.value.metric, metric);
    assert.deepEqual(workItemsRead(drilled.seen), [], `the ${metric} drill-down reads no work_items row`);
  }
  assert.ok((await drill('analytics/flow/drilldown?window=7&metric=throughput')).total > 0, 'the week\'s deliveries are drilled into');

  // Five identical drill-downs at once: one catch-up, one freshness probe, one read of the items and of the facts.
  invalidateFlowReports(store);
  const path = 'analytics/flow/drilldown?window=7&metric=steps';
  const together = await statements(() => Promise.all(Array.from({ length: 5 }, () => drill(path))));
  const count = (pattern: RegExp) => together.seen.filter(entry => pattern.test(entry.text)).length;
  assert.equal(count(/pg_try_advisory_xact_lock/), 1, 'one projection catch-up');
  assert.equal(count(/COALESCE\(max\(id\),0\) AS id FROM flow_facts/), 1, 'one freshness probe');
  assert.equal(count(/FROM work_index ORDER BY number LIMIT/), 1, 'one read of the items');
  assert.equal(count(/SELECT \* FROM flow_facts WHERE work_id=ANY\(\$1\) AND observed_at>=\$2/), 1, 'one read of the window\'s facts');
  for (const answer of together.value.slice(1)) assert.deepEqual(answer, together.value[0], 'every caller has the same answer');
  // Once it settled, the next identical drill-down is answered from the pool, without a new read.
  const later = await statements(() => drill(path));
  assert.deepEqual(later.value, together.value[0]);
  assert.equal(later.seen.filter(entry => /FROM work_index ORDER BY number LIMIT/.test(entry.text)).length, 0, 'the fresh pooled read answers it');
});

// ---- The load -----------------------------------------------------------------------------------

interface Sample { kind: string; ms: number; status: number }
const percentile = (values: number[], p: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0; };

/** Runs `tick` every `everyMs` from a random offset until `end`, skipping a tick while the previous one still runs, as setInterval with a pending guard does. */
async function every(everyMs: number, end: number, tick: () => Promise<unknown>, failures: string[], label: string) {
  await sleep(Math.random() * Math.min(everyMs, 5_000));
  const running: Promise<unknown>[] = [];
  let pending = false;
  while (Date.now() < end) {
    if (!pending) {
      pending = true;
      running.push(tick().catch(error => { failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }).finally(() => { pending = false; }));
    }
    await sleep(Math.min(everyMs, Math.max(0, end - Date.now())));
  }
  await Promise.all(running);
}

/** One dashboard, polling as web/main.tsx, web/step-moves.ts and web/flow-analytics.tsx do. */
async function dashboard(index: number, end: number, failures: string[]) {
  const token = viewers[index].token, read = reader(token);
  const polls = [
    every(SNAPSHOT_POLL_MS, end, () => Promise.all([read('work-snapshot'), read('status'), read('board')]), failures, `dashboard ${index + 1} poll`),
    every(STEP_MOVES_POLL_MS, end, async () => { const steps = await readStepRows(read); assert.ok(steps.complete, 'every steps page was read'); }, failures, `dashboard ${index + 1} step moves`),
  ];
  if (index < 2) polls.push(every(FLOW_POLL_MS, end, () => Promise.all([read('analytics/flow?window=7'), mergeTime(read, 'window=7')]), failures, `dashboard ${index + 1} flow page`));
  else {
    const metrics = ['bottleneck', 'wip', 'throughput', 'lead-time', 'merge-ready', 'stage-dwell', 'review', 'blockers', 'deployments', 'evidence'];
    let opened = 0;
    polls.push(every(DRILL_MS, end, () => read(`analytics/flow/drilldown?window=7&metric=${metrics[opened++ % metrics.length]}`), failures, `dashboard ${index + 1} drill-down`));
  }
  await Promise.all(polls);
}

/**
 * One worker: claim one of its items, mint its push credential, renew every 30 s and mint again,
 * release after three to five renewals, and claim the next — until `end`, when it releases.
 */
async function worker(index: number, end: number, samples: Sample[], renewals: { worker: string; gapMs: number }[], failures: string[]) {
  const { id, token } = workers[index];
  const mine = openItems.filter((_, position) => position % WORKERS === index);
  const timed = async (kind: string, path: string, body: unknown) => {
    const answer = await request(token, 'POST', path, body);
    samples.push({ kind, ms: answer.ms, status: answer.status });
    if (answer.status !== 200) failures.push(`${id} ${kind} ${path} answered ${answer.status}: ${JSON.stringify(answer.body).slice(0, 300)}`);
    return answer;
  };
  await sleep(Math.random() * HEARTBEAT_MS);
  for (let next = 0; Date.now() < end; next++) {
    const item = mine[next % mine.length];
    const claimed = await timed('claim', `work/${item.id}/claim`, {});
    if (claimed.status !== 200) { await sleep(5_000); continue; }
    const epoch = claimed.body.epoch as number;
    let renewed = performance.now();
    await timed('push-credential', `work/${item.id}/push-credential`, { epoch });
    const renewalsHeld = 3 + Math.floor(Math.random() * 3);
    for (let held = 0; held < renewalsHeld && Date.now() < end; held++) {
      await sleep(Math.min(HEARTBEAT_MS, Math.max(0, end - Date.now())));
      const heartbeat = await timed('heartbeat', `work/${item.id}/heartbeat`, { epoch });
      if (heartbeat.status !== 200) break;
      renewals.push({ worker: id, gapMs: performance.now() - renewed });
      renewed = performance.now();
      await timed('push-credential', `work/${item.id}/push-credential`, { epoch });
    }
    await timed('release', `work/${item.id}/release`, { epoch });
  }
}

/** The master loop's cycles over the real routes, and its dispatcher's reads beside them. */
async function masterLoop(end: number, failures: string[]) {
  const root = await temporaryDirectory('plane-load-root'), secrets = await temporaryDirectory('plane-load-secrets');
  scratch.push(root, secrets);
  execFileSync('git', ['init', '-q', root]);
  const credentialFile = join(secrets, 'coordinator.token');
  await writeFile(credentialFile, coordinator.token, { mode: 0o600 });
  const config: MasterConfig = masterConfigSchema.parse({ version: 1, url, credentialFile, cliPath: launcher, repository, baseBranch: 'main', githubAppId: 1234,
    hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], run: { worktreeRoot: join(secrets, 'checkouts'), intervalSeconds: LOOP_MS / 1000 } });
  await writeDaemonState(config, emptyDaemonState(config));
  const snapshot = async (timeoutMs = 60_000) => {
    const response = await fetch(`${url}/api/work-snapshot`, { signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${coordinator.token}`, [coordinationViewHeader]: 'coordination', [loopPresenceHeader]: String(LOOP_MS / 1000) } });
    const body = await response.json();
    if (!response.ok) throw new Error(`GET work-snapshot answered ${response.status}`);
    return body as { work: Work[]; now: string };
  };
  const writes: string[] = [];
  const effects = Object.assign(daemonEffects(root, config, {
    snapshot: () => snapshot(), mutate: async (path: string) => { writes.push(path); return {}; },
    run: async (command: string) => command === 'herdr' ? JSON.stringify({ result: { agents: [] } }) : '',
  }), {
    agents: async () => [], herdr: async () => ({ agents: [], available: true }), credentials: async () => ({}), roleHealth: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    requestProof: async () => {}, requestSmoke: async () => {}, closeSession: async () => {}, dispatch: async () => ({ pane: null }),
  }) as unknown as DaemonEffects;
  const state = emptyDaemonState(config);
  let cycles = 0;
  await Promise.all([
    every(LOOP_MS, end, async () => { await runCycle(config, state, effects); cycles++; }, failures, 'master cycle'),
    every(DISPATCH_MS, end, () => snapshot(), failures, 'dispatcher read'),
  ]);
  return { cycles, writes };
}

test('integration:plane-load-multi-user — for ten minutes, on 1,500 items and 500,000 events, three dashboards polling at their own intervals, ten workers claiming, renewing every 30 s and minting push credentials, and the master loop cycling: no request answers 5xx, claim, renewal and push-credential p99 stay under 2 s, and no lease lapses', async () => {
  const store = instance.store;
  const counts = (await store.pool.query('SELECT (SELECT count(*) FROM work_items)::int AS items, (SELECT count(*) FROM events)::int AS events')).rows[0];
  assert.equal(counts.items, ITEMS);
  assert.ok(counts.events >= EVENTS, `the ledger holds ${counts.events} events`);

  // Every answer the server gives, whoever asked: its status, by route.
  const answers: { method: string; path: string; status: number }[] = [];
  instance.http.on('request', (req, res) => res.on('finish', () => answers.push({ method: req.method ?? '', path: new URL(req.url ?? '/', 'http://localhost').pathname, status: res.statusCode })));
  const startedAt = new Date(), end = Date.now() + LOAD_MS;
  const samples: Sample[] = [], renewals: { worker: string; gapMs: number }[] = [];
  const workerFailures: string[] = [], readerFailures: string[] = [], loopFailures: string[] = [];
  const mintsBefore = mints;
  const [loop] = await Promise.all([
    masterLoop(end, loopFailures),
    ...Array.from({ length: DASHBOARDS }, (_, index) => dashboard(index, end, readerFailures)),
    ...Array.from({ length: WORKERS }, (_, index) => worker(index, end, samples, renewals, workerFailures)),
  ]);

  console.log(JSON.stringify({ requests: answers.length, cycles: loop.cycles, loopWrites: loop.writes.length, loopFailures: loopFailures.slice(0, 5), readerFailures: readerFailures.slice(0, 5), workerFailures: workerFailures.slice(0, 5) }));
  // No request answered 5xx: not a worker's, not a dashboard's, not the loop's.
  const failed = answers.filter(answer => answer.status >= 500);
  assert.deepEqual(failed.map(answer => `${answer.method} ${answer.path} ${answer.status}`), [], `${failed.length} of ${answers.length} requests answered 5xx`);
  assert.ok(answers.length > 3 * LOAD_MS / 1000, `the plane answered ${answers.length} requests`);
  assert.deepEqual(readerFailures, [], 'every dashboard read answered');
  assert.deepEqual(workerFailures, [], 'every claim, renewal, mint and release succeeded');

  // Each worker kept claiming, renewing and minting throughout, and each p99 is under 2 s.
  const of = (kind: string) => samples.filter(sample => sample.kind === kind).map(sample => sample.ms);
  const claims = of('claim'), heartbeats = of('heartbeat'), credentials = of('push-credential');
  assert.ok(claims.length >= 2 * WORKERS, `${claims.length} claims`);
  assert.ok(heartbeats.length >= WORKERS * (LOAD_MS / HEARTBEAT_MS) * 0.6, `${heartbeats.length} renewals`);
  assert.equal(credentials.length, claims.length + heartbeats.length, 'a credential was minted after every claim and renewal');
  assert.equal(mints - mintsBefore, credentials.length, 'each minted through the App');
  const figures = (values: number[]) => ({ n: values.length, p50: Math.round(percentile(values, 0.5)), p99: Math.round(percentile(values, 0.99)), max: Math.round(Math.max(...values)) });
  const summary = { claim: figures(claims), heartbeat: figures(heartbeats), 'push-credential': figures(credentials) };
  console.log(JSON.stringify({ latency: summary }));
  for (const [kind, measured] of Object.entries(summary)) assert.ok(measured.p99 < P99_BUDGET_MS, `${kind} p99 ${measured.p99} ms over ${measured.n} requests is not under ${P99_BUDGET_MS} ms: ${JSON.stringify(summary)}`);

  // No lease lapsed: every renewal came inside the two-minute lease, and the ledger records no
  // lapse and no lease-loss escalation on any item a worker held.
  const leaseMs = 120_000;
  assert.ok(renewals.every(renewal => renewal.gapMs < leaseMs), `a renewal came ${Math.round(Math.max(...renewals.map(renewal => renewal.gapMs)))} ms after the last`);
  const held = openItems.map(item => item.id);
  const lapses = (await store.pool.query("SELECT count(*)::int AS lapses FROM events WHERE kind='lease.expired' AND created_at>=$1", [startedAt])).rows[0].lapses;
  assert.equal(lapses, 0, 'no lease lapsed');
  const escalated = (await store.pool.query("SELECT document->>'key' AS key FROM work_items WHERE id=ANY($1::uuid[]) AND document->'escalations' @> '[{\"trigger\":\"lease-loss\"}]'::jsonb", [held])).rows;
  assert.deepEqual(escalated, [], 'no lease-loss escalation was raised');
  const expired = (await store.pool.query("SELECT document->>'key' AS key FROM work_items WHERE id=ANY($1::uuid[]) AND document->'pipeline'->'attempts' @> '[{\"end\":\"expired\"}]'::jsonb", [held])).rows;
  assert.deepEqual(expired, [], 'no attempt ended by expiry');

  // The master loop cycled throughout, over the same routes.
  assert.ok(loop.cycles >= (LOAD_MS / LOOP_MS) * 0.5, `the loop ran ${loop.cycles} cycles`);
  assert.ok(answers.some(answer => answer.path === '/api/work-snapshot'), 'the loop and the dispatcher read the coordination view');
});
