import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Work } from '../src/model.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { cycleTimes, slowCycleAttention, slowCycleMs } from '../src/daemon/liveness.js';
/** The filing rule, imported when each test runs: on a tree without it (verify's base exercise) the proof fails as a case, not at load (GY-1418). */
const rule = () => import('../src/daemon/slow-loop-item.js');
import { type CycleMetrics, cycleMetricsSchema, type DaemonState, daemonStateSchema, emptyCycleSteps } from '../src/daemon/state.js';
import { masterConfigSchema } from '../src/master.js';
import { emptyDaemonState } from '../src/master-daemon.js';
// Time-bomb allowance (GY-1694): every cycle's `at` is a fixture instant and every judgement takes the explicit `now` below; nothing here reads the wall clock.

// GY-1775: slowCycleAttention raised a row per slow cycle and told the master to shorten the slowest
// step; nothing filed work, so a regression was found by a human reading p50 (GY-1766 was filed by
// hand after the decisions step held cycles at 121 s). Three consecutive cycles past slowCycleMs on
// one loaded release now file one fix item, as the throughput owner is filed: as the operator-agent
// under an idempotency key of the release commit and the step name.
const base = Date.parse('2026-10-13T12:00:00.000Z');
const minute = 60_000;
const at = (cycle: number) => new Date(base + cycle * minute).toISOString();
const releaseA = 'a'.repeat(40), releaseB = 'b'.repeat(40);
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
  autoMerge: true, mergeMethod: 'merge', workers: [], run: { proofWorkflow: 'acceptance.yml' } });

/** One completed cycle: its wall time, its timed steps and the slowest calls it recorded. */
function cycle(index: number, durationMs: number, steps: Record<string, number>, calls: { kind: 'server' | 'github' | 'herdr' | 'git' | 'process' | 'account'; name: string; ms: number; step: string | null }[] = []): CycleMetrics {
  return cycleMetricsSchema.parse({ cycle: index, at: at(index), durationMs, childWaitMs: 0, workMs: durationMs, steps: emptyCycleSteps(), open: 1, actions: 0,
    timings: { totalMs: durationMs, steps: Object.entries(steps).map(([step, ms]) => ({ step, ms })), calls: [...calls].sort((a, b) => b.ms - a.ms), slowCalls: calls.length },
    stages: {}, lead: { count: 0, p50Ms: 0, p90Ms: 0 } });
}
const slow = (index: number, step = 'decisions', ms = 90_000) => cycle(index, ms, { snapshot: 2_000, [step]: ms - 10_000, merges: 3_000 }, [{ kind: 'server', name: 'GET work', ms: 8_000, step: 'snapshot' }, { kind: 'github', name: 'gh pr view', ms: 41_000, step }]);
const fast = (index: number) => cycle(index, 12_000, { snapshot: 2_000, decisions: 4_000 });

