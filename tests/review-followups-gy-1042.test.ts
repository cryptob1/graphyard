import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store, save } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { ejectedCheckLift } from '../src/merge-queue.js';
import { boundLockedCache, isStandIn, lockedRows, lockedWork, rememberSaved, savedVersions, warmLockedReads, withWhole, type Queryable } from '../src/store/locked-read.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1042: the follow-ups from the approved reviews of GY-1027 (PR #533). The first case records how
 * each listed finding was answered; the others prove the ones answered in code.
 */

type Triage = { findings: number[]; path: string; status: 'addressed' | 'declined'; resolution: string };
const triage: Triage[] = [
  { findings: [1], path: 'deploy/systemd/graphyard-secrets-bus.service', status: 'declined',
    resolution: 'Restricted as far as D-Bus rules allow: GY-1039, merged since, moved the filter to graphyard-secrets-bus-filter.service and admits only the Secret Service methods a credential read needs, and gives the bus only to sessions without a credential of their own. Restricting it to the GitHub item alone is not expressible: xdg-dbus-proxy filters by bus name, method and object path, and keyring items are numbered paths that name no service. The remaining exposure is stated in the unit file and docs/operations.md#worker-host-keyring-proxy; a per-session credential broker is a design of its own.' },
  { findings: [2], path: 'src/store/locked-read.ts', status: 'addressed',
    resolution: 'Addressed by GY-1027\'s later revisions before it merged: an open item that is not the focus, a batch\'s own row or related to them is a cached compact projection (coordinationDocumentSql), not its document.' },
  { findings: [3, 13, 16, 22, 23, 24, 26, 28, 32, 35, 37, 40, 44], path: 'src/store/locked-read.ts', status: 'declined',
    resolution: 'lockedWork answers with every work item in number order — each caller evaluates against the whole board — so one row per item is inherent to its contract; the listing reads only number, id and two xmins (no documents, no detoasting), and validating a cache by a counter instead would need a write-side change counter maintained by every writer, a schema change out of proportion to rows this small. Making it constant means callers that do not need the whole board, which is a separate design.' },
  { findings: [4], path: 'src/server/decisions.ts', status: 'addressed',
    resolution: 'Already one import line on main (`import { lockedWork, workIdByRef } from \'../store/locked-read.js\'`); nothing left to merge.' },
  { findings: [5], path: 'tests/coordinator-os-confinement.test.ts', status: 'addressed',
    resolution: 'The unit:allocated-checkout-re-exposed title has its space after the em dash again.' },
  { findings: [6, 14, 20], path: 'src/master/profiles.ts', status: 'addressed',
    resolution: 'docs/operations.md#worker-host-keyring-proxy documents the install step for the graphyard-secrets-bus socket, forwarder and filter units, its default socket, the GRAPHYARD_SECRETS_BUS override and the fallback without it; docs/master-agent-sessions.md links it (that page is at its word budget).' },
  { findings: [7, 8], path: 'src/engine.ts', status: 'addressed',
    resolution: 'observeSubmission (outside the coordination lock) reads every open submitted peer whole (withWhole) before the submit-time landing check, so a carried peer\'s observation.scopeFiles are there to detect a dropped file.' },
  { findings: [9, 17, 46], path: 'src/store/locked-read.ts', status: 'addressed',
    resolution: 'A stand-in\'s version adds the item\'s work-index revision, which every save advances, so a row version a wrapped-around transaction id repeats cannot name an older stand-in.' },
  { findings: [10, 12, 15], path: 'src/engine.ts', status: 'declined',
    resolution: 'A batch cannot stop inside one item\'s evaluation without abandoning a half-made decision, and a pass-level budget would leave items unreconciled each tick; the batch bound already holds every batch to its budget plus one item, the lock is released between batches, and the total per pass is GY-1027\'s measured AC-6 proof. Cheaper per-item reconcile work is ordinary performance work, not a follow-up of this change.' },
  { findings: [11, 25, 29, 33, 36, 43], path: 'tests/locked-read.test.ts', status: 'addressed',
    resolution: 'The AC-1 source scan reads queries on any receiver, resolves a module SQL constant named in place of a literal, and exempts only a WHERE or LIMIT, never a JOIN; the two whole-board readers outside any transaction are named, and the scan is shown to catch each form the review named.' },
  { findings: [18, 30], path: 'tests/fleet-sessions.test.ts', status: 'addressed',
    resolution: 'The literal-timeout guard parses each httpFleetClient and fleetRequest call and refuses a literal third argument, a `?? <number>` fallback and a `timeoutMs: <number>`, and is shown to refuse each form.' },
  { findings: [19, 47], path: 'src/store/locked-read.ts', status: 'addressed',
    resolution: 'Engine.reconcile warms the stand-in cache (warmLockedReads) outside the lock on a process\'s first pass, so its opening locked read finds the stand-ins cached; a cold-cache case here measures the locked read after the warm-up fetching none.' },
  { findings: [21], path: 'src/store/locked-read.ts', status: 'addressed',
    resolution: 'save records the exact text it wrote (noteSaved); savedVersions hands rememberSaved that text, never the in-memory object, so a later unsaved change to a saved item is never cached as its stand-in.' },
  { findings: [27], path: 'src/store/locked-read.ts', status: 'addressed',
    resolution: 'The module comment states what a projection leaves out and that a decision reading those fields on another item must read it whole; a case here holds a projection to that contract (no scopeFiles or pipeline, assignment throws).' },
  { findings: [31, 34], path: 'tests/one-reviewer-per-request.test.ts', status: 'addressed',
    resolution: 'Addressed by GY-1111 (b142468f40, after CI run 36976350300), which drives the cycle-versus-dispatcher launch race explicitly through each interleaving instead of leaving it to timing.' },
  { findings: [38, 41], path: 'src/store/locked-read.ts', status: 'declined',
    resolution: 'The cluster query is one sub-millisecond round trip, and its value must be read inside the call: a process caching it would miss a postmaster restart (a restored cluster can repeat transaction ids), which is exactly what the cluster scope in a stand-in\'s version guards.' },
  { findings: [39], path: 'src/server/followups.ts', status: 'declined',
    resolution: 'Both migrations run once per deployment, and their second, focused read is what lets them write the items they move; reusing the first listing would save one listing of tiny rows once, at the cost of a special path through lockedWork.' },
  { findings: [42], path: 'src/store/locked-read.ts', status: 'addressed',
    resolution: 'A call takes every cache hit into its own map before it caches anything it fetches, so the bounded cache evicting a hit while this call caches its misses no longer sends it to a whole read under the lock.' },
  { findings: [45], path: 'src/merge-queue.ts', status: 'addressed',
    resolution: 'ejectedCheckLift counts a predecessor closed without merging (isClosed) as departed, so a rerun passing cannot restore a speculative tip that still carries its unlanded commits.' },
];

