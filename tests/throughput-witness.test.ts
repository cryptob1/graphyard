import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { closeWitnessStore, fleetStandIns, runFleetWitness, witnessStore } from '../src/throughput-run.js';
// @ts-expect-error The witness entry point; only its argument parsing and rendering are used here.
import { parseArguments, render, renderFleet } from '../scripts/measure-throughput.mjs';

/**
 * The conducted witness run behind `manual:throughput-without-master` (GY-87, AC-6).
 *
 * AC-6 is stated over deliveries made with no master session running, and a control plane that
 * still runs the coordination loop the queue replaces cannot produce one — so the witness
 * conducts the window itself (`src/throughput-run.ts`). This file is what keeps that harness
 * honest: that it really drives items to delivery through the shipped executor loop with no
 * master anywhere, that every delivery it makes is one the criterion is stated over, and that it
 * names what it stood in for rather than presenting a stand-in as the real thing.
 *
 * It carries no proof name: AC-6's evidence is the witness run itself, recorded by
 * `scripts/measure-throughput.mjs`, never a case in a test file.
 */

let database: EmbeddedPostgres, port: number;
before(async () => {
  port = Number(process.env.GRAPHYARD_THROUGHPUT_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 70);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-throughput-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start();
});
after(async () => { if (database) await database.stop(); });

/**
 * One conducted run, on a database of its own.
 *
 * Every case here drives a single executor. Two of them racing one queue is what AC-3's own proof
 * establishes (`integration:multi-executor-throughput`), over the same queue and the same
 * claim-run-settle loop; adding a second one here would buy nothing that proof does not already
 * hold, and would cost this file a run whose wall clock is set by how long a loaded host makes
 * two brokers wait for each other. The conducted run takes its fleet from `--executors`, and the
 * witness script is where a fleet run is made.
 */
async function conduct(label: string, options: { deliveries: number; executors: number }) {
  const name = `graphyard_witness_${label}_${Date.now().toString(36)}`;
  await database.createDatabase(name);
  return runFleetWitness({ databaseUrl: `postgres://graphyard:testing-only@127.0.0.1:${port}/${name}`, timeoutMs: 120_000, ...options });
}


test('the conducted witness run drives ten deliveries through a control plane of its own, with no master session, and certifies them', async () => {
  // The run owns its database: a control plane stood up for the measurement and thrown away
  // again, which is how a witness conducts a masterless window without touching production — and
  // why nothing it records can be confused with a live delivery.
  const report = await conduct('full', { deliveries: 10, executors: 1 });

  assert.equal(report.delivered, 10, 'the fleet delivered every item it was given');
  assert.equal(report.witness.deliveries, 10, 'and every delivery is in the population the criterion is stated over');
  assert.deepEqual(report.witness.excluded, []);
  assert.equal(report.witness.met, true, report.witness.reasons.join('; '));
  assert.equal(report.witness.worstIdle, null, 'nothing was idle while it was actionable');
  assert.equal(report.witness.handoffs.items, 0);
  assert.ok(report.samples.length >= 2, 'the queue was sampled across the run rather than read once');
  assert.deepEqual(report.witness.executors, [report.executors[0].id], 'every row was settled by the executor and by nothing else');
  assert.ok(report.queueWait.count >= 10, 'the wait from a row being requested to being claimed is measured, not assumed');

  // What the run could not have is named with the verdict rather than left for a reader to infer.
  assert.deepEqual(report.standIns, fleetStandIns);
  assert.match(report.caveat, /does not measure how long a human-scale agent takes/);
  assert.match(render(report.witness), /Verdict: met/);
});

test('a conducted run that leaves an item it released undelivered is not met, and says where the item stands', async () => {
  // A deadline no loop could meet, so the run ends with its items still in flight. However good
  // the deliveries a run did make, it released every item itself: one it could not deliver is a
  // finding about the loop, and a verdict that averaged it away would certify a stuck queue.
  const name = `graphyard_witness_short_${Date.now().toString(36)}`;
  await database.createDatabase(name);
  const report = await runFleetWitness({ databaseUrl: `postgres://graphyard:testing-only@127.0.0.1:${port}/${name}`, deliveries: 3, executors: 1, timeoutMs: 1 });

  assert.ok(report.delivered < 3);
  assert.equal(report.undelivered.length, 3 - report.delivered);
  assert.equal(report.witness.met, false);
  assert.match(report.witness.reasons.at(-1)!, /of the 3 items the run released .* not delivered within/);
  for (const entry of report.undelivered) {
    assert.match(entry.key, /^GY-\d+$/);
    assert.notEqual(entry.stage, 'done');
    assert.ok(entry.refusals.length || entry.nextAction, 'each names what it is refused for or what it is owed next');
  }
  assert.match(renderFleet(report), /not delivered: GY-\d+ in /);
});

test('the witness entry point refuses a conducted run configured to measure fewer deliveries than the criterion is stated over', () => {
  assert.equal(parseArguments([]).mode, 'live');
  assert.equal(parseArguments(['--fleet']).mode, 'fleet');
  assert.equal(parseArguments(['--fleet', '--deliveries', '20', '--executors', '3']).deliveries, 20);
  assert.equal(parseArguments(['--fleet', '--scale']).scale, true);
  assert.equal(parseArguments(['--fleet', '--timeout', '30']).timeoutMinutes, 30);
  // A witness that drove five items would report "not met" for a reason it chose itself.
  assert.throws(() => parseArguments(['--fleet', '--deliveries', '5']), /at least ten/);
  assert.throws(() => parseArguments(['--executors', '0']), /--executors/);
  assert.throws(() => parseArguments(['--fleet', '--timeout', '0']), /--timeout/);
  assert.throws(() => parseArguments(['--since', 'yesterday']), /ISO 8601/);
  assert.throws(() => parseArguments(['--bogus']), /Unknown argument/);
});