function world(release: string | null = releaseA, initial?: DaemonState) {
  const state: DaemonState = initial ?? emptyDaemonState(config);
  state.release = release ? { commit: release, dirty: false } : null;
  const filed: { key: string; work: string; title: string }[] = [], requests: string[] = [], bodies = new Map<string, string[]>(), writes: string[] = [];
  const receipts = new Map<string, { fingerprint: string; result: Work }>();
  let plane: 'up' | 'lost' = 'up', next = 1800;
  // The control plane fingerprints each Idempotency-Key's parsed body (src/engine.ts:1100-1101, 1155-1158)
  // and refuses a key reused with a different one, so this fake answers a replay only when the body
  // is byte-identical to the one the key was first asked under.
  const fingerprint = (body: unknown) => createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const effects = {
    persist: async () => { writes.push(JSON.stringify(state)); },
    fileSlowLoopItem: async (input: { title: string }, key: string): Promise<Work> => {
      requests.push(key);
      const asked = bodies.get(key) ?? []; bodies.set(key, asked); asked.push(JSON.stringify(input));
      const seen = receipts.get(key);
      if (plane === 'lost') {
        // The plane committed the ask and the reply was lost: the receipt stands, the caller saw nothing.
        if (!seen) {
          const work = `GY-${next++}`;
          filed.push({ key, work, title: input.title });
          receipts.set(key, { fingerprint: fingerprint(input), result: { key: work, title: input.title } as unknown as Work });
        }
        throw new Error('Graphyard refused work (502): upstream unavailable');
      }
      if (seen) {
        // 'Idempotency key reused with different input' (src/engine.ts:226): the replay is refused.
        if (seen.fingerprint !== fingerprint(input)) throw new Error('409: Idempotency key reused with different input');
        return seen.result;
      }
      const work = `GY-${next++}`;
      filed.push({ key, work, title: input.title });
      const result = { key: work, title: input.title } as unknown as Work;
      receipts.set(key, { fingerprint: fingerprint(input), result });
      return result;
    },
  } as unknown as Pick<DaemonEffects, 'fileSlowLoopItem' | 'persist'> & { fileSlowLoopItem: NonNullable<DaemonEffects['fileSlowLoopItem']> };
  /** Runs one completed cycle through the filing rule, as run.ts does after runCycle. */
  const complete = async (metrics: CycleMetrics) => { state.metrics.push(metrics); state.cycle = metrics.cycle + 1; return (await rule()).fileSlowLoopItem(state, effects, () => base + (metrics.cycle + 1) * minute); };
  return { state, effects, filed, requests, bodies, writes, complete, lose: () => { plane = 'lost'; }, restore: () => { plane = 'up'; } };
}

