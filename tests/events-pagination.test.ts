import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { eventHistoryLimits, routineEventKinds } from '../src/events-history.js';
import { reconstructTimeline, type LedgerEntry } from '../src/pipeline-speed.js';

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'worker-a', role: 'worker' };
const tokens = { operator: 'o'.repeat(32), worker: 'w'.repeat(32) };

let database: EmbeddedPostgres; let store: Store; let engine: Engine;
let http: ReturnType<typeof server>; let url: string; let item: Work;

// Enough routine rows that the whole lifecycle sits well beyond a 300-row window, as it does on a
// real item: 60-98% of a live ledger is github.observed and heartbeat.
const NOISE = 600;

before(async () => {
  const port = Number(process.env.GRAPHYARD_EVENTS_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 25);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-events-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_events');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_events`);
  await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  http = server(engine, [{ ...operator, token: tokens.operator }, { ...worker, token: tokens.worker }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  item = await lifecycle();
});
after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
  if (database) await database.stop();
});

/** Routine rows exactly as the control plane writes them: the whole document, one row per pass. */
async function noise(work: Work, rows = NOISE) {
  await store.pool.query(
    `INSERT INTO events(work_id,actor,kind,payload,created_at)
     SELECT $1,'github',CASE WHEN n % 2 = 0 THEN 'github.observed' ELSE 'heartbeat' END,
            jsonb_build_object('work',(SELECT document FROM work_items WHERE id=$1),'details',jsonb_build_object('pass',n)),
            clock_timestamp() - ($2::int - n) * interval '1 millisecond'
       FROM generate_series(1,$2::int) AS n`, [work.id, rows]);
}

/** One item's whole life: two attempts, a blocked report, a rework round and two submissions. */
async function lifecycle() {
  let work = await engine.execute(operator, 'create', null, {
    title: 'An item whose history outlives one page', plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'History is readable at any age', proofs: ['integration:events-pagination'] }],
  }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  await noise(work);
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'machine-a', path: `/tmp/${work.id}-1`, branch: 'graphyard/gy-history-1' }, randomUUID());
  await noise(work);
  work = await engine.execute(worker, 'blocked', work.id, { epoch: work.epoch, reason: 'Waiting on an external decision' }, randomUUID());
  work = await engine.execute(operator, 'unblock', work.id, { reason: 'The decision landed' }, randomUUID());
  work = await engine.execute(worker, 'submit', work.id, { epoch: work.epoch, pr: 4242 }, randomUUID());
  await noise(work);
  work = await engine.execute(operator, 'rework', work.id, { reason: 'Review found a gap', previousWorkerStopped: true }, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'machine-a', path: `/tmp/${work.id}-2`, branch: 'graphyard/gy-history-1' }, randomUUID());
  work = await engine.execute(worker, 'submit', work.id, { epoch: work.epoch, pr: 4242 }, randomUUID());
  await noise(work, NOISE);
  return work;
}

