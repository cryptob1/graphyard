import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cycleCost, cycleTimes, slowCycleAttention } from '../src/daemon/liveness.js';
import { slowLoopIdempotencyKey, slowLoopItemInputSchema } from '../src/daemon/slow-loop-item.js';
import { daemonStateSchema, emptyDaemonState, runDaemon, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';

// GY-1775 over a simulated day. The real loop (runDaemon, one cycle per call on the driver's
// simulated clock) runs five-minute cycles past the 60 s bound whenever the day's script says a
// step holds the time: the clock the cycle is measured with advances inside the effect that step
// runs, so the cycle's duration and its slowest step are the scripted ones. The serving release
// changes every 54 cycles, one release runs three slow cycles across a process restart (the state
// is reloaded from the cursor between cycles), another loses the filing's reply twice before the
// control plane answers, and the healthy releases never cross the bound. After every cycle:
//
// - every system invariant holds, and no cycle failed;
// - the recorded run matches the day — each count and reset survived the restart, so three slow
//   cycles spanning one file exactly one item and a carried reset files nothing early;
// - each release-and-step key is asked only while it files, at most a first ask plus its lost-reply
//   retries, and every ask under a key carries the same body, so the control plane's receipt
//   fingerprint accepts the replay;
// - the slow-cycle attention row names the run's filed item once one is filed.
//
// Bounded: exactly one item per release and slowest step that crossed the bound — four items over
// the day, six asks, one durable done record each, nothing pending, nothing for the healthy
// releases — and every body as asked parses as the item it files.
const minute = 60_000, hour = 60 * minute, interval = 5 * minute, holdMs = 90_000;
const start = Date.parse('2026-10-14T00:00:00.000Z'), cycles = 280;
const sha = (label: string) => createHash('sha1').update(label).digest('hex');
const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
  autoMerge: true, mergeMethod: 'merge', workers: [], run: { intervalSeconds: interval / 1000, proofWorkflow: 'acceptance.yml' },
  // The day's premise is cycles past the 60 s filing bound, so the p90 invariant is judged at 120 s:
  // still judged every cycle, and still able to fail (the scripted holds stop at 90 s).
  invariants: { cycleP90Seconds: 120 } });

/** The serving release changes every 54 cycles (about four hours and a half of the day). */
const releaseEvery = 54, releases = Array.from({ length: 6 }, (_, index) => sha(`slow-loop-release-${index}`));
const releaseAt = (cycle: number) => releases[Math.min(Math.floor(cycle / releaseEvery), releases.length - 1)];
/**
 * The day's script: whether the cycle is slow past the bound, and which step holds the time — the
 * `snapshot` step (the release's first filing names it) or the `credentials` step (a second, later
 * filing on the same release names it). The healthy releases never cross the bound.
 */
const stretch = (cycle: number): { slow: boolean; hold: 'snapshot' | 'credentials' } => {
  const index = cycle % releaseEvery, release = Math.floor(cycle / releaseEvery);
  if (release === 1) return { slow: index < 3 || (index >= 23 && index < 26), hold: index < 3 ? 'snapshot' : 'credentials' };
  if (release === 2 || release === 3) return { slow: index < (release === 3 ? 6 : 3), hold: 'snapshot' };
  return { slow: false, hold: 'snapshot' };
};
/** The cycles a restart runs between (the release 2 count crosses the bound across the one at 109). */
const restarts = new Set([2 * releaseEvery + 1]);
/** The cycles whose filing ask the control plane never answered (release 3 loses its reply twice). */
const lostReplies = new Set([3 * releaseEvery + 2, 3 * releaseEvery + 3]);

