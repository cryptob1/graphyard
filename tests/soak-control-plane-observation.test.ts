import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { MergerSettings } from '../src/merger-mode.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { processControlPlaneJob } from '../src/server/control-plane-observation.js';
import { observationWorkers } from '../src/server/main.js';
import type { GitHub } from '../src/github.js';
import type { Principal } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1675: an install with no GitHub App observes every open candidate from its own checkout, one
 * job per item every twenty seconds. Across many cycles, several items, a base tip that moves and
 * a checkout that loses its base ref, the repeated job keeps the system invariants: one job row per
 * item, every submitted item observed against the head it submitted and the base tip of the moment,
 * each cycle saving exactly one observation per submitted item (the freshness the stale-observation
 * check reads) and nothing more, a failed observation retried at its
 * bounded cadence and never against a stand-in base, and an item with nothing submitted deferred.
 * The workers choose the backend from the recorded merger: beside a GitHub client (an App-bound
 * install switched to the control plane) the checkout observes and the client is never consulted,
 * and once GitHub is the merger again the client observes and the checkout writes nothing.
 */
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let pg: EmbeddedPostgres, store: Store, engine: Engine, fixtureRoot: string, checkout: string;

async function commit(cwd: string, path: string, text: string, message: string) {
  await mkdir(join(cwd, path, '..'), { recursive: true });
  await writeFile(join(cwd, path), text); git(cwd, 'add', '--', path); git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}