async function read(path: string, token = tokens.operator) {
  const response = await fetch(`${url}/api/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  return { status: response.status, body: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
}
/** Walk the whole range through the cursor, exactly as `graphyard events GY-N --all` does. */
async function walk(search: string) {
  const pages: any[] = []; const events: any[] = [];
  let cursor: string | null = null;
  do {
    const page = await read(`events?${search}&view=history${cursor ? `&cursor=${cursor}` : ''}`);
    assert.equal(page.status, 200, JSON.stringify(page.body).slice(0, 300));
    pages.push(page.body); events.push(...page.body.events);
    cursor = page.body.page.nextCursor;
  } while (cursor && pages.length < eventHistoryLimits.pages);
  return { pages, events };
}
const rows = async (sql: string, values: unknown[] = []) => (await store.pool.query(sql, values)).rows;

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
/** The command a human runs, against this server and with no ambient Graphyard credential. */
async function cli(...args: string[]) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GRAPHYARD_')));
  const { stdout } = await exec(process.execPath, [launcher, 'events', ...args], {
    cwd: await mkdtemp(join(tmpdir(), 'graphyard-events-cli-')),
    env: { ...environment, GRAPHYARD_URL: url, GRAPHYARD_TOKEN: tokens.operator }, maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

test('integration:events-pagination — an item with more than 2,000 events has its complete lifecycle retrieved through kind, time and cursor filters without reading a single routine row, and the retrieved history alone reconstructs the timeline the control plane kept', async () => {
  const total = Number((await rows('SELECT count(*)::int AS count FROM events WHERE work_id=$1', [item.id]))[0].count);
  assert.ok(total > 2000, `the item carries ${total} events`);
  const lifecycleRows = await rows('SELECT seq,kind,created_at FROM events WHERE work_id=$1 AND NOT (kind=ANY($2::text[])) ORDER BY seq', [item.id, [...routineEventKinds]]);
  const routineRows = await rows('SELECT kind, count(*)::int AS count, min(created_at) AS first_at, max(created_at) AS last_at FROM events WHERE work_id=$1 AND kind=ANY($2::text[]) GROUP BY kind ORDER BY kind', [item.id, [...routineEventKinds]]);
  assert.deepEqual(lifecycleRows.map(row => row.kind), ['create', 'ready', 'claim', 'workspace', 'blocked', 'unblock', 'submit', 'rework', 'claim', 'workspace', 'submit']);
  assert.deepEqual(routineRows.map(row => [row.kind, row.count]), [['github.observed', 1200], ['heartbeat', 1200]]);

  // The read this replaces: the newest 300 rows of everything are all routine, so nothing of the
  // item's life was reachable through it.
  const newest = await read(`events?work=${item.id}&routine=include&limit=300`);
  assert.equal(newest.body.length, 300);
  assert.ok(newest.body.every((event: any) => (routineEventKinds as readonly string[]).includes(event.kind)), 'the newest page is entirely routine');

  // The default read returns the same array shape, newest first, with no routine row in it.
  const unfiltered = await read(`events?work=${item.id}`);
  assert.ok(Array.isArray(unfiltered.body));
  assert.equal(unfiltered.body.length, Math.min(lifecycleRows.length, eventHistoryLimits.page));
  assert.deepEqual(unfiltered.body.map((event: any) => event.seq), [...lifecycleRows].reverse().map(row => String(row.seq)));
  assert.equal(unfiltered.body.some((event: any) => (routineEventKinds as readonly string[]).includes(event.kind)), false);

  // Paged forwards in small pages, the cursor walks every lifecycle row exactly once, in ledger
  // order, and each page discloses the routine rows it left out with their first and last instants.
  const { pages, events } = await walk(`work=${item.id}&order=asc&limit=5`);
  assert.ok(pages.length > 2, `${pages.length} pages of 5`);
  assert.deepEqual(events.map(event => event.seq), lifecycleRows.map(row => String(row.seq)));
  assert.equal(new Set(events.map(event => event.seq)).size, events.length, 'no row is returned twice');
  assert.ok(pages.every(page => page.events.length <= 5));
  assert.equal(pages.at(-1)!.page.hasMore, false);
  assert.equal(pages.at(-1)!.page.nextCursor, null);
  for (const page of pages) {
    assert.equal(page.routine.included, false);
    assert.deepEqual(page.routine.excluded, [...routineEventKinds]);
    assert.equal(page.routine.total, routineRows.reduce((sum, row) => sum + row.count, 0));
    assert.deepEqual(page.routine.kinds.map((entry: any) => [entry.kind, entry.count, entry.firstAt, entry.lastAt]),
      routineRows.map(row => [row.kind, row.count, row.first_at.toISOString(), row.last_at.toISOString()]));
    assert.equal(page.routine.truncated, false);
    assert.match(page.routine.statement, /routine row\(s\) were excluded from this read and summarised instead/);
  }

  // The whole ledger of the item, routine rows included, is reachable the same way.
  const everything = await walk(`work=${item.id}&order=asc&limit=500&routine=include`);
  assert.equal(everything.events.length, total);
  assert.equal(everything.pages[0].routine.included, true);
  assert.equal(everything.pages[0].routine.kinds.length, 0);

  // What the retrieved history is for: the item's timeline, rebuilt from the rows the read
  // returned, is the timeline the control plane kept as the commands ran.
  const { pipeline } = (await rows('SELECT document AS pipeline FROM work_items WHERE id=$1', [item.id]))[0].pipeline as Work;
  const reconstructed = reconstructTimeline(everything.events as LedgerEntry[]);
  assert.deepEqual(reconstructed, pipeline);
  assert.equal(reconstructed.attempts.length, 2);
  // Both attempts ended at their own submission; the rework that followed the first one is a
  // rework round, and the blocked report is the hand-off it was.
  assert.deepEqual(reconstructed.attempts.map(attempt => [attempt.epoch, attempt.end]), [[1, 'submitted'], [2, 'submitted']]);
  assert.equal(reconstructed.reworkRounds, 1);
  assert.deepEqual(reconstructed.interventions, { blocked: 1, requirements: 0 });
  assert.ok(reconstructed.submittedAt && reconstructed.resubmittedAt! > reconstructed.submittedAt);

  // Kind and time filters narrow the same read.
  const claims = await read(`events?work=${item.id}&kind=claim,submit&order=asc&view=history`);
  assert.deepEqual(claims.body.events.map((event: any) => event.kind), ['claim', 'submit', 'claim', 'submit']);
  const firstClaim = claims.body.events[0].created_at;
  const since = await read(`events?work=${item.id}&kind=claim,submit&since=${encodeURIComponent(firstClaim)}&until=${encodeURIComponent(claims.body.events[3].created_at)}&order=asc&view=history`);
  assert.deepEqual(since.body.events.map((event: any) => event.kind), ['claim', 'submit', 'claim'], 'the window is half-open on until');
  assert.deepEqual(since.body.filters.kinds, ['claim', 'submit']);
  // A routine kind named explicitly is returned, and then nothing is summarised away.
  const heartbeats = await read(`events?work=${item.id}&kind=heartbeat&limit=10&view=history`);
  assert.equal(heartbeats.body.events.length, 10);
  assert.ok(heartbeats.body.events.every((event: any) => event.kind === 'heartbeat'));
  assert.deepEqual(heartbeats.body.routine.excluded, ['github.observed']);

  // Payload shapes: the whole event, its details alone, or neither.
  const details = await read(`events?work=${item.id}&kind=submit&payload=details&limit=1&view=history`);
  assert.equal(details.body.events[0].payload, undefined);
  assert.equal(details.body.events[0].details.pr, 4242);
  const none = await read(`events?work=${item.id}&kind=submit&payload=none&limit=1&view=history`);
  assert.equal(none.body.events[0].payload, undefined);
  assert.equal(none.body.events[0].details, undefined);
  assert.equal(none.body.events[0].kind, 'submit');

  // The pages after the first of one walk ask for the cursor alone: the same rows and paging,
  // without aggregating the routine summary the first page already carried.
  const firstPage = await read(`events?work=${item.id}&order=asc&limit=5&view=history`);
  const nextPage = await read(`events?work=${item.id}&order=asc&limit=5&view=page&cursor=${firstPage.body.page.nextCursor}`);
  assert.equal(nextPage.status, 200);
  assert.equal(nextPage.body.routine, null);
  assert.deepEqual(nextPage.body.events.map((event: any) => event.seq), pages[1].events.map((event: any) => event.seq));
  assert.deepEqual(nextPage.body.page, pages[1].page);

  // The command a human runs: one invocation walks the whole history, in order, with the routine
  // rows summarised rather than paged through.
  const walked = await cli(item.key, '--all', '--limit', '5');
  assert.deepEqual(walked.events.map((event: any) => event.seq), lifecycleRows.map(row => String(row.seq)));
  assert.equal(walked.page.complete, true);
  assert.ok(walked.page.pages > 2);
  assert.equal(walked.page.returned, lifecycleRows.length);
  assert.equal(walked.filters.order, 'asc');
  assert.equal(walked.routine.total, 2400);
  assert.equal(walked.events[0].payload, undefined, 'the command reads history, not document snapshots');
  assert.equal(walked.events.find((event: any) => event.kind === 'submit').details.pr, 4242, 'the details each command recorded are what the page carries');
  const cliHeartbeats = await cli(item.key, '--kind', 'heartbeat', '--limit', '3');
  assert.equal(cliHeartbeats.events.length, 3);
  assert.deepEqual(cliHeartbeats.routine.excluded, ['github.observed']);
  const cliRoutine = await cli(item.key, '--routine', '--limit', '4');
  assert.equal(cliRoutine.routine.included, true);
  assert.equal(cliRoutine.events.length, 4);
  await assert.rejects(cli(item.key, '--nope'), (error: any) => /Unknown flag --nope/.test(error.stderr));

  // Refusals: an unreadable filter is rejected rather than silently ignored.
  assert.equal((await read('events?work=invalid')).status, 400);
  assert.equal((await read(`events?work=${item.id}&limit=${eventHistoryLimits.maxPage + 1}`)).status, 400);
  assert.equal((await read(`events?work=${item.id}&since=2026-09-20T00:00:00Z&until=2026-09-19T00:00:00Z`)).status, 400);
  assert.equal((await read(`events?work=${item.id}&order=sideways`)).status, 400);
  assert.equal((await read(`events?work=${item.id}&cursor=abc`)).status, 400);
  // The global read still answers, with the same defaults.
  const global = await read('events?view=history&limit=20');
  assert.equal(global.status, 200);
  assert.equal(global.body.filters.work, null);
  assert.equal(global.body.events.some((event: any) => (routineEventKinds as readonly string[]).includes(event.kind)), false);
});
