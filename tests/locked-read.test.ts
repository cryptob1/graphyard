import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store, save } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { coordinationProjection, isSettledSummary, isStandIn, lockedWork } from '../src/store/locked-read.js';
import { coordinationDocumentSql, coordinationRelevance, coordinationTail, detoasted } from '../src/store/coordination-sql.js';
import { advisoryLocks } from '../src/store/locks.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1027: coordination writes read only what their decision needs while they hold the coordination
 * lock. On 2026-10-01 ~20 write paths read every work item's whole document under the lock (~1000
 * documents, 62 MB, 570 delivered); one read took 20 s and ten writes queued behind it, so registry
 * selects were abandoned, leases lapsed and the cost grew with every item ever created.
 *
 * One case per proof: unit:locked-transactions-read-bounded (AC-1), unit:lock-hold-bounded-by-open-items
 * (AC-2, AC-3) and unit:reconcile-lock-hold-bounded (AC-6).
 */

const src = fileURLToPath(new URL('../src', import.meta.url));
const sources = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
});

/**
 * The whole-board readers, which read outside any coordination transaction (`Store.list`,
 * `Store.workSnapshot`), by file and the start of their SQL; the case below refuses them inside one.
 */
const readers = new Set(['store/store.ts:SELECT document FROM work_items ORDER BY number', "store/store.ts:SELECT COALESCE(jsonb_agg(document ORDER BY number), '[]'::j"]);
/** Each query's SQL text in `text`: a string literal passed to any `.query(`, or a module `const` named as its first argument. */
function queryTexts(text: string): { sql: string; index: number }[] {
  const constants = new Map<string, string>();
  for (const match of text.matchAll(/\bconst\s+(\w+)\s*=\s*([`'"])([\s\S]*?)\2/g)) constants.set(match[1], match[3]);
  const found: { sql: string; index: number }[] = [];
  for (const match of text.matchAll(/\.query\(\s*(?:([`'"])([\s\S]*?)\1|(\w+)\s*[,)])/g)) {
    const sql = match[2] ?? constants.get(match[3]!);
    if (sql !== undefined) found.push({ sql, index: match.index! });
  }
  return found;
}

test('unit:locked-transactions-read-bounded — no transaction client reads every work item\'s document; each former call site reads whole only the item, its overlapping open items and its dependencies', async () => {
  const offenders: string[] = [];
  for (const file of sources(src)) {
    const text = readFileSync(file, 'utf8');
    // Every query, on any receiver, whose text reads work_items' document with no WHERE or LIMIT
    // bounding the rows: with or without ORDER BY or a JOIN, FOR UPDATE or not. The text is the
    // literal passed, or the module constant named in its place (GY-1042).
    for (const { sql, index } of queryTexts(text)) {
      if (!/\bFROM\s+work_items\b/i.test(sql) || !/\bdocument\b/.test(sql.split(/\bFROM\s+work_items\b/i)[0])) continue;
      const after = sql.split(/\bFROM\s+work_items\b/i)[1];
      if (/\bWHERE\b|\bLIMIT\b/i.test(after)) continue;
      if (readers.has(`${relative(src, file)}:${sql.replace(/\s+/g, ' ').slice(0, 60)}`)) continue;
      offenders.push(`${relative(src, file)}:${text.slice(0, index).split('\n').length}: ${sql.replace(/\s+/g, ' ').slice(0, 60)}`);
    }
    // A key lookup on the document scans and detoasts every document: it goes through the work index.
    for (const match of text.matchAll(/FROM work_items[^`'"]*WHERE[^`'"]*document->>\\?'key'/g)) offenders.push(`${relative(src, file)}:${text.slice(0, match.index).split('\n').length}: key lookup on the document`);
    // A stage filter on the document detoasts every document too, delivered ones included.
    for (const match of text.matchAll(/FROM work_items[^`'"]*WHERE[^`'"]*document->>'stage'\s*<>/g)) offenders.push(`${relative(src, file)}:${text.slice(0, match.index).split('\n').length}: stage filter on the document`);
  }
  // Inside a coordination transaction the whole-board readers are refused too.
  for (const file of sources(src)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\.transaction\(async \(db[^)]*\) => \{/g)) {
      let depth = 0, end = match.index! + match[0].length - 1;
      for (; end < text.length; end++) { if (text[end] === '{') depth++; else if (text[end] === '}' && --depth === 0) break; }
      const body = text.slice(match.index, end);
      for (const reader of ['store.list()', '.workSnapshot()', '.coordinationSnapshot()']) if (body.includes(reader)) offenders.push(`${relative(src, file)}:${text.slice(0, match.index).split('\n').length}: ${reader} inside a coordination transaction`);
    }
  }
  assert.deepEqual(offenders, [], `unbounded work_items reads on a transaction client:\n${offenders.join('\n')}`);
  // The scan sees the forms GY-1042's review named: a JOIN, another receiver, and a SQL constant.
  const probe = 'const wholeSql = `SELECT w.document FROM work_items w JOIN work_index i ON i.id = w.id`;\n'
    + 'await this.store.leasePool.query(`SELECT document FROM work_items w JOIN work_index i ON i.id = w.id ORDER BY w.number`);\nawait db.query(wholeSql, []);';
  assert.deepEqual(queryTexts(probe).map(({ sql }) => /\bWHERE\b|\bLIMIT\b/i.test(sql.split(/\bFROM\s+work_items\b/i)[1])), [false, false], 'a JOIN, another receiver or a constant does not exempt a whole-board read');
  // Each former call site reads through lockedWork, naming the item it acts on.
  const engineSource = readFileSync(join(src, 'engine.ts'), 'utf8');
  assert.ok((engineSource.match(/lockedWork\(db, \[(id|work!?\.id)\]\)/g) ?? []).length >= 8, 'the engine\'s commands read through the bounded read, naming their item');
  assert.match(engineSource, /const rows = await lockedRows\(db, \[\]\);/, 'a reconciliation pass opens, under the lock, on the bounded read');
  assert.match(engineSource, /else if \(isStandIn\(fleet\.get\(id\)!\.work\)\) await reread\(db, \[id\]\)/, 'a batch reads each of its own items whole as it reaches it, outside the coordination lock');
  // The locked read itself selects no unsettled document by its stage alone: what it reads whole is named.
  assert.doesNotMatch(readFileSync(join(src, 'store/locked-read.ts'), 'utf8'), /settled IS NOT TRUE|NOT i\.settled/, 'the locked read does not read every open document whole');

  // What a command reads whole, observed on its queries: the item, the open items overlapping it by
  // planned files or an exclusive resource, and its dependency — never an unrelated open item, whose
  // realistic history is read as the compact projection.
  await ensureTemplate();
  const dependency = delivered(template, 9000), overlapping = open(template, 9001, ['src/scope-probe/']), sharing = open(template, 9002, ['src/elsewhere/'], ['probe-db']);
  const unrelated = Array.from({ length: 5 }, (_, n) => open(template, 9003 + n));
  await insert([dependency, overlapping, sharing, ...unrelated]);
  const focus = await engine.execute(operator, 'create', null, { title: 'Scope probe', plannedFiles: ['src/scope-probe/a.ts'], exclusiveResources: ['probe-db'], dependencies: [dependency.id], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:bench'] }] }, randomUUID());
  timeTransactions();
  const { reads } = await held('scope', () => engine.execute(operator, 'ready', focus.id, {}, randomUUID()));
  const seen = new Set(reads.flatMap(entry => entry.keys));
  assert.deepEqual([...seen].sort(), [focus.key, dependency.key, overlapping.key, sharing.key].sort(), 'the command read whole only its item, its overlapping open items and its dependency');
  const board = await lockedWork(store.pool, [focus.id]);
  const standIn = (key: string) => isStandIn(board.find(item => item.key === key)!);
  assert.deepEqual([focus.key, dependency.key, overlapping.key, sharing.key].map(standIn), [false, false, false, false], 'the item, its overlaps and its dependency are documents');
  for (const item of unrelated) {
    const projection = board.find(entry => entry.key === item.key)!;
    assert.ok(standIn(item.key) && !projection.pipeline && projection.plannedFiles.length && projection.stage === item.stage, `${item.key} is read as its compact projection`);
  }
  await assert.rejects(store.transaction(async (db, now) => save(db, board.find(entry => entry.key === unrelated[0].key)!, 'test', 'test', now)), /compact projection/);
});

const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const worker: Principal = { id: 'engineer-a', role: 'worker', runtime: 'claude', sessionKind: 'ai' };

let database: EmbeddedPostgres, store: Store, engine: Engine, registry: AgentRegistry;
before(async () => {
  // An offset no other test file takes: two files sharing a port fail in their `before` hook.
  const port = Number(process.env.GRAPHYARD_LOCKED_READ_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1027);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('locked-read'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('locked_read');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/locked_read`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/locked'); engine.submissionObserver = null;
  engine.principals = [operator, coordinator, worker];
  registry = new AgentRegistry(store);
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

/**
 * How long each transaction held the coordination lock, by the operation that took it, and which
 * documents its queries returned whole (a stand-in is returned as JSON text, a document as an object).
 * A transaction opened without the lock (a reconciliation batch, GY-727) holds it only from a
 * successful `pg_try_advisory_xact_lock`, or a reconciliation write's wait for the coordination lock
 * (GY-1290), to its end; `locked` says whether it held it at all.
 */
const holds: { label: string; ms: number; keys: string[]; locked: boolean }[] = [];
let label = 'other', timing = false;
const seededDelivered = (entry: { keys: string[] }) => entry.keys.filter(key => key.startsWith('DONE-')).length;
const seededOpen = (entry: { keys: string[] }) => entry.keys.filter(key => key.startsWith('OPEN-')).length;
function timeTransactions() {
  if (timing) return; timing = true;
  const original = store.transaction.bind(store);
  store.transaction = (async (fn: any, options: any) => original(async (db, now) => {
    let started = options?.coordinationLock === false ? null as number | null : performance.now();
    const keys = new Set<string>();
    const counted = new Proxy(db, { get: (target, property) => property !== 'query' ? Reflect.get(target, property, target) : async (...args: unknown[]) => {
      const result = await (target.query as any)(...args);
      if (started === null && String(args[0]).includes('pg_try_advisory_xact_lock') && result?.rows?.[0]?.ok) started = performance.now();
      if (started === null && args[0] === 'SELECT pg_advisory_xact_lock($1)' && (args[1] as unknown[])?.[0] === advisoryLocks.coordination) started = performance.now();
      for (const row of result?.rows ?? []) if (row.document && typeof row.document === 'object' && (row.document as Work).key) keys.add((row.document as Work).key);
      return result;
    } });
    try { return await fn(counted, now); } finally { holds.push({ label, ms: started === null ? 0 : performance.now() - started, keys: [...keys], locked: started !== null }); }
  }, options)) as typeof store.transaction;
}
async function held<T>(name: string, run: () => Promise<T>): Promise<{ result: T; ms: number; reads: typeof holds }> {
  label = name; const from = holds.length;
  const result = await run();
  label = 'other';
  const reads = holds.slice(from);
  return { result, ms: reads.reduce((total, entry) => total + entry.ms, 0), reads };
}

const sha = (n: number, salt = 'a') => (salt + n.toString(16)).padStart(40, '0').slice(-40);
const stamp = (minutes: number) => new Date(Date.parse('2026-09-01T00:00:00Z') + minutes * 60_000).toISOString();
const paths = (n: number, count: number) => Array.from({ length: count }, (_, index) => `src/area-${n % 37}/module-${index}.ts`);

/**
 * The histories the live ledger's items carry: the pipeline timeline, evidence records with
 * artifacts, long queue, dispatch and action histories and finished sessions. `scale` 1 is a
 * delivered item's (about 60 KB with its observation); an open item in flight carries about half.
 */
function histories(n: number, at: string, scale: number) {
  const count = (full: number) => Math.round(full * scale);
  return {
    evidence: Array.from({ length: count(24) }, (_, index) => ({ id: randomUUID(), proof: `unit:proof-${index % 6}`, sha: sha(n - (index % 4)), baseSha: sha(n, 'b'), policyRevision: 3, producer: 'producer-a', trusted: true, result: 'pass', executed: 12, skipped: 0, at,
      artifacts: Array.from({ length: 6 }, (_, artifact) => ({ name: `artifact-${artifact}.log`, sha256: sha(artifact, 'c'), bytes: 4096, url: `https://example.invalid/runs/${n}/${index}/${artifact}` })), provenance: { runner: 'local', command: 'node --test', environment: 'linux' } })) as unknown as Work['evidence'],
    queueHistory: Array.from({ length: count(40) }, (_, index) => ({ sequence: index, event: 'entered', at, reason: `queued behind ${index} entries` })) as unknown[],
    actionQueue: { actions: [], history: Array.from({ length: count(80) }, (_, index) => ({ id: randomUUID(), kind: 'resync', state: 'done', result: 'done', requestedAt: at, resolvedAt: at, history: [{ at, event: 'requested' }, { at, event: 'claimed' }, { at, event: 'settled' }] })) } as unknown as Work['actionQueue'],
    autoDispatch: { review: null, producers: [], history: Array.from({ length: count(40) }, (_, index) => ({ id: randomUUID(), kind: 'review', sha: sha(n - index), requestedAt: at, resolvedAt: at, outcome: 'answered' })) } as unknown as Work['autoDispatch'],
    sessions: Array.from({ length: count(30) }, (_, index) => ({ id: `s-${n}-${index}`, kind: 'implementation', state: 'finished', runtime: 'claude', principal: 'engineer-a', startedAt: at, endedAt: at, outcome: 'finished: submitted the pull request and completed the attempt' })) as unknown as Work['sessions'],
    pipeline: { attempts: Array.from({ length: count(30) }, (_, index) => ({ epoch: index, owner: 'engineer-a', claimedAt: at, endedAt: at, end: 'submitted' })), submittedAt: at, reworkRounds: 3 } as unknown as Work['pipeline'],
  };
}
/** A delivered item as the live ledger holds one: its candidate merged and delivered, the observation's per-file scope and every history — nothing owed, so settled. */
function delivered(template: Work, n: number): Work {
  const id = randomUUID(), key = `DONE-${n}`;
  const at = stamp(n);
  return {
    ...structuredClone(template), id, key, title: `Delivered change ${n}`, description: `Why change ${n} mattered. `.repeat(40),
    stage: 'done', stageEnteredAt: at, ready: true, lease: null, nextAction: null, blocker: null, plannedFiles: paths(n, 6),
    candidate: { sha: sha(n), baseSha: sha(n, 'b'), pr: 1000 + n } as Work['candidate'],
    submission: { epoch: 2, pr: 1000 + n } as Work['submission'],
    delivery: { mergedAt: at, mergeSha: sha(n, 'm'), authorizationRevision: 40 } as Work['delivery'],
    observation: { candidate: { sha: sha(n), baseSha: sha(n, 'b'), pr: 1000 + n, branch: `graphyard/done-${n}-2`, author: 'engineer-a' }, merged: true, mergeSha: sha(n, 'm'), mergedAt: at, mergeable: true, protected: true,
      checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews: [{ author: 'reviewer', state: 'APPROVED', commitId: sha(n), submittedAt: at }],
      files: paths(n, 40), scopeFiles: Array.from({ length: 300 }, (_, index) => ({ path: `src/area-${index}/file.ts`, digest: sha(index, 'f') })), baseTip: sha(n, 'b'), at } as unknown as Work['observation'],
    ...histories(n, at, 1),
  } as Work;
}
/** An open item: unassigned, with its own planned files and the histories of earlier attempts (reworked, re-dispatched). */
function open(template: Work, n: number, plannedFiles = paths(n, 4), exclusiveResources: string[] = []): Work {
  return { ...structuredClone(template), id: randomUUID(), key: `OPEN-${n}`, title: `Open change ${n}`, description: `What open change ${n} must do. `.repeat(30), plannedFiles, exclusiveResources, ready: n % 2 === 0, stage: 'backlog',
    ...histories(n, stamp(n), 0.5) } as Work;
}
async function insert(documents: Work[]) {
  for (let from = 0; from < documents.length; from += 50) {
    const slice = documents.slice(from, from + 50);
    await store.pool.query('INSERT INTO work_items(id, document) SELECT (d->>\'id\')::uuid, d FROM jsonb_array_elements($1::jsonb) AS d', [JSON.stringify(slice)]);
  }
}

let template: Work, opened = 0, closed = 0, prs = 0;
async function ensureTemplate() {
  template ??= await engine.execute(operator, 'create', null, { title: 'Template', plannedFiles: ['src/template/'], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:bench'] }] }, randomUUID());
}
async function seed(open_: number, closed_: number) {
  await insert([...Array.from({ length: open_ }, () => open(template, opened++)), ...Array.from({ length: closed_ }, () => delivered(template, closed++))]);
}

/** One claim, renew, submit and registry select, each its own coordination transaction; their lock hold in ms. */
async function lifecycle(round: string) {
  let work = await engine.execute(operator, 'create', null, { title: `Bench ${round}`, plannedFiles: [`src/bench-${round}/`], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:bench'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  const claim = await held('claim', () => engine.execute(worker, 'claim', work.id, {}, randomUUID()));
  work = claim.result;
  work = await engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'bench-host', path: `/tmp/bench/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, randomUUID());
  const renew = await held('renew', () => engine.execute(worker, 'heartbeat', work.id, { epoch: work.epoch }, randomUUID()));
  const submit = await held('submit', () => engine.execute(worker, 'submit', work.id, { epoch: work.epoch, pr: 5000 + (++prs) }, randomUUID()));
  const select = await held('select', () => registry.select(coordinator, { role: 'worker', host: 'bench-host', work: work.key, principal: worker.id }, randomUUID()));
  return { claim: claim.ms, renew: renew.ms, submit: submit.ms, select: select.ms };
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function measure(round: string) {
  const runs: Awaited<ReturnType<typeof lifecycle>>[] = [];
  for (let n = 0; n < 5; n++) runs.push(await lifecycle(`${round}-${n}`));
  return Object.fromEntries((['claim', 'renew', 'submit', 'select'] as const).map(name => [name, median(runs.map(run => run[name]))])) as Record<'claim' | 'renew' | 'submit' | 'select', number>;
}

test('unit:lock-hold-bounded-by-open-items — with 1000 items (600 delivered) claim, renew, submit and registry select each hold the lock under 500 ms, and the hold does not grow with the delivered history', async () => {
  await ensureTemplate();
  timeTransactions();
  await seed(400, 60);
  const few = await measure('few');
  await seed(0, 540);
  const count = Number((await store.pool.query('SELECT count(*) FROM work_items')).rows[0].count);
  const settled = Number((await store.pool.query('SELECT count(*) FROM work_index WHERE settled')).rows[0].count);
  assert.ok(count >= 1000, `${count} items`); assert.equal(settled, closed + 1, 'every delivered item (and the scope probe\'s dependency) is settled');
  const bytes = Number((await store.pool.query("SELECT sum(pg_column_size(document)) FROM work_items WHERE document->>'stage' = 'done'")).rows[0].sum);
  assert.ok(bytes / 600 > 8_000, `a delivered document stores ${Math.round(bytes / 600)} bytes compressed`);
  const fromMany = holds.length;
  const many = await measure('many');
  // Not one delivered document, and not one open item outside the bench item's scope, is read whole
  // by these commands: each reads the history as summaries and the other open items as projections.
  const reread = holds.slice(fromMany).filter(entry => entry.label !== 'other' && (seededDelivered(entry) || seededOpen(entry)));
  assert.deepEqual(reread.map(entry => `${entry.label}: ${seededDelivered(entry)} delivered, ${seededOpen(entry)} open`), [], 'claim, renew, submit and select read no delivered document and no unrelated open document whole');
  console.log(`lock hold (median ms) with 60 delivered: ${JSON.stringify(few)}; with 600 delivered: ${JSON.stringify(many)}`);
  for (const name of ['claim', 'renew', 'submit', 'select'] as const) {
    assert.ok(many[name] < 500, `${name} held the coordination lock ${many[name].toFixed(0)} ms with 600 delivered items`);
    // Ten times the delivered history: the hold stays within noise of the small ledger's (a loaded
    // host slows both rounds alike, so the noise allowance scales with the small ledger's hold).
    assert.ok(many[name] - few[name] < Math.max(30, few[name]), `${name} grew from ${few[name].toFixed(0)} ms to ${many[name].toFixed(0)} ms when the delivered history grew tenfold`);
  }

  // What a locked read hands out: the item whole, every unrelated open item as its projection, each
  // settled delivery as its summary — and a summary is never saved over its document.
  const target = (await store.pool.query("SELECT document FROM work_items WHERE document->>'key' = 'DONE-3'")).rows[0].document as Work;
  const all = await lockedWork(store.pool, []);
  assert.equal(all.length, Number((await store.pool.query('SELECT count(*) FROM work_items')).rows[0].count));
  const summary = all.find(item => item.key === 'DONE-3')!;
  assert.ok(isSettledSummary(summary) && !summary.pipeline && (summary.sessions ?? []).length === 0, 'a settled delivery is read as its summary');
  assert.deepEqual([summary.stage, summary.plannedFiles, summary.delivery, (summary.observation as any).files], [target.stage, target.plannedFiles, target.delivery, (target.observation as any).files], 'the summary keeps what decisions read');
  assert.ok(all.filter(item => item.stage !== 'done').every(item => !isSettledSummary(item) && isStandIn(item)), 'every open item is a compact projection when no decision names it');
  const bytesOpen = Number((await store.pool.query("SELECT avg(pg_column_size(document)) FROM work_items WHERE document->>'key' LIKE 'OPEN-%'")).rows[0].avg);
  assert.ok(bytesOpen > 4_000, `an open document stores ${Math.round(bytesOpen)} bytes compressed: it carries its attempts' histories`);
  const focused = (await lockedWork(store.pool, ['DONE-3'])).find(item => item.key === 'DONE-3')!;
  assert.ok(!isSettledSummary(focused) && focused.pipeline, 'the item a decision acts on is read whole');
  await assert.rejects(store.transaction(async (db, now) => save(db, summary, 'test', 'test', now)), /settled summary/);
});

test('unit:reconcile-lock-hold-bounded — a full reconciliation pass over 1000 items (600 delivered) holds the coordination lock under 5 s in total, each batch within its budget', async () => {
  assert.ok(template, 'the benchmark seeded the ledger');
  label = 'reconcile'; const from = holds.length;
  await engine.reconcile();
  const batches = holds.slice(from).filter(entry => entry.label === 'reconcile');
  label = 'other';
  const total = batches.reduce((sum, entry) => sum + entry.ms, 0), longest = Math.max(...batches.map(entry => entry.ms));
  const reread = batches.reduce((sum, entry) => sum + seededDelivered(entry), 0);
  const openRead = batches.map(seededOpen), opened_ = Number((await store.pool.query("SELECT count(*) FROM work_items WHERE document->>'key' LIKE 'OPEN-%'")).rows[0].count);
  console.log(`reconcile pass: ${batches.length} batches, ${total.toFixed(0)} ms of lock hold, longest ${longest.toFixed(0)} ms, ${reread} delivered and ${openRead.reduce((a, b) => a + b, 0)} open documents read whole (${opened_} open)`);
  // The pass opens under the lock on every item's compact stand-in and reads no document whole
  // there; each batch reads its own open rows whole: not one of the 600 delivered documents is read
  // in any batch, and the pass reads each open document whole about once — not once per batch, as
  // re-reading every open row in each batch would.
  assert.ok(batches[0].locked, 'the opening read holds the coordination lock');
  assert.deepEqual(batches[0].keys, [], 'the opening read reads no document whole');
  assert.equal(reread, 0, `${reread} delivered documents were read whole over ${batches.length} batches (${batches.map(seededDelivered).join(', ')})`);
  assert.ok(batches.length > 3, `${batches.length} batches`);
  assert.ok(openRead.reduce((a, b) => a + b, 0) < opened_ * 2, `the pass read ${openRead.reduce((a, b) => a + b, 0)} open documents whole for ${opened_} open items`);
  assert.ok(total < 5_000, `a full pass held the lock ${total.toFixed(0)} ms over ${batches.length} batches`);
  // The opening read is the longest hold; a batch holds the lock only to commit what it wrote.
  assert.ok(longest < engine.reconcileBatchMs + 250, `the longest batch held the lock ${longest.toFixed(0)} ms against a ${engine.reconcileBatchMs} ms budget`);
  // A second pass changes nothing it does not need to and still reads no delivered document.
  const again = holds.length; label = 'reconcile';
  await engine.reconcile(); label = 'other';
  const second = holds.slice(again).reduce((sum, entry) => sum + entry.ms, 0);
  console.log(`second reconcile pass: ${second.toFixed(0)} ms of lock hold`);
  assert.ok(second < 5_000, `a second pass held the lock ${second.toFixed(0)} ms`);
  assert.equal(holds.slice(again).reduce((sum, entry) => sum + seededDelivered(entry), 0), 0, 'a second pass reads no delivered document whole');
  // A slow host spends each batch's budget before its rows are done (CI on 2026-10-01: 35 batches
  // read 1082 open documents whole for 407 open items). The next batch reads only as many rows as
  // that one finished, so the pass still reads each open document whole about once.
  // A pass evaluates only what moved since the last (GY-1124), so the slow pass starts from a reset
  // view: a full pass that reads every open document again, as a restarted server's first pass does.
  engine.resetReconcileView();
  const budget = engine.reconcileBatchMs, slow = holds.length;
  engine.reconcileBatchMs = 1; label = 'reconcile';
  try { await engine.reconcile(); } finally { engine.reconcileBatchMs = budget; label = 'other'; }
  const slowBatches = holds.slice(slow), slowRead = slowBatches.reduce((sum, entry) => sum + seededOpen(entry), 0);
  console.log(`slow reconcile pass: ${slowBatches.length} batches, ${slowRead} open documents read whole (${opened_} open)`);
  // Each planned write commits in a transaction of its own under the lock (GY-1290), and the reset pass
  // writes almost nothing: the budget is counted on the evaluating batches, which hold no lock.
  const evaluating = (entries: typeof holds) => entries.filter(entry => !entry.locked).length;
  assert.ok(evaluating(slowBatches) > evaluating(batches), `a 1 ms budget yields more often: ${evaluating(slowBatches)} evaluating batches against ${evaluating(batches)}`);
  assert.ok(slowRead < opened_ * 2, `with every batch yielding on its budget the pass read ${slowRead} open documents whole for ${opened_} open items`);
});

test('a row a reconciliation batch saved stands in as exactly the projection the database would build from it', async () => {
  assert.ok(template, 'the benchmark seeded the ledger');
  // In-process projection and SQL projection agree, over the edge shapes the SQL handles too.
  const base = open(template, 9100), evidence = base.evidence!;
  const running = { id: 'early-running', kind: 'implementation', state: 'running', runtime: 'claude', principal: 'engineer-a', startedAt: stamp(1) };
  const shapes: Work[] = [
    { ...base, id: randomUUID(), key: 'SHAPE-1', candidate: { sha: evidence[0].sha, baseSha: evidence[0].baseSha, pr: 9100 } as Work['candidate'],
      autoDispatch: { ...base.autoDispatch!, review: { sha: sha(1, 'r') }, producers: [{ sha: sha(2, 'p') }], history: [] } as unknown as Work['autoDispatch'],
      evidence: [...evidence, { ...evidence[0], id: randomUUID(), sha: sha(1, 'r') }, { ...evidence[0], id: randomUUID(), sha: sha(2, 'p') }, { ...evidence[0], id: randomUUID(), sha: sha(3, 'z') }, { ...evidence[0], id: randomUUID(), baseSha: sha(9, 'z') }],
      sessions: [running, ...base.sessions!] as Work['sessions'],
      actionQueue: { actions: [], history: base.actionQueue!.history.map(row => ({ ...row, history: Array.from({ length: 7 }, (_, index) => ({ at: stamp(index), event: `step-${index}` })) })) } as unknown as Work['actionQueue'],
      observation: { prState: 'open', files: ['src/a.ts'], scopeFiles: [{ path: 'src/a.ts', digest: sha(1, 'f') }] } as unknown as Work['observation'] },
    // A stored document may still carry the retired queue fields (GY-1236): both projections tolerate them.
    { ...base, id: randomUUID(), key: 'SHAPE-2', queue: { sequence: 7, speculation: { carry: { evidence: [{ evidenceId: evidence[0].id, carried: true }, { evidenceId: evidence[1].id, carried: false }] } } },
      baseRefresh: { carry: { evidence: [{ evidenceId: evidence[2].id, carried: true }] } } as unknown as Work['baseRefresh'],
      evidence: evidence.map(entry => ({ ...entry, sha: sha(5, 'q') })), autoDispatch: null as unknown as Work['autoDispatch'], observation: null as unknown as Work['observation'], queueHistory: null } as unknown as Work,
    { ...base, id: randomUUID(), key: 'SHAPE-3', evidence: undefined, actionQueue: undefined, autoDispatch: undefined, sessions: undefined, queueHistory: undefined, observation: undefined, pipeline: undefined } as unknown as Work,
  ];
  await insert(shapes);
  const fromSql = async (ids: string[]) => new Map((await store.pool.query(`SELECT d.id, x.document::text AS text
    FROM (SELECT w.id::text AS id, ${detoasted('w.document')} AS document FROM work_items w WHERE w.id::text = ANY($1::text[]) OFFSET 0) d
    CROSS JOIN ${coordinationRelevance(coordinationTail)} CROSS JOIN LATERAL (SELECT ${coordinationDocumentSql} AS document) x`, [ids])).rows.map(row => [row.id as string, JSON.parse(row.text)]));
  const projected = await fromSql(shapes.map(shape => shape.id));
  for (const shape of shapes) assert.deepEqual(coordinationProjection(JSON.parse(JSON.stringify(shape))), projected.get(shape.id), `${shape.key}'s in-process projection is the SQL one`);

  await store.pool.query(`DELETE FROM work_items WHERE document->>'key' LIKE 'SHAPE-%'`);

  // A reconciliation pass saves the unreconciled items; the next read serves each saved row as the
  // projection the database builds from it, without projecting it again under the lock.
  await insert(Array.from({ length: 3 }, (_, n) => ({ ...open(template, 9200 + n), key: `SAVED-${n}` }) as Work));
  const before = (await store.pool.query(`SELECT document->>'key' AS key, (document->>'revision')::int AS revision FROM work_items WHERE document->>'key' LIKE 'SAVED-%'`)).rows;
  await engine.reconcile();
  const after = (await store.pool.query(`SELECT id::text AS id, document->>'key' AS key, (document->>'revision')::int AS revision FROM work_items WHERE document->>'key' LIKE 'SAVED-%'`)).rows;
  assert.ok(after.every(row => row.revision > before.find(entry => entry.key === row.key)!.revision), 'the pass saved every unreconciled item');
  const queries: string[] = [];
  const watched = { query: (text: string, values?: unknown[]) => { queries.push(text); return store.pool.query(text, values as unknown[]); } };
  const board = await lockedWork(watched, []), stored = await fromSql(after.map(row => row.id));
  for (const row of after) {
    const standIn = board.find(work => work.id === row.id)!;
    assert.ok(isStandIn(standIn), `${row.key} is read as a stand-in`);
    assert.deepEqual(JSON.parse(JSON.stringify(standIn)), stored.get(row.id), `${row.key}'s stand-in is the projection of the row as saved`);
  }
  assert.ok(!queries.some(text => text.includes('jsonb_to_record')), 'no row the pass saved is projected again on the next read');
});