test('unit:slow-loop-files-once — three consecutive cycles past slowCycleMs on one release file exactly one item under the release-and-step key; a fourth slow cycle and a retry after a lost reply file nothing new; two slow cycles file nothing; a slow run on another release files its own item', async () => {
  const { fileSlowLoopItem, filedSlowLoopItem, noteSlowCycle, slowLoopCycles, slowLoopIdempotencyKey } = await rule();
  const w = world();
  // Two slow cycles, then a fast one: the run ends short of the bound and nothing is filed.
  assert.equal(await w.complete(slow(1)), null);
  assert.equal(await w.complete(slow(2)), null);
  assert.equal(w.state.slowLoop.consecutive, 2);
  assert.equal(await w.complete(fast(3)), null);
  assert.equal(w.state.slowLoop.consecutive, 0);
  assert.deepEqual(w.requests, [], 'two slow cycles file nothing');
  // Three consecutive slow cycles file exactly one item, under the release commit and the step name.
  assert.equal(await w.complete(slow(4)), null);
  assert.equal(await w.complete(slow(5)), null);
  const filed = await w.complete(slow(6));
  assert.equal(filed?.state, 'done');
  assert.equal(filed?.work, 'GY-1800');
  assert.deepEqual(w.requests, [slowLoopIdempotencyKey(releaseA, 'decisions')]);
  assert.equal(w.filed.length, 1);
  assert.match(filed!.detail, /Filed GY-1800 for the slow master loop on release aaaaaaaaaaaa: the decisions step is the slowest across cycles 4, 5, 6/);
  assert.deepEqual(filedSlowLoopItem(w.state.slowLoop, releaseA, 'decisions'), { key: 'GY-1800', step: 'decisions', file: 'src/daemon/cycle-decisions.ts', cycle: 6, at: at(7) });
  // A fourth slow cycle names the step already filed: no request is made and nothing new is filed.
  assert.equal(await w.complete(slow(7)), null);
  assert.equal(w.state.slowLoop.consecutive, 4);
  assert.equal(w.requests.length, 1, 'a fourth slow cycle makes no request');
  assert.equal(w.filed.length, 1);
  // A retry after a lost reply: the plane did not answer the first filing, so the next slow cycle asks
  // again under the same key and is answered with the item already filed — nothing new.
  const lost = world();
  lost.lose();
  await lost.complete(slow(1)); await lost.complete(slow(2));
  const failed = await lost.complete(slow(3));
  assert.equal(failed?.state, 'failed');
  assert.match(failed!.detail, /the control plane did not answer, so it is filed on a later slow cycle/);
  assert.equal(failed?.faultClass, undefined, 'an unanswered plane is no loop fault');
  assert.equal(lost.state.slowLoop.filed[`${releaseA}:decisions`], undefined);
  lost.restore();
  const retried = await lost.complete(slow(4));
  assert.equal(retried?.state, 'done');
  assert.equal(retried?.work, 'GY-1800');
  assert.deepEqual(lost.requests, [slowLoopIdempotencyKey(releaseA, 'decisions'), slowLoopIdempotencyKey(releaseA, 'decisions')], 'the retry reuses the key');
  assert.equal(lost.filed.length, 1, 'the retry files nothing new');
  assert.equal(await lost.complete(slow(5)), null);
  assert.equal(lost.requests.length, 2);
  // A slow run on another release starts the count again and files its own item.
  w.state.release = { commit: releaseB, dirty: false };
  assert.equal(await w.complete(slow(8)), null);
  assert.equal(w.state.slowLoop.consecutive, 1, 'a new release starts the count again');
  assert.equal(w.state.slowLoop.release, releaseB);
  assert.equal(await w.complete(slow(9)), null);
  const other = await w.complete(slow(10));
  assert.equal(other?.work, 'GY-1801');
  assert.deepEqual(w.requests, [slowLoopIdempotencyKey(releaseA, 'decisions'), slowLoopIdempotencyKey(releaseB, 'decisions')]);
  assert.equal(w.filed.length, 2);
  // Nothing is filed without the operator-agent identity (the effect is absent), though the run is still counted.
  const absent = world();
  const counted = { persist: async () => {} } as unknown as Pick<DaemonEffects, 'fileSlowLoopItem' | 'persist'>;
  for (const index of [1, 2, 3, 4]) { absent.state.metrics.push(slow(index)); assert.equal(await fileSlowLoopItem(absent.state, counted, () => base + index * minute), null); }
  assert.equal(absent.state.slowLoop.consecutive, 4);
  assert.deepEqual(absent.state.slowLoop.filed, {});
  // Nor with no release commit recorded: the key cannot name the release.
  const unreleased = world(null);
  for (const index of [1, 2, 3]) assert.equal(await unreleased.complete(slow(index)), null);
  assert.deepEqual(unreleased.requests, []);
  // The rule itself: a window is returned only at three consecutive slow cycles on the loaded release.
  const counting = world();
  counting.state.metrics.push(slow(1), slow(2));
  assert.equal(noteSlowCycle(counting.state), null);
  counting.state.metrics.push(slow(3));
  counting.state.slowLoop.consecutive = slowLoopCycles - 1;
  assert.deepEqual(noteSlowCycle(counting.state)?.window.map(metrics => metrics.cycle), [1, 2, 3]);
  // The run survives the cursor round-trip: the record parses back as it was written, and an older cursor without it reads as no run.
  const stored = daemonStateSchema.parse(JSON.parse(JSON.stringify(w.state)));
  assert.deepEqual(stored.slowLoop, w.state.slowLoop);
  const { slowLoop: _dropped, ...older } = JSON.parse(JSON.stringify(w.state));
  assert.deepEqual(daemonStateSchema.parse(older).slowLoop, { release: null, consecutive: 0, filed: {}, pending: null });
});

