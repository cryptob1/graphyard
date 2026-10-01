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
import { isSettledSummary, lockedWork } from '../src/store/locked-read.js';
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

test('unit:locked-transactions-read-bounded — no transaction client reads every work item\'s document; each former call site reads the item, the open items and summaries', () => {
  const offenders: string[] = [];
  for (const file of sources(src)) {
    const text = readFileSync(file, 'utf8');
    // Every query on a transaction client (`db` / `client`) whose text reads work_items' document
    // with no WHERE: with or without ORDER BY, LIMIT-less, FOR UPDATE or not.
    for (const match of text.matchAll(/\b(db|client)\.query\(\s*([`'"])([\s\S]*?)\2/g)) {
      const sql = match[3];
      if (!/\bFROM\s+work_items\b/i.test(sql) || !/\bdocument\b/.test(sql.split(/\bFROM\s+work_items\b/i)[0])) continue;
      const after = sql.split(/\bFROM\s+work_items\b/i)[1];
      if (/\bWHERE\b|\bLIMIT\b|\bJOIN\b/i.test(after)) continue;
      offenders.push(`${relative(src, file)}:${text.slice(0, match.index).split('\n').length}: ${sql.slice(0, 80)}`);
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
  // Each former call site reads through lockedWork, naming the item it acts on.
  const engine = readFileSync(join(src, 'engine.ts'), 'utf8');
  assert.ok((engine.match(/lockedWork\(db, \[(id|work!?\.id)\]\)/g) ?? []).length >= 10, 'the engine\'s commands read their item, the open items and summaries');
  assert.match(engine, /const rows = await lockedRows\(db\)/, 'each reconciliation batch reads through the bounded read');
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
 * How long each coordination transaction held the lock, by the operation that took it, and how many
 * settled deliveries' whole documents (a summary drops the pipeline) its queries returned.
 */
const holds: { label: string; ms: number; settledDocuments: number }[] = [];
let label = 'other';
const settledDocument = (value: unknown) => !!value && typeof value === 'object' && (value as Work).stage === 'done' && !!(value as Work).pipeline;
function timeTransactions() {
  const original = store.transaction.bind(store);
  store.transaction = (async (fn: any, options: any) => original(async (db, now) => {
    const started = performance.now();
    let settledDocuments = 0;
    const counted = new Proxy(db, { get: (target, property) => property !== 'query' ? Reflect.get(target, property, target) : async (...args: unknown[]) => {
      const result = await (target.query as any)(...args);
      for (const row of result?.rows ?? []) if (settledDocument(row.document)) settledDocuments++;
      return result;
    } });
    try { return await fn(counted, now); } finally { holds.push({ label, ms: performance.now() - started, settledDocuments }); }
  }, options)) as typeof store.transaction;
}
async function held<T>(name: string, run: () => Promise<T>): Promise<{ result: T; ms: number }> {
  label = name; const from = holds.length;
  const result = await run();
  label = 'other';
  return { result, ms: holds.slice(from).reduce((total, entry) => total + entry.ms, 0) };
}

const sha = (n: number, salt = 'a') => (salt + n.toString(16)).padStart(40, '0').slice(-40);
const stamp = (minutes: number) => new Date(Date.parse('2026-09-01T00:00:00Z') + minutes * 60_000).toISOString();
const paths = (n: number, count: number) => Array.from({ length: count }, (_, index) => `src/area-${n % 37}/module-${index}.ts`);

/**
 * A delivered item as the live ledger holds one: its candidate merged and delivered, its pipeline
 * timeline, every evidence record with artifacts, the observation's per-file scope, long queue,
 * dispatch and action histories and its finished sessions — about 60 KB, nothing owed, so settled.
 */
function delivered(template: Work, n: number): Work {
  const id = randomUUID(), key = `DONE-${n}`;
  const at = stamp(n);
  return {
    ...structuredClone(template), id, key, title: `Delivered change ${n}`, description: `Why change ${n} mattered. `.repeat(40),
    stage: 'done', stageEnteredAt: at, ready: true, lease: null, queue: null, nextAction: null, blocker: null, plannedFiles: paths(n, 6),
    candidate: { sha: sha(n), baseSha: sha(n, 'b'), pr: 1000 + n } as Work['candidate'],
    submission: { epoch: 2, pr: 1000 + n } as Work['submission'],
    delivery: { mergedAt: at, mergeSha: sha(n, 'm'), authorizationRevision: 40 } as Work['delivery'],
    observation: { candidate: { sha: sha(n), baseSha: sha(n, 'b'), pr: 1000 + n, branch: `graphyard/done-${n}-2`, author: 'engineer-a' }, merged: true, mergeSha: sha(n, 'm'), mergedAt: at, mergeable: true, protected: true,
      checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews: [{ author: 'reviewer', state: 'APPROVED', commitId: sha(n), submittedAt: at }],
      files: paths(n, 40), scopeFiles: Array.from({ length: 300 }, (_, index) => ({ path: `src/area-${index}/file.ts`, digest: sha(index, 'f') })), baseTip: sha(n, 'b'), at } as unknown as Work['observation'],
    evidence: Array.from({ length: 24 }, (_, index) => ({ id: randomUUID(), proof: `unit:proof-${index % 6}`, sha: sha(n - (index % 4)), baseSha: sha(n, 'b'), policyRevision: 3, producer: 'producer-a', trusted: true, result: 'pass', executed: 12, skipped: 0, at,
      artifacts: Array.from({ length: 6 }, (_, artifact) => ({ name: `artifact-${artifact}.log`, sha256: sha(artifact, 'c'), bytes: 4096, url: `https://example.invalid/runs/${n}/${index}/${artifact}` })), provenance: { runner: 'local', command: 'node --test', environment: 'linux' } })) as unknown as Work['evidence'],
    queueHistory: Array.from({ length: 40 }, (_, index) => ({ sequence: index, event: 'entered', at, reason: `queued behind ${index} entries` })) as unknown as Work['queueHistory'],
    actionQueue: { actions: [], history: Array.from({ length: 80 }, (_, index) => ({ id: randomUUID(), kind: 'resync', state: 'done', result: 'done', requestedAt: at, resolvedAt: at, history: [{ at, event: 'requested' }, { at, event: 'claimed' }, { at, event: 'settled' }] })) } as unknown as Work['actionQueue'],
    autoDispatch: { review: null, producers: [], history: Array.from({ length: 40 }, (_, index) => ({ id: randomUUID(), kind: 'review', sha: sha(n - index), requestedAt: at, resolvedAt: at, outcome: 'answered' })) } as unknown as Work['autoDispatch'],
    sessions: Array.from({ length: 30 }, (_, index) => ({ id: `s-${n}-${index}`, kind: 'implementation', state: 'finished', runtime: 'claude', principal: 'engineer-a', startedAt: at, endedAt: at, outcome: 'finished: submitted the pull request and completed the attempt' })) as unknown as Work['sessions'],
    pipeline: { attempts: Array.from({ length: 30 }, (_, index) => ({ epoch: index, owner: 'engineer-a', claimedAt: at, endedAt: at, end: 'submitted' })), submittedAt: at, reworkRounds: 3 } as unknown as Work['pipeline'],
  } as Work;
}
/** An open item: ready, unassigned, with its own planned files and a short history. */
function open(template: Work, n: number): Work {
  return { ...structuredClone(template), id: randomUUID(), key: `OPEN-${n}`, title: `Open change ${n}`, description: `What open change ${n} must do. `.repeat(30), plannedFiles: paths(n, 4), ready: n % 2 === 0, stage: 'backlog' } as Work;
}
async function insert(documents: Work[]) {
  for (let from = 0; from < documents.length; from += 50) {
    const slice = documents.slice(from, from + 50);
    await store.pool.query('INSERT INTO work_items(id, document) SELECT (d->>\'id\')::uuid, d FROM jsonb_array_elements($1::jsonb) AS d', [JSON.stringify(slice)]);
  }
}

let template: Work, opened = 0, closed = 0, prs = 0;
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
  template = await engine.execute(operator, 'create', null, { title: 'Template', plannedFiles: ['src/template/'], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:bench'] }] }, randomUUID());
  timeTransactions();
  await seed(400, 60);
  const few = await measure('few');
  await seed(0, 540);
  const count = Number((await store.pool.query('SELECT count(*) FROM work_items')).rows[0].count);
  const settled = Number((await store.pool.query('SELECT count(*) FROM work_index WHERE settled')).rows[0].count);
  assert.ok(count >= 1000, `${count} items`); assert.equal(settled, 600, 'every delivered item is settled');
  const bytes = Number((await store.pool.query("SELECT sum(pg_column_size(document)) FROM work_items WHERE document->>'stage' = 'done'")).rows[0].sum);
  assert.ok(bytes / 600 > 8_000, `a delivered document stores ${Math.round(bytes / 600)} bytes compressed`);
  const fromMany = holds.length;
  const many = await measure('many');
  // Not one delivered document is read whole by these commands: each reads summaries of the history.
  const reread = holds.slice(fromMany).filter(entry => entry.label !== 'other' && entry.settledDocuments > 0);
  assert.deepEqual(reread.map(entry => `${entry.label}: ${entry.settledDocuments}`), [], 'claim, renew, submit and select read no delivered document whole');
  console.log(`lock hold (median ms) with 60 delivered: ${JSON.stringify(few)}; with 600 delivered: ${JSON.stringify(many)}`);
  for (const name of ['claim', 'renew', 'submit', 'select'] as const) {
    assert.ok(many[name] < 500, `${name} held the coordination lock ${many[name].toFixed(0)} ms with 600 delivered items`);
    // Ten times the delivered history: the hold stays within noise of the small ledger's (a loaded
    // host slows both rounds alike, so the noise allowance scales with the small ledger's hold).
    assert.ok(many[name] - few[name] < Math.max(30, few[name]), `${name} grew from ${few[name].toFixed(0)} ms to ${many[name].toFixed(0)} ms when the delivered history grew tenfold`);
  }

  // What a locked read hands out: the item and every open item whole, each settled delivery as its
  // summary — and a summary is never saved over its document.
  const target = (await store.pool.query("SELECT document FROM work_items WHERE document->>'key' = 'DONE-3'")).rows[0].document as Work;
  const all = await lockedWork(store.pool, []);
  assert.equal(all.length, Number((await store.pool.query('SELECT count(*) FROM work_items')).rows[0].count));
  const summary = all.find(item => item.key === 'DONE-3')!;
  assert.ok(isSettledSummary(summary) && !summary.pipeline && (summary.sessions ?? []).length === 0, 'a settled delivery is read as its summary');
  assert.deepEqual([summary.stage, summary.plannedFiles, summary.delivery, (summary.observation as any).files], [target.stage, target.plannedFiles, target.delivery, (target.observation as any).files], 'the summary keeps what decisions read');
  assert.ok(all.filter(item => item.stage !== 'done').every(item => !isSettledSummary(item)), 'every open item is read whole');
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
  const reread = batches.reduce((sum, entry) => sum + entry.settledDocuments, 0);
  console.log(`reconcile pass: ${batches.length} batches, ${total.toFixed(0)} ms of lock hold, longest ${longest.toFixed(0)} ms, ${reread} delivered documents read whole`);
  // Each batch reads its own open rows whole and every delivered item as its compact summary: not
  // one of the 600 delivered documents is read under the lock, in any batch.
  assert.equal(reread, 0, `${reread} delivered documents were read whole over ${batches.length} batches (${batches.map(entry => entry.settledDocuments).join(', ')})`);
  assert.ok(total < 5_000, `a full pass held the lock ${total.toFixed(0)} ms over ${batches.length} batches`);
  // The budget counts from before the read: a batch overruns it by at most the one item it always completes.
  assert.ok(longest < engine.reconcileBatchMs + 250, `the longest batch held the lock ${longest.toFixed(0)} ms against a ${engine.reconcileBatchMs} ms budget`);
  // A second pass changes nothing it does not need to and still reads no delivered document.
  const again = holds.length; label = 'reconcile';
  await engine.reconcile(); label = 'other';
  assert.ok(holds.slice(again).reduce((sum, entry) => sum + entry.ms, 0) < 5_000);
  assert.equal(holds.slice(again).reduce((sum, entry) => sum + entry.settledDocuments, 0), 0, 'a second pass reads no delivered document whole');
});
