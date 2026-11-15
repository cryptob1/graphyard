import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCycle } from '../src/daemon/cycle.js';
import { mergeWriterIdle, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { emptyDaemonState, type DaemonState } from '../src/daemon/state.js';
import { TrialTimeoutError } from '../src/merge-writer/trial.js';
import { loopReads, pipelineWorld, rollout, type World } from './helpers/pipeline-world.js';

// GY-3353: on 2026-11-15, after the install moved hosts, five heads sat in the merge writer's queue
// for hours, listed at its end every cycle and never trialled, while heads submitted later merged in
// minutes. Their trials had timed out on the old host's loop; the timeout record moved with the
// loop's state, and a timed-out head yielded its queue turn behind every other head (GY-2079) — with
// a newer head arriving each cycle, its turn never came. The real merge writer runs here over a real
// temporary Postgres plane and a scratch remote whose trial commands are stubs.

const githubDouble = new Proxy({}, { get: (_, name) => { throw new Error(`the loop called GitHub (${String(name)})`); } });

/** One loop process over `world` with its own daemon state; `trial` wraps the trials it runs. */
function loop(world: World, state: DaemonState, trial?: (run: MergeWriterReads['trial']) => MergeWriterReads['trial']) {
  const effects = () => {
    const reads = loopReads({ ...world, snapshot: world.work }, { gate: false });
    return { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
      snapshot: async () => ({ work: await world.work(), now: new Date().toISOString() }), closeSession: () => {}, dispatch: async () => {},
      decisions: async () => ({ decisions: [] }), persist: async () => {}, github: githubDouble, merge: githubDouble,
      mergeWriter: trial ? { ...reads, trial: trial(reads.trial) } : reads, rework: async () => {} } as unknown as DaemonEffects;
  };
  return async () => { await runCycle(world.config, state, effects(), Date.now, undefined, () => {}); await mergeWriterIdle(state); };
}

test('e2e:queued-candidate-never-starves — a head whose trial timed out on the old host is trialled first after the move, before every newer head at its priority, and lands', { timeout: 280_000 }, async () => {
  const world = await pipelineWorld('queued-candidate-never-starves');
  try {
    await rollout(world);
    const old = await world.submit('Old head', { 'old.txt': 'old\n' });
    // The old host's loop: its trial of the head times out, and the loop records the timeout.
    const oldState = emptyDaemonState(world.config);
    const oldLoop = loop(world, oldState, run => async (...args) => {
      if (args[2].key === old.key) throw new TrialTimeoutError('tests', 1_200_000, 'not ok 1 - tests/slow.test.ts\n');
      return run(...args);
    });
    await oldLoop(); await oldLoop();
    assert.deepEqual(oldState.mergeWriter.timeouts?.map(entry => entry.key), [old.key], 'the old host recorded the head\'s timed-out trial');
    assert.ok((await world.work()).find(item => item.key === old.key)!.stage !== 'done', 'the head is still queued');

    // The install moves: the loop restarts on the new host with the state the old one persisted, its in-memory flights gone.
    const newState = JSON.parse(JSON.stringify(oldState)) as DaemonState;
    const newLoop = loop(world, newState);
    const flights: string[][] = [];
    for (let cycle = 0; cycle < 6; cycle++) {
      // A newer head at the same priority arrives every cycle.
      await world.submit(`Newer head ${cycle}`, { [`newer-${cycle}.txt`]: `${cycle}\n` });
      await newLoop();
      const queued = newState.mergeWriter.queue.map(entry => entry.key);
      if (queued.includes(old.key)) assert.equal(queued[0], old.key, `the old head keeps its oldest-first place in the queue: ${queued.join(', ')}`);
      const started = (newState.mergeWriter.inFlights ?? []).map(entry => entry.key);
      if (started.length) flights.push(started);
      if ((await world.work()).find(item => item.key === old.key)!.stage === 'done') break;
    }
    const trialled = world.trialLog.map(entry => entry.key);
    assert.ok(trialled.includes(old.key), `the old head was trialled on the new host: ${trialled.join(', ')}`);
    // The first flight the new loop starts carries the old head first: no newer head is trialled before it.
    assert.equal(flights[0]?.[0], old.key, `the new host's first flight leads with the old head: ${JSON.stringify(flights)}`);
    const done = (await world.work()).find(item => item.key === old.key)!;
    assert.equal(done.stage, 'done', `the old head ends merged: ${JSON.stringify(done.mergeLedger)}`);
    assert.equal(done.mergeLedger?.state, 'reconciled');
  } finally { await world.close(); }
});