test('unit:slow-loop-run-persisted — each count and reset is persisted as it is counted, so three slow cycles spanning a restart file exactly one item and a carried reset files nothing early, and an unanswered filing is retried from the cursor with the body it was first asked under', async () => {
  const { slowLoopIdempotencyKey } = await rule();
  // Each count and reset lands on the cursor through the persists the rule asks for.
  const counted = world();
  await counted.complete(slow(1)); await counted.complete(slow(2));
  assert.equal(JSON.parse(counted.writes.at(-1)!).slowLoop.consecutive, 2, "the second slow cycle's count is persisted");
  await counted.complete(fast(3));
  assert.equal(JSON.parse(counted.writes.at(-1)!).slowLoop.consecutive, 0, "the fast cycle's reset is persisted");
  // Three slow cycles spanning a restart file exactly one item: the count is read back from the cursor.
  const spanning = world();
  await spanning.complete(slow(1)); await spanning.complete(slow(2));
  const resumed = world(releaseA, daemonStateSchema.parse(JSON.parse(spanning.writes.at(-1)!)));
  const acrossTheRestart = await resumed.complete(slow(3));
  assert.equal(acrossTheRestart?.state, 'done');
  assert.deepEqual(resumed.requests, [slowLoopIdempotencyKey(releaseA, 'decisions')], 'the count crossed the bound across the restart');
  // A reset the restart carried holds the run honest: two more slow cycles file nothing.
  const after = world(releaseA, daemonStateSchema.parse(JSON.parse(counted.writes.at(-1)!)));
  assert.equal(after.state.slowLoop.consecutive, 0);
  await after.complete(slow(4)); await after.complete(slow(5));
  assert.deepEqual(after.requests, [], 'the carried reset files nothing early');
  // A lost reply's filing is kept on the cursor with the body it was asked under; the retry — here
  // from a restarted loop — asks that body under that key, and the plane answers it with the item
  // it filed when the reply was lost, so nothing is filed twice and no rebuilt body is refused.
  const lost = world();
  lost.lose();
  await lost.complete(slow(1)); await lost.complete(slow(2));
  const failed = await lost.complete(slow(3));
  assert.equal(failed?.state, 'failed');
  const key = slowLoopIdempotencyKey(releaseA, 'decisions'), onTheCursor = JSON.parse(lost.writes.at(-1)!).slowLoop.pending;
  assert.equal(onTheCursor.key, key, 'the unanswered filing is on the cursor under its key');
  const restarted = world(releaseA, daemonStateSchema.parse(JSON.parse(lost.writes.at(-1)!)));
  assert.equal(restarted.state.slowLoop.pending?.step, 'decisions');
  restarted.restore();
  const retried = await restarted.complete(slow(4));
  assert.equal(retried?.state, 'done');
  assert.equal(retried?.work, 'GY-1800', 'the plane answers the retry with the item it filed when the reply was lost');
  assert.deepEqual(restarted.requests, [key], 'the retry asks the same key once more');
  assert.deepEqual(restarted.bodies.get(key), [lost.bodies.get(key)![0]], 'the retry asks the original body, byte for byte');
  assert.equal(restarted.filed.length, 1, 'the plane filed it once');
  assert.equal(restarted.state.slowLoop.pending, null, 'the answered filing is cleared');
  // An answered refusal is not kept: the plane judged it, so a later cycle asks afresh what the run then sees.
  const judged = world();
  judged.effects.fileSlowLoopItem = (async () => { throw new Error('422: the item is refused'); }) as never;
  await judged.complete(slow(1)); await judged.complete(slow(2));
  const refused = await judged.complete(slow(3));
  assert.equal(refused?.state, 'failed');
  assert.equal(judged.state.slowLoop.pending, null, 'an answered refusal keeps no pending body');
  assert.match(refused!.detail, /422/);
  assert.ok(!refused!.detail!.includes('did not answer'), 'an answered refusal is not an unanswered plane');
});