test('integration:soak-slow-loop — over a simulated day of slow cycles across changing releases, restarts and a control plane that twice loses the filing\'s reply, the real loop files exactly one item per release and slowest step, retries a lost reply with the body it first asked, keeps its count across a restart, names the item in the slow-cycle attention, and every invariant holds', { timeout: 600_000 }, async () => {
  let state: DaemonState = emptyDaemonState(config);
  const filed: { key: string; work: string; title: string }[] = [], asks: { key: string; body: string }[] = [], lateAsks: string[] = [], schemaRefusals: string[] = [];
  const receipts = new Map<string, { fingerprint: string; result: Work }>(), answered = new Set<string>();
  let now = start, hold: 'snapshot' | 'credentials' | null = null, plane: 'up' | 'lost' = 'up', next = 40, cursor: string | null = null;
  const fingerprint = (body: string) => createHash('sha256').update(body).digest('hex');
  const effects: DaemonEffects = {
    agents: () => [],
    credentials: async (profiles: { name: string }[]) => { if (hold === 'credentials') now += holdMs; return Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])); },
    snapshot: async () => { if (hold === 'snapshot') now += holdMs; return { work: [] as Work[], now: new Date(now).toISOString() }; },
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: new Date(now).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async state => { cursor = JSON.stringify(state); },
    fileSlowLoopItem: async (input, key) => {
      const parsed = slowLoopItemInputSchema.safeParse(input), body = JSON.stringify(input);
      if (!parsed.success) schemaRefusals.push(`${key}: ${parsed.error.message}`);
      if (answered.has(key)) lateAsks.push(key);
      asks.push({ key, body });
      if (plane === 'lost') {
        // The plane committed the ask and the reply was lost: the receipt stands, the loop saw nothing.
        if (!receipts.has(key)) { const work = `GY-${next++}`; filed.push({ key, work, title: input.title }); receipts.set(key, { fingerprint: fingerprint(body), result: { key: work, title: input.title } as unknown as Work }); }
        throw new Error('Graphyard refused work (502): upstream unavailable');
      }
      const seen = receipts.get(key);
      if (seen) {
        // 'Idempotency key reused with different input' (src/engine.ts:226): the replay is refused.
        if (seen.fingerprint !== fingerprint(body)) throw new Error('409: Idempotency key reused with different input');
        answered.add(key);
        return seen.result;
      }
      const work = `GY-${next++}`;
      filed.push({ key, work, title: input.title });
      const result = { key: work, title: input.title } as unknown as Work;
      receipts.set(key, { fingerprint: fingerprint(body), result });
      answered.add(key);
      return result;
    },
  };
  const options = (cycle: number) => ({
    once: true as const, intervalMs: interval, identity: { pid: process.pid, host: 'machine-a' }, signals: [] as NodeJS.Signals[], now: () => now, log: () => {},
    checkout: async () => ({ root: '/outside/repo', commit: releaseAt(cycle), modified: [] as string[], untracked: [] as string[] }),
    checkoutRestore: async () => [], process: ({ on: () => {}, off: () => {} }) as unknown as Pick<NodeJS.Process, 'on' | 'off'>,
  });

  const violations: string[] = [], failedCycles: string[] = [], countsWrong: string[] = [], rowWrong: string[] = [];
  let expected = 0, lastRelease = releases[0];
  for (let cycle = 0; cycle < cycles; cycle++) {
    now += interval;
    const release = releaseAt(cycle), phase = stretch(cycle), before = asks.length;
    if (release !== lastRelease) { expected = 0; lastRelease = release; }
    hold = phase.slow ? phase.hold : null;
    expected = phase.slow ? expected + 1 : 0;
    effects.loadedRelease = { commit: release, dirty: false };
    plane = lostReplies.has(cycle) ? 'lost' : 'up';
    // A restart reloads the cursor: what the loop's persists last wrote, never the live state.
    if (restarts.has(cycle)) state = daemonStateSchema.parse(JSON.parse(cursor!));
    const ran = await runDaemon(config, state, effects, options(cycle));
    if (ran.failed.length) failedCycles.push(`cycle ${cycle}: ${ran.failed.map(failure => failure.reason).join('; ')}`);
    for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle}: ${check.invariant} — ${check.reading}`);
    if (state.slowLoop.consecutive !== expected) countsWrong.push(`cycle ${cycle}: recorded ${state.slowLoop.consecutive}, the day ran ${expected}`);
    for (const key of new Set(asks.slice(before).map(ask => ask.key))) {
      const bodies = asks.filter(ask => ask.key === key).map(ask => ask.body);
      if (new Set(bodies).size !== 1) violations.push(`cycle ${cycle}: ${key} was asked with ${new Set(bodies).size} different bodies`);
      if (bodies.length > 3) violations.push(`cycle ${cycle}: ${key} was asked ${bodies.length} times`);
    }
    // The slow-cycle attention row names the run's filed item once one is filed for this release.
    const row = slowCycleAttention({ liveness: { state: 'running' }, cost: cycleCost(state.metrics.at(-1) ?? null, interval), cycleTime: cycleTimes(state.metrics, now), release: state.release, slowLoop: state.slowLoop });
    if (phase.slow && row.length !== 1) rowWrong.push(`cycle ${cycle}: ${row.length} slow-cycle row(s)`);
    if (phase.slow && cycle === releaseEvery + 24 && !row[0]?.text.includes('the loop filed GY-40')) rowWrong.push(`cycle ${cycle}: the row names no filed item: ${row[0]?.text}`);
    if (phase.slow && cycle === 3 * releaseEvery + 5 && !row[0]?.text.includes('the loop filed GY-43')) rowWrong.push(`cycle ${cycle}: the row names no filed item: ${row[0]?.text}`);
  }

  assert.deepEqual(failedCycles, [], 'no cycle failed');
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(countsWrong, [], 'the recorded run matches the day: every count and reset survived the restart');
  assert.deepEqual(rowWrong, [], 'the slow-cycle attention names the run\'s filed item');
  assert.deepEqual(lateAsks, [], 'no key was asked again once the plane had answered it');
  assert.deepEqual(schemaRefusals, [], 'every body as asked parses as the item it files');
  // Bounded: exactly one item per release and slowest step that crossed the bound, nothing for the healthy releases.
  const keys = (release: number, step: string) => slowLoopIdempotencyKey(releases[release], step);
  assert.deepEqual(filed.map(item => item.key),
    [keys(1, 'snapshot'), keys(1, 'credentials'), keys(2, 'snapshot'), keys(3, 'snapshot')],
    'one item per release and slowest step, and nothing for the healthy releases');
  assert.equal(asks.length, 6, 'six asks: one per item, plus the two lost-reply retries');
  for (const key of new Set(asks.map(ask => ask.key))) {
    const bodies = asks.filter(ask => ask.key === key).map(ask => ask.body);
    assert.equal(new Set(bodies).size, 1, `${key} was always asked with the same body`);
  }
  assert.equal(asks.filter(ask => ask.key === keys(3, 'snapshot')).length, 3, 'the lost reply was retried twice more under its key');
  // The durable record: one done action per item on the cursor, and nothing pending or carried over.
  const actionKey = (release: number, step: string) => `slow-loop:${releases[release].slice(0, 12)}:${step}`;
  const slowLoopActions = Object.entries(state.actions).filter(([key]) => key.startsWith('slow-loop:'));
  assert.deepEqual(slowLoopActions.map(([key]) => key).sort(),
    [actionKey(1, 'snapshot'), actionKey(1, 'credentials'), actionKey(2, 'snapshot'), actionKey(3, 'snapshot')].sort(),
    'one durable record per filed item');
  assert.ok(slowLoopActions.every(([, action]) => action.state === 'done'), 'every filing is done on the record');
  assert.equal(state.slowLoop.pending, null, 'nothing is left pending');
  assert.deepEqual(state.slowLoop.filed, {}, 'the run ended on a healthy release: no items carried');
  assert.ok(!filed.some(item => item.key.includes(releases[0]) || item.key.includes(releases[4]) || item.key.includes(releases[5])), 'the healthy releases filed nothing');
});
