import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { fleetStandIns, runFleetWitness } from '../src/throughput-run.js';
// @ts-expect-error The witness entry point; only its argument parsing and rendering are used here.
import { parseArguments, render } from '../scripts/measure-throughput.mjs';

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