/**
 * The witness script as a producer runs it: a child process, judged by what it prints and the
 * status it leaves with. The instrument failed a producer at exactly this level — after the fleet
 * had finished — so this level is where it is held.
 */
const script = fileURLToPath(new URL('../scripts/measure-throughput.mjs', import.meta.url));
function witness(args: string[], source?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GRAPHYARD_|^HERDR_/.test(name)));
    const child = source ? spawn(process.execPath, ['--input-type=module', '-e', source], { env, cwd: fileURLToPath(new URL('..', import.meta.url)) }) : spawn(process.execPath, [script, ...args], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('a scratch database that drops the run\'s idle connections does not take the witness down, and a closed run leaves no connection behind', async () => {
  const name = `graphyard_witness_pool_${Date.now().toString(36)}`;
  await database.createDatabase(name);
  const lines: string[] = [];
  const store = witnessStore(`postgres://graphyard:testing-only@127.0.0.1:${port}/${name}`, line => lines.push(line));
  const admin = new pg.Client(`postgres://graphyard:testing-only@127.0.0.1:${port}/postgres`);
  await admin.connect();
  try {
    await store.init();
    assert.ok(store.pool.idleCount >= 1, 'the run holds an idle connection, as it does between any two queries');
    // What the server does to every connection when it is shut down. On a pool with no `error`
    // listener this is an uncaught exception, and it ends the process that was about to report.
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [name]);
    for (let waited = 0; !lines.length && waited < 5_000; waited += 25) await delay(25);
    assert.match(lines[0] ?? '', /an idle database connection was lost .*no query was on it/);
    assert.ok(await store.schema() > 0, 'and the run goes on: the next query takes a fresh connection');

    await closeWitnessStore(store);
    assert.equal(store.pool.totalCount, 0);
    let left = -1;
    for (let waited = 0; left !== 0 && waited < 2_000; waited += 25) {
      left = (await admin.query('SELECT count(*)::int AS open FROM pg_stat_activity WHERE datname=$1', [name])).rows[0].open;
      if (left) await delay(25);
    }
    assert.equal(left, 0, 'whoever stops the database next races no socket of this run');
  } finally { await admin.end(); }
});

test('the witness script prints and records its verdict before it puts the scratch database away, and leaves with the verdict\'s status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-witness-record-'));
  try {
    const run = await witness(['--fleet', '--deliveries', '10', '--executors', '2', '--record', directory, '--json']);
    assert.equal(run.code, 0, run.stderr.slice(-2_000));
    const report = JSON.parse(run.stdout);
    assert.equal(report.mode, 'fleet');
    assert.equal(report.witness.met, true, report.witness.reasons.join('; '));
    assert.equal(report.witness.deliveries, 10);
    assert.deepEqual(report.witness.executors, ['witness-executor-1', 'witness-executor-2']);
    const [recorded] = await readdir(directory);
    assert.deepEqual(JSON.parse(await readFile(join(directory, recorded), 'utf8')).witness, report.witness, 'the record on disk is the verdict that was printed');
    assert.doesNotMatch(run.stderr, /Unhandled|uncaught/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a conducted run that cannot start its scratch database reaches no verdict, says why, and exits 2 rather than as a criterion that failed or passed', async () => {
  const taken = createServer();
  await new Promise<void>(resolve => taken.listen(0, '127.0.0.1', resolve));
  try {
    const run = await witness(['--fleet', '--port', String((taken.address() as any).port)]);
    assert.equal(run.code, 2, run.stderr.slice(-2_000));
    assert.equal(run.stdout, '', 'no verdict is printed for a run that measured nothing');
    assert.match(run.stderr, /^No verdict: The scratch Postgres for the conducted run could not be started/m);
    assert.match(run.stderr, /Nothing was measured/);
  } finally { await new Promise(resolve => taken.close(resolve)); }
  const unreachable = await witness(['--fleet', '--database', 'postgres://nobody:nothing@127.0.0.1:1/none']);
  assert.equal(unreachable.code, 2);
  assert.match(unreachable.stderr, /^No verdict: /m);
});

test('the status a run arrived at survives the embedded database\'s own exit hook, which would otherwise end every run with 0', async () => {
  // The library ends the process itself once the event loop drains, with status 0, whatever
  // `process.exitCode` holds: a "not met" verdict set that way would leave as a pass.
  const lost = await witness([], "await import('embedded-postgres'); process.exitCode = 1;");
  assert.equal(lost.code, 0, 'the hazard is real: exitCode alone is discarded');
  const kept = await witness([], "await import('embedded-postgres'); const { leave } = await import('./scripts/measure-throughput.mjs'); console.log('Verdict: not met'); leave(1);");
  assert.equal(kept.code, 1);
  assert.equal(kept.stdout, 'Verdict: not met\n', 'and the verdict is flushed before the process goes');
});