before(async () => {
  fixtureRoot = await realpath(await temporaryDirectory('soak-control-plane-observation'));
  const origin = join(fixtureRoot, 'origin.git'); checkout = join(fixtureRoot, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  git(checkout, 'config', 'user.email', 't@example.com'); git(checkout, 'config', 'user.name', 'T');
  await commit(checkout, 'README.md', '# Fixture\n', 'base');
  git(checkout, 'push', '-q', 'origin', 'main');
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1675;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('soak-control-plane-observation-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('soak_control_plane_observation');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/soak_control_plane_observation`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.submissionObserver = null; engine.directMergeEnvironment = null;
  engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
  await new MergerSettings(store).change(operator, { merger: 'control-plane', reason: 'the soak runs an App-less install' }, randomUUID());
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });

/** An item claimed by the worker on its own linked worktree, with one commit there. */
async function claimed(n: number) {
  let w = await engine.execute(operator, 'create', null, { title: `Observed ${n}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, randomUUID());
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID());
  const pulled = await engine.pullAssignment(worker, { work: w.id }, randomUUID());
  assert.equal(pulled.assigned?.id, w.id, JSON.stringify(pulled.refused));
  const branch = `graphyard/gy-${n}-1`, worktree = join(checkout, '.graphyard', 'worktrees', `GY-${n}-1`);
  git(checkout, 'worktree', 'add', '-q', '-b', branch, worktree, 'refs/remotes/origin/main');
  git(worktree, 'config', 'user.email', 't@example.com'); git(worktree, 'config', 'user.name', 'T');
  const head = await commit(worktree, `src/item-${n}.ts`, `export const item = ${n};\n`, `item ${n}`);
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: worktree, branch }, randomUUID());
  return { w, head };
}
/** Every job due now, as the twenty-second cadence makes it on the next cycle. */
const due = () => store.pool.query('UPDATE jobs SET available_at=now() WHERE locked_until IS NULL OR locked_until<now()');
const jobs = async () => (await store.pool.query('SELECT work_id::text, error, deferred_reason, available_at > now() AS later, token IS NOT NULL AS held FROM jobs ORDER BY work_id')).rows as { work_id: string; error: string | null; deferred_reason: string | null; later: boolean; held: boolean }[];
/** The item's revision: every saved change to it bumps it once. */
const history = async (id: string) => (await store.workDocument(id))!.revision;
/** One observation cycle: each worker claims due jobs until none is due, as `observationWorkers` does. */
async function cycle() {
  await due();
  let claims = 0;
  while (await processControlPlaneJob(engine)) { claims++; assert.ok(claims <= 20, 'a cycle claims each due job once, never spins'); }
  return claims;
}

test('soak:control-plane-observation — the App-less observation job, run across cycles, items, a moving base tip and a lost base ref, keeps one job per item, observes each submitted head against the base of the moment, saves exactly one observation per item per cycle, and never observes against the checkout\'s HEAD, and whose workers choose that backend from the recorded merger, never from a GitHub client\'s presence (GY-1675)', async () => {
  const items = await Promise.all([1, 2, 3].map(claimed));
  for (const { w, head } of items) await engine.execute(worker, 'submit', w.id, { epoch: 1, head }, randomUUID());
  // An item claimed and never submitted: its job, if it has one, is deferred rather than observed each cycle.
  const pending = await claimed(4);
  await store.pool.query('INSERT INTO jobs(work_id) VALUES ($1) ON CONFLICT DO NOTHING', [pending.w.id]);
  const ids = items.map(item => item.w.id);
  const tip = () => git(checkout, 'rev-parse', 'refs/remotes/origin/main');

  // Steady state: each cycle claims each job once and saves one observation per submitted item, nothing more.
  for (let round = 0; round < 3; round++) await cycle();
  const pendingRevision = await history(pending.w.id);
  for (let round = 0; round < 10; round++) {
    const before = await Promise.all(ids.map(history));
    assert.equal(await cycle(), 4, 'one claim per item per cycle');
    const rows = await jobs();
    assert.equal(rows.length, 4, 'one job row per item, never a duplicate');
    for (const row of rows) assert.equal(row.error, null, `no observation failed: ${row.error}`);
    assert.ok(rows.find(row => row.work_id === pending.w.id)?.deferred_reason === 'no submission to observe', 'the unsubmitted item is deferred');
    for (const [index, { w, head }] of items.entries()) {
      const item = (await store.workDocument(w.id))!;
      assert.equal(item.observation?.source, 'control-plane');
      assert.equal(item.observation?.candidate.sha, head, 'each item is observed at the head it submitted');
      assert.equal(item.observation?.baseTip, tip());
      assert.equal(await history(w.id), before[index] + 1, `item ${index + 1}: one save per cycle in cycle ${round}, no churn beyond the observation`);
    }
  }
  assert.equal((await store.workDocument(pending.w.id))!.observation ?? null, null, 'an unsubmitted item is never observed');
  assert.equal(await history(pending.w.id), pendingRevision, 'and its record never moves');

  // The base tip moves: the next cycle observes every head against the new tip, which they do not contain, once.
  await commit(checkout, 'src/base.ts', 'export const base = 2;\n', 'base moves');
  git(checkout, 'push', '-q', 'origin', 'main');
  const beforeMove = await Promise.all(ids.map(history));
  await cycle();
  const moved = await Promise.all(ids.map(history));
  assert.deepEqual(moved, beforeMove.map(revision => revision + 1), 'the moved tip is one save per item');
  for (const { w } of items) {
    const item = (await store.workDocument(w.id))!;
    assert.equal(item.observation?.baseTip, tip()); assert.equal(item.observation?.baseTipContained, false);
  }
  for (let round = 0; round < 5; round++) await cycle();
  assert.deepEqual(await Promise.all(ids.map(history)), moved.map(revision => revision + 5), 'five cycles, five saves per item');
  const failedFrom = await Promise.all(ids.map(history));

  // The checkout loses both base refs while its HEAD still resolves: each job fails and retries at its bounded cadence, and no observation is taken against HEAD.
  const lostTip = tip();
  git(checkout, 'checkout', '-q', '--detach');
  git(checkout, 'update-ref', '-d', 'refs/remotes/origin/main'); git(checkout, 'update-ref', '-d', 'refs/heads/main');
  for (let round = 0; round < 5; round++) {
    await due();
    let claims = 0;
    while (claims < 10) { await processControlPlaneJob(engine); claims++; if (!(await jobs()).some(row => !row.later)) break; }
    assert.ok(claims <= 4, `each failing job is claimed once per cycle, not retried at once (${claims})`);
    const rows = await jobs();
    assert.equal(rows.length, 4);
    for (const id of ids) assert.match(rows.find(row => row.work_id === id)!.error ?? '', /holds no refs\/remotes\/origin\/main or refs\/heads\/main/);
    for (const { w } of items) assert.equal((await store.workDocument(w.id))!.observation?.baseTip, lostTip, 'the last good observation stands; HEAD never replaces the base');
  }
  assert.deepEqual(await Promise.all(ids.map(history)), failedFrom, 'a failing observation saves nothing');

  // The ref comes back: the next cycle observes again and clears the errors.
  git(checkout, 'update-ref', 'refs/remotes/origin/main', lostTip);
  await cycle();
  for (const id of ids) assert.equal((await jobs()).find(row => row.work_id === id)!.error, null);

  // The ledger says github: a server with no App claims nothing, so a checkout that is not the merger never writes an observation (review of 10cb17d2).
  await new MergerSettings(store).change(operator, { merger: 'github', reason: 'GitHub merges again' }, randomUUID());
  const gatedFrom = await Promise.all(ids.map(history));
  for (let round = 0; round < 3; round++) {
    await due();
    for (let claims = 0; claims < 5; claims++) assert.equal(await processControlPlaneJob(engine), false, 'nothing is claimed while GitHub is the recorded merger');
  }
  assert.deepEqual(await Promise.all(ids.map(history)), gatedFrom, 'no observation is written');
  assert.ok((await jobs()).every(row => !row.later), 'the due jobs stay due for the merger that owns them, neither taken nor deferred');
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM jobs WHERE token IS NOT NULL')).rows[0].n, 0, 'no job is held');
  await new MergerSettings(store).change(operator, { merger: 'control-plane', reason: 'the soak runs an App-less install' }, randomUUID());
  assert.equal(await cycle(), 4, 'the control plane claims again once it is the merger');

  // The claim race: a submission between the pre-claim fleet read and the claim creates the candidate and wakes the job claimed.
  // The claimed item is judged as it stands after the claim, so that job is observed, never dropped on the stale snapshot.
  const racedHead = git(join(checkout, '.graphyard', 'worktrees', 'GY-4-1'), 'rev-parse', 'HEAD');
  await store.pool.query('UPDATE jobs SET available_at=now() - interval \'1 hour\' WHERE work_id=$1', [pending.w.id]);
  await store.pool.query(`UPDATE jobs SET available_at=now() + interval '1 hour' WHERE work_id<>$1`, [pending.w.id]);
  const fleet = store.fleet.bind(store);
  store.fleet = async (options?: Parameters<Store['fleet']>[0]) => {
    const all = await fleet(options);
    store.fleet = fleet;
    await engine.execute(worker, 'submit', pending.w.id, { epoch: 1, head: racedHead }, randomUUID());
    return all;
  };
  try { assert.equal(await processControlPlaneJob(engine), true, 'the job woken by the submission is claimed and observed'); }
  finally { store.fleet = fleet; }
  const raced = (await store.workDocument(pending.w.id))!;
  assert.equal(raced.observation?.source, 'control-plane'); assert.equal(raced.observation?.candidate.sha, racedHead, 'the submission landed in the race is observed in the same claim');
  const racedJob = (await jobs()).find(row => row.work_id === pending.w.id);
  assert.ok(racedJob, 'the job row survives the race');
  assert.equal(racedJob.error, null); assert.equal(racedJob.deferred_reason, null, 'it is finished, not deferred as unsubmitted');

  // An App-bound install switched to the control plane (`master merger control-plane`, review of 355a8b88): a GitHub client
  // exists, yet the workers observe from the checkout and never consult it, since an allocated change number answers to no
  // pull request; switched back to GitHub, the client is what observes and the checkout writes nothing; switched again, the
  // checkout observes again. The backend follows the recorded merger, read before every claim, never the client's presence.
  const consulted: string[] = [];
  const client = new Proxy({}, { get: (_target, property) => {
    consulted.push(String(property));
    if (property === 'observe') return () => { throw new Error('the soak\'s GitHub client observes nothing'); };
    if (property === 'budget') return () => ({ paused: null, remaining: null, belowReserve: false, exhaustsBeforeReset: false, pace: { perMinute: null } });
    if (property === 'recordDeferral') return () => {};
    return undefined;
  } }) as unknown as GitHub;
  let stop = false;
  const workers = observationWorkers(engine, client, 2, () => stop, 20);
  const everyId = [...ids, pending.w.id];
  const settled = async (what: string) => {
    for (let waited = 0; waited < 500; waited++) { if ((await jobs()).every(row => row.later && !row.held)) return; await sleep(10); }
    assert.fail(`${what}: the workers did not take and finish every due job: ${JSON.stringify(await jobs())}`);
  };
  try {
    for (let round = 0; round < 5; round++) {
      const before = await Promise.all(everyId.map(history));
      await due(); await settled(`control-plane cycle ${round}`);
      assert.deepEqual(await Promise.all(everyId.map(history)), before.map(revision => revision + 1), `cycle ${round}: one local observation per item beside an unused GitHub client`);
      for (const id of everyId) assert.equal((await store.workDocument(id))!.observation?.source, 'control-plane');
      assert.ok((await jobs()).every(row => row.error === null), 'no observation failed');
    }
    assert.equal(consulted.length, 0, `the GitHub client is never consulted while the control plane is the recorded merger (consulted: ${[...new Set(consulted)].join(', ')})`);

    await new MergerSettings(store).change(operator, { merger: 'github', reason: 'GitHub merges again' }, randomUUID());
    const githubFrom = await Promise.all(everyId.map(history));
    for (let round = 0; round < 3; round++) { await due(); await settled(`github cycle ${round}`); }
    assert.ok(consulted.includes('observe'), `the client is what observes once GitHub is the merger (consulted: ${[...new Set(consulted)].join(', ') || 'nothing'})`);
    assert.deepEqual(await Promise.all(everyId.map(history)), githubFrom, 'the checkout writes no observation while GitHub is the merger');
    for (const id of everyId) assert.match((await jobs()).find(row => row.work_id === id)!.error ?? '', /observes nothing/, 'each job failed on the client, never on the checkout');

    await new MergerSettings(store).change(operator, { merger: 'control-plane', reason: 'the soak runs an App-less install' }, randomUUID());
    consulted.length = 0;
    await due(); await settled('control-plane again');
    assert.deepEqual(await Promise.all(everyId.map(history)), githubFrom.map(revision => revision + 1), 'the checkout observes again, once per item');
    for (const id of everyId) assert.equal((await jobs()).find(row => row.work_id === id)!.error, null, 'the client\'s failures are cleared by the checkout\'s observation');
    assert.equal(consulted.length, 0, `the client is not consulted again (consulted: ${[...new Set(consulted)].join(', ')})`);
  } finally { stop = true; await workers; }
  await store.pool.query('UPDATE jobs SET available_at=now()');
});