test('manual:review-followups-triaged GY-1042 — each follow-up listed in the description is addressed in code, or declined with a recorded reason (AC-1)', () => {
  const listed = triage.flatMap(entry => entry.findings).sort((a, b) => a - b);
  assert.deepEqual(listed, Array.from({ length: 47 }, (_, index) => index + 1), 'every listed finding is answered exactly once');
  for (const entry of triage) {
    assert.ok(entry.resolution.length > 40, `finding ${entry.findings.join(', ')} records its resolution or reason`);
    assert.ok(['addressed', 'declined'].includes(entry.status));
  }
});

const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'engineer-a', role: 'worker', runtime: 'claude', sessionKind: 'ai' };
let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  // An offset no other test file takes: two files sharing a port fail in their `before` hook.
  const port = Number(process.env.GRAPHYARD_FOLLOWUPS_1042_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1042);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('followups-1042'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('followups_1042');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/followups_1042`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/followups');
  engine.principals = [operator, worker];
});
after(async () => { boundLockedCache(); if (store) await store.close(); if (database) await database.stop(); });

const create = (title: string, plannedFiles: string[]) => engine.execute(operator, 'create', null, { title, plannedFiles, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:x'] }] }, randomUUID());
/** `db` with every query's text recorded. */
const recorded = (db: Queryable, texts: string[]): Queryable => ({ query: (text, values) => { texts.push(text); return db.query(text, values); } });
const projects = (texts: string[]) => texts.filter(text => /CROSS JOIN LATERAL/.test(text)).length;
const summarises = (texts: string[]) => texts.filter(text => /summary::text AS text FROM work_index/.test(text)).length;
const readsWhole = (texts: string[]) => texts.filter(text => /^SELECT number, document FROM work_items/.test(text)).length;
async function locked<T>(run: (db: Queryable) => Promise<T>) {
  const client = await store.pool.connect();
  try { await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

test('unit:locked-read-cold-cache-warmed — a fresh process warms the stand-in cache outside the lock, so its first locked read projects nothing (GY-1042 findings 19, 47)', async () => {
  // This file runs in its own process, so the cache starts cold, as after each deploy.
  for (let n = 0; n < 6; n++) await create(`Cold ${n}`, [`src/cold-${n}/`]);
  const cold: string[] = [];
  await warmLockedReads(recorded(store.pool, cold));
  assert.ok(projects(cold) >= 1, 'the warm-up, outside any transaction, built the projections');
  const warm: string[] = [];
  await locked(db => lockedRows(recorded(db, warm), []));
  assert.equal(projects(warm), 0, 'the locked read found every stand-in cached');
  assert.equal(readsWhole(warm), 0);
  // The engine warms on its first pass, before the pass's opening locked read.
  const engineSource = readFileSync(fileURLToPath(new URL('../src/engine.ts', import.meta.url)), 'utf8');
  const reconcile = engineSource.slice(engineSource.indexOf('  private async reconcileTick() {'));
  assert.ok(reconcile.indexOf('await warmLockedReads(this.store.pool)') > 0 && reconcile.indexOf('await warmLockedReads(this.store.pool)') < reconcile.indexOf('await lockedRows(db, [])') && reconcile.indexOf('  private async reconcileTick() {') === 0, 'reconcile warms the cache before its opening locked read');
});

test('unit:locked-read-keeps-cache-hits — a call that caches its misses past the cache bound still serves the hits it found, never reading them whole (GY-1042 finding 42)', async () => {
  const items = [];
  for (let n = 0; n < 8; n++) items.push(await create(`Bounded ${n}`, [`src/bounded-${n}/`]));
  await lockedWork(store.pool, []);
  boundLockedCache(8);
  try {
    // Rewrite half of them: the next call has hits and misses, and caching the misses evicts hits.
    for (const work of items.slice(0, 4)) await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    await lockedWork(store.pool, []);
    for (const work of items.slice(4)) await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    const texts: string[] = [];
    const rows = await locked(db => lockedRows(recorded(db, texts), []));
    assert.equal(readsWhole(texts), 0, 'no stand-in fell through to a whole read');
    assert.ok(rows.every(row => isStandIn(row.document)), 'every unfocused item is a stand-in');
  } finally { boundLockedCache(); }
});

test('unit:locked-read-version-names-revision — a stand-in\'s version names the item\'s revision, so a row version repeated at another revision is not served from the cache (GY-1042 findings 9, 17, 46)', async () => {
  const work = await create('Versioned', ['src/versioned/']);
  await lockedWork(store.pool, []);
  const again: string[] = [];
  await lockedWork(recorded(store.pool, again), []);
  assert.equal(projects(again), 0, 'unchanged, the stand-in is cached');
  // The same row version (its xmin unchanged) at another revision, as a wrapped transaction id would present it.
  await store.pool.query('UPDATE work_index SET revision = revision + 1000 WHERE id = $1', [work.id]);
  const moved: string[] = [];
  await lockedWork(recorded(store.pool, moved), []);
  assert.equal(projects(moved), 1, 'the item is projected afresh');
});

test('unit:saved-stand-in-is-what-save-wrote — a batch caches the text each save wrote, not a later unsaved change to the object (GY-1042 finding 21)', async () => {
  const work = await create('Saved', ['src/saved/']);
  let saved: Awaited<ReturnType<typeof savedVersions>> = [];
  await store.transaction(async (db, now) => {
    const [document] = (await db.query('SELECT document FROM work_items WHERE id = $1', [work.id])).rows.map(row => row.document as Work);
    document.title = 'Saved title';
    await save(db, document, operator.id, 'test', now);
    document.title = 'Changed after the save, never saved';
    saved = await savedVersions(db, [document]);
  });
  assert.equal(saved.length, 1);
  rememberSaved(saved);
  const texts: string[] = [];
  const standIn = (await lockedWork(recorded(store.pool, texts), [])).find(item => item.id === work.id)!;
  assert.equal(projects(texts), 0, 'the saved row\'s stand-in came from the cache');
  assert.equal(standIn.title, 'Saved title');
});

test('unit:projection-contract — an open item\'s projection leaves out its per-file scope, artifacts and pipeline and refuses assignment; a submission\'s landing check reads open submitted peers whole (GY-1042 findings 7, 8, 27)', async () => {
  const peer = await create('Submitted peer', ['src/peer/']);
  const scopeFiles = [{ path: 'src/peer/a.ts', status: 'modified', sha: 'a'.repeat(40) }];
  const submitted = { ...peer, stage: 'review', submission: { epoch: 1, pr: 7001 }, candidate: { sha: 'c'.repeat(40), baseSha: 'b'.repeat(40), pr: 7001 },
    observation: { candidate: { sha: 'c'.repeat(40), baseSha: 'b'.repeat(40), pr: 7001 }, merged: false, prState: 'open', checks: [], files: ['src/peer/a.ts'], scopeFiles, at: new Date().toISOString() },
    pipeline: { attempts: [], submittedAt: new Date().toISOString(), reworkRounds: 0 } } as unknown as Work;
  await store.pool.query('UPDATE work_items SET document = $2 WHERE id = $1', [peer.id, JSON.stringify(submitted)]);
  const projection = (await lockedWork(store.pool, [])).find(item => item.id === peer.id)!;
  assert.ok(isStandIn(projection));
  assert.equal(projection.observation?.scopeFiles, undefined, 'the projection carries no per-file scope');
  assert.equal((projection as any).pipeline, undefined);
  assert.throws(() => { (projection as any).title = 'edited'; }, TypeError);
  const whole = (await withWhole(store.pool, await lockedWork(store.pool, []), item => item.stage !== 'done' && !!item.submission)).find(item => item.id === peer.id)!;
  assert.ok(!isStandIn(whole));
  assert.deepEqual(whole.observation?.scopeFiles, scopeFiles, 'read whole, the peer carries its scope for the landing check');

  // The submit-time observation hands the provider that whole peer.
  let focus = await create('Submitting', ['src/submitting/']);
  focus = await engine.execute(operator, 'ready', focus.id, {}, randomUUID());
  focus = await engine.execute(worker, 'claim', focus.id, {}, randomUUID());
  focus = await engine.execute(worker, 'workspace', focus.id, { epoch: focus.epoch, host: 'host-a', path: `/tmp/followups/${focus.id}`, branch: `graphyard/${focus.key.toLowerCase()}-${focus.epoch}` }, randomUUID());
  let peers: Work[] = [];
  const stop = new Error('observed');
  engine.submissionObserver = async (_probe, all) => { peers = all ?? []; throw stop; };
  try {
    await assert.rejects(engine.execute(worker, 'submit', focus.id, { epoch: focus.epoch, pr: 7002 }, randomUUID()), error => error === stop);
  } finally { engine.submissionObserver = null; }
  assert.deepEqual(peers.find(item => item.id === peer.id)?.observation?.scopeFiles, scopeFiles, 'the landing check saw the peer\'s scope files');
});

test('unit:closed-predecessor-departed — an ejection is not lifted on a tip built behind a predecessor closed without merging (GY-1042 finding 45)', () => {
  const head = 'a'.repeat(40), base = 'b'.repeat(40);
  const work = {
    id: randomUUID(), key: 'GY-2', stage: 'build', queue: null, policyRevision: 1, policy: { checks: ['test'], review: true },
    candidate: { sha: head, baseSha: base, pr: 2 },
    observation: { candidate: { sha: head, baseSha: base, pr: 2 }, merged: false, prState: 'open', requiredChecks: [],
      checks: [{ name: 'test', result: 'failure', appId: 15368, id: 1 }, { name: 'test', result: 'success', appId: 15368, id: 2 }] },
    queueEjection: { sha: head, policyRevision: 1, check: { name: 'test', runId: 1, tip: head } },
    queueHistory: [{ event: 'predicted', tip: head, predecessors: ['GY-1'] }],
  } as unknown as Work;
  const predecessor = (closure: object | null) => ({ id: randomUUID(), key: 'GY-1', stage: 'done', queue: null, closure }) as unknown as Work;
  assert.equal(ejectedCheckLift(work, [predecessor(null), work], [15368])?.check, 'test', 'behind a delivered predecessor the passing rerun lifts');
  assert.equal(ejectedCheckLift(work, [predecessor({ kind: 'obsolete', reason: 'not wanted', ref: null, by: 'operator', at: new Date().toISOString(), from: 'review' }), work], [15368]), null,
    'behind a predecessor closed without merging the ejection stands');
});