test('unit:slow-loop-item-contents — the filed item names the release commit, the cycle p50 and p95, the slowest step with its source file and the slowest external call, and the slow-cycle attention row names the item\'s key once it is filed', async () => {
  const { fileSlowLoopItem, slowLoopItem, slowLoopItemFor, stepSourceFile } = await rule();
  const window = [slow(4, 'decisions', 121_000), slow(5, 'decisions', 95_000), slow(6, 'decisions', 110_000)];
  const metrics = [fast(1), fast(2), fast(3), ...window];
  const now = base + 7 * minute;
  const cycleTime = cycleTimes(metrics, now);
  assert.deepEqual([cycleTime.cycles, cycleTime.p50Ms, cycleTime.p95Ms], [6, 12_000, 121_000]);
  const item = slowLoopItem(releaseA, window, cycleTime);
  assert.equal(item.type, 'bug');
  assert.equal(item.priority, 1);
  assert.equal(item.title, `The master loop is slow on release aaaaaaaaaaaa: the decisions step holds cycles past 60s`);
  assert.match(item.description, new RegExp(`3 consecutive cycles on the release it loaded, ${releaseA}, each took longer than the 60s cycle bound \\(cycle 4 121s \\(decisions 111s\\), cycle 5 95s \\(decisions 85s\\), cycle 6 110s \\(decisions 100s\\)\\)`), 'the release commit, in full');
  assert.match(item.description, /cycle p50 12s and p95 121s over 6 cycle\(s\) in the last 30 minutes/, 'the window\'s percentiles');
  assert.match(item.description, /The slowest step across those cycles is decisions \(src\/daemon\/cycle-decisions\.ts\), 296s in all\./, 'the slowest step with its source file');
  assert.match(item.description, /The slowest external call recorded was github gh pr view, 41s in the decisions step\./, 'the slowest external call');
  assert.match(item.description, /The loop never closes this item/);
  assert.deepEqual(item.plannedFiles, ['src/daemon/cycle-decisions.ts']);
  assert.equal(item.criteria.length, 1);
  assert.match(item.criteria[0].text, /The decisions step \(src\/daemon\/cycle-decisions\.ts\) no longer holds the master loop's cycles past the 60s bound on a release descending from aaaaaaaaaaaa/);
  assert.deepEqual(item.criteria[0].proofs, ['unit:slow-loop-step-bounded']);
  assert.equal(stepSourceFile('faults'), 'src/daemon/faults.ts');
  assert.equal(stepSourceFile('a step no table names'), null);
  // A step without a known file is named by name alone, with nothing planned.
  const unknown = slowLoopItem(releaseA, [slow(1, 'bespoke'), slow(2, 'bespoke'), slow(3, 'bespoke')], cycleTimes([], now));
  assert.match(unknown.title, /the bespoke step holds cycles/);
  assert.equal(unknown.plannedFiles, undefined);
  assert.match(unknown.description, /no cycle completed in the window/);
  // The slow-cycle attention row: before the item is filed it says to shorten the step; once filed it names the item's key.
  const w = world();
  for (const entry of metrics) w.state.metrics.push(entry);
  w.state.cycle = 7;
  const report = (slowLoop: DaemonState['slowLoop']) => slowCycleAttention({ liveness: { state: 'running' }, cost: { cycle: 6, durationMs: 110_000, slowestSteps: [{ step: 'decisions', ms: 100_000 }, { step: 'merges', ms: 3_000 }] } as never, cycleTime, release: w.state.release, slowLoop });
  const before = report(w.state.slowLoop);
  assert.equal(before.length, 1);
  assert.doesNotMatch(before[0].text, /GY-\d+/);
  assert.match(before[0].next ?? '', /shorten the decisions step rather than restarting/);
  w.state.slowLoop = { release: releaseA, consecutive: 2, filed: {}, pending: null };
  const filed = await fileSlowLoopItem(w.state, w.effects, () => now);
  assert.equal(filed?.work, 'GY-1800');
  const after = report(w.state.slowLoop);
  assert.equal(after.length, 1);
  assert.match(after[0].text, /Cycle 6 took 110s, past the 60s cycle bound \(p50 12s, p95 121s over the last 30 minutes\).*slowest steps: decisions 100s, merges 3s; the loop filed GY-1800 for this slow run/);
  assert.match(after[0].next ?? '', /GY-1800 owns shortening the decisions step rather than restarting a loop that is still cycling/);
  // The row names the run's item even when one cycle's slowest step differs from the window's, and nothing for another release.
  assert.equal(slowLoopItemFor(w.state.slowLoop, releaseA, 'merges'), 'GY-1800');
  assert.equal(slowLoopItemFor(w.state.slowLoop, releaseB, 'decisions'), null);
  assert.equal(slowLoopItemFor(w.state.slowLoop, null, 'decisions'), null);
});
