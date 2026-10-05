import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPromoteEveryMinutes, promotionCycle, promotionLedgerReadMs, promotionRunsReadMs, promotionReads, promotionStatus, promotionWorkflow, type PromotionLedger, type PromotionReads, type PromotionRun } from '../src/daemon/deployment.js';
import { promotionStateSchema, type PromotionState } from '../src/daemon/state.js';
import type { MasterConfig } from '../src/master.js';

// GY-1302: GitHub's scheduled release-candidate runs are best-effort, and on 2026-10-05 four in a
// row never fired. The loop dispatches the release-candidate workflow itself, and master status
// says what production runs, how far behind it is, and when the next promotion is due.

const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const PROMOTED = sha('a'), MAIN = sha('b'), LATER = sha('c');
const T0 = Date.parse('2026-10-05T12:00:00Z');
const minutes = (count: number) => count * 60_000;

/** A GitHub and checkout stub: what the ledger says, what the workflow's runs are, and every dispatch made. */
function stubReads(ledger: PromotionLedger, runs: PromotionRun[]) {
  const reads = { ledger, runs, dispatches: 0, runReads: 0, ledgerReads: 0 };
  const api: PromotionReads = {
    ledger: async () => { reads.ledgerReads++; return reads.ledger; },
    runs: async () => { reads.runReads++; return reads.runs; },
    dispatch: async () => { reads.dispatches++; },
  };
  return { reads, api };
}

test('unit:loop-dispatches-promotion — over three cycles (a candidate still in validation, main moved with nothing in flight, the interval not yet elapsed) the loop dispatches the release-candidate workflow with promote=true exactly once', async () => {
  const every = defaultPromoteEveryMinutes;
  assert.equal(every, 120);
  // A scheduled candidate cut three hours ago is still in UAT.
  const { reads, api } = stubReads({ mainSha: MAIN, promotedSha: PROMOTED, promotedAt: new Date(T0 - minutes(600)).toISOString(), behind: 3 },
    [{ status: 'in_progress', createdAt: new Date(T0 - minutes(180)).toISOString(), event: 'schedule' },
      // A pushed rc-* tag validates one pinned commit and promotes nothing: it never holds promotion back.
      { status: 'in_progress', createdAt: new Date(T0 - minutes(5)).toISOString(), event: 'push' }]);

  // Cycle 1 — candidate in flight: main has moved and the interval has passed, but nothing is dispatched.
  let { state, dispatched } = await promotionCycle(null, api, { now: T0, everyMinutes: every });
  assert.equal(dispatched, false);
  assert.equal(reads.dispatches, 0);
  assert.equal(state.inFlight, true);
  assert.match(state.reason ?? '', /in validation/);

  // Cycle 2 — main moved, the candidate concluded, two hours since the last cut: dispatched once.
  reads.runs = [{ status: 'completed', createdAt: new Date(T0 - minutes(180)).toISOString(), event: 'schedule' }];
  ({ state, dispatched } = await promotionCycle(state, api, { now: T0 + minutes(2), everyMinutes: every }));
  assert.equal(dispatched, true);
  assert.equal(reads.dispatches, 1);
  assert.equal(state.dispatchedAt, new Date(T0 + minutes(2)).toISOString());
  assert.equal(state.nextDueAt, new Date(T0 + minutes(2) + minutes(every)).toISOString());

  // Cycle 3 — main moved again, GitHub has not listed the dispatched run yet and shows nothing in
  // flight: the interval since the loop's own dispatch has not elapsed, so nothing is dispatched.
  reads.ledger = { ...reads.ledger, mainSha: LATER, behind: 4 };
  ({ state, dispatched } = await promotionCycle(promotionStateSchema.parse(state), api, { now: T0 + minutes(30), everyMinutes: every }));
  assert.equal(dispatched, false);
  assert.match(state.reason ?? '', /next is due 120 minute/);

  assert.equal(reads.dispatches, 1, 'exactly one dispatch across the three cycles');
});

test('unit:loop-dispatches-promotion — nothing is dispatched when production runs main, when promotion is off, and a run GitHub lists inside the interval (a scheduled run that did fire) counts as the last dispatch', async () => {
  const current = stubReads({ mainSha: MAIN, promotedSha: MAIN, promotedAt: new Date(T0).toISOString(), behind: 0 }, []);
  const settled = await promotionCycle(null, current.api, { now: T0, everyMinutes: 120 });
  assert.equal(settled.dispatched, false); assert.equal(settled.state.nextDueAt, null);
  const off = stubReads({ mainSha: MAIN, promotedSha: PROMOTED, promotedAt: null, behind: 2 }, []);
  assert.equal((await promotionCycle(null, off.api, { now: T0, everyMinutes: 0 })).dispatched, false);
  const fired = stubReads({ mainSha: MAIN, promotedSha: PROMOTED, promotedAt: null, behind: 2 }, [{ status: 'completed', createdAt: new Date(T0 - minutes(30)).toISOString(), event: 'schedule' }]);
  const recent = await promotionCycle(null, fired.api, { now: T0, everyMinutes: 120 });
  assert.equal(recent.dispatched, false);
  assert.equal(recent.state.nextDueAt, new Date(T0 + minutes(90)).toISOString());
  assert.equal(current.reads.dispatches + off.reads.dispatches + fired.reads.dispatches, 0);
});

test('unit:loop-dispatches-promotion — the ledger read fetches from the remote, so cycles every 20 seconds for six hours fetch once per read window, GitHub runs are read once a minute at most, and promotion that is off reads nothing', async () => {
  const { reads, api } = stubReads({ mainSha: MAIN, promotedSha: PROMOTED, promotedAt: null, behind: 1 },
    [{ status: 'in_progress', createdAt: new Date(T0 - minutes(10)).toISOString(), event: 'workflow_dispatch' }]);
  const span = minutes(360), step = 20_000;
  let state: PromotionState | null = null;
  for (let now = T0; now < T0 + span; now += step) {
    // Main moves every 40 minutes; the candidate concludes after three hours.
    reads.ledger = { ...reads.ledger, mainSha: sha(String(Math.floor((now - T0) / minutes(40)) % 10)), behind: 1 + Math.floor((now - T0) / minutes(40)) };
    if (now - T0 >= minutes(180)) reads.runs = reads.runs.map(run => ({ ...run, status: 'completed' }));
    state = promotionStateSchema.parse((await promotionCycle(state, api, { now, everyMinutes: 120 })).state);
  }
  const cycles = span / step;
  assert.ok(reads.ledgerReads <= Math.ceil(span / promotionLedgerReadMs) + 1, `${reads.ledgerReads} fetches over ${cycles} cycles`);
  assert.ok(reads.ledgerReads >= span / promotionLedgerReadMs - 1, 'the ledger is still refreshed every read window, so behind stays current');
  assert.ok(reads.runReads <= Math.ceil(span / promotionRunsReadMs) + 1, `${reads.runReads} run reads`);
  assert.ok(reads.dispatches >= 1 && reads.dispatches <= Math.ceil(span / minutes(120)), `${reads.dispatches} dispatches`);
  const off = stubReads({ mainSha: MAIN, promotedSha: PROMOTED, promotedAt: null, behind: 1 }, []);
  let offState: PromotionState | null = null;
  for (let now = T0; now < T0 + minutes(30); now += step) offState = (await promotionCycle(offState, off.api, { now, everyMinutes: 0 })).state;
  assert.deepEqual([off.reads.ledgerReads, off.reads.runReads, off.reads.dispatches], [0, 0, 0], 'promotion that is off fetches nothing');
});

test('unit:loop-dispatches-promotion — a failing fetch, run read or dispatch never repeats every cycle: the attempt is stamped, a dispatch that fails (or that GitHub accepted before gh failed) counts toward the interval, and none of them throws', async () => {
  const { reads, api } = stubReads({ mainSha: MAIN, promotedSha: PROMOTED, promotedAt: null, behind: 2 }, []);
  const failing = { ledger: false, runs: false, dispatch: true };
  const counted: PromotionReads = {
    ledger: async () => { if (failing.ledger) { reads.ledgerReads++; throw new Error('fetch: network is unreachable'); } return api.ledger(); },
    runs: async () => { if (failing.runs) { reads.runReads++; throw new Error('gh: HTTP 502'); } return api.runs(); },
    // GitHub may have accepted the dispatch before gh failed: a run the next read does not list yet.
    dispatch: async () => { reads.dispatches++; if (failing.dispatch) throw new Error('gh: HTTP 403: Resource not accessible by integration'); },
  };
  const step = 20_000;
  let state: PromotionState | null = null, failures = 0;
  const run = async (from: number, to: number) => {
    for (let now = from; now < to; now += step) {
      const result = await promotionCycle(state, counted, { now, everyMinutes: 120 });
      state = promotionStateSchema.parse(result.state);
      if (result.failure) failures++;
    }
  };

  // Six hours of a dispatch that keeps failing: one attempt per interval, not one per cycle.
  await run(T0, T0 + minutes(360));
  assert.equal(reads.dispatches, 3, `one dispatch attempt per 120-minute interval (${reads.dispatches} over ${minutes(360) / step} cycles)`);
  assert.equal(failures, 3);
  assert.ok(reads.ledgerReads <= Math.ceil(minutes(360) / promotionLedgerReadMs) + 1, `${reads.ledgerReads} fetches`);
  assert.ok(reads.runReads <= 3, `runs are read only when a dispatch is due (${reads.runReads})`);
  assert.equal(state!.dispatchedAt, new Date(T0 + minutes(240)).toISOString(), 'the failed attempt is stamped as the last dispatch');

  // An hour of an unreachable remote: one fetch per read window.
  failing.dispatch = false; failing.ledger = true;
  const before = { ledger: reads.ledgerReads, failures };
  await run(T0 + minutes(360), T0 + minutes(420));
  assert.ok(reads.ledgerReads - before.ledger <= Math.ceil(minutes(60) / promotionLedgerReadMs) + 1, `${reads.ledgerReads - before.ledger} failed fetches in an hour`);
  assert.equal(failures - before.failures, reads.ledgerReads - before.ledger);

  // Half an hour of failing run reads once a dispatch is due: one read per run-read window.
  failing.ledger = false; failing.runs = true;
  const runsBefore = reads.runReads;
  await run(T0 + minutes(480), T0 + minutes(510));
  assert.ok(reads.runReads - runsBefore <= Math.ceil(minutes(30) / promotionRunsReadMs) + 1, `${reads.runReads - runsBefore} failed run reads in half an hour`);

  // Everything recovers: the next promotion is dispatched.
  failing.runs = false;
  const dispatchesBefore = reads.dispatches;
  await run(T0 + minutes(510), T0 + minutes(515));
  assert.equal(reads.dispatches - dispatchesBefore, 1);
  assert.equal(state!.inFlight, true);
});

test('unit:loop-dispatches-promotion — the dispatch asks GitHub to run the release-candidate workflow on the base branch with promote=true, and the ledger reads the newest rc-production record and the merges since it', async () => {
  const calls: string[][] = [];
  const run = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (args.includes('rev-parse')) return `${MAIN}\n`;
    if (args.includes('for-each-ref')) return `${JSON.stringify({ id: '20261005T030000Z', sha: PROMOTED, at: '2026-10-05T03:40:00.000Z' })}\n`;
    if (args.includes('rev-list')) return '7\n';
    if (command === 'gh' && args[0] === 'run') return JSON.stringify([{ status: 'completed', createdAt: '2026-10-05T03:00:00Z', event: 'schedule' }]);
    return '';
  };
  const config = { repository: 'owner/repo', baseBranch: 'main' } as MasterConfig;
  assert.equal(promotionReads(config, '/repo', run, false), null, 'a repository without the workflow has nothing to dispatch');
  const reads = promotionReads(config, '/repo', run, true)!;
  assert.deepEqual(await reads.ledger(), { mainSha: MAIN, promotedSha: PROMOTED, promotedAt: '2026-10-05T03:40:00.000Z', behind: 7 });
  assert.ok(calls.some(call => call.includes('rev-list') && call.includes(`${PROMOTED}..${MAIN}`) && call.includes('--first-parent')));
  assert.equal((await reads.runs()).length, 1);
  await reads.dispatch();
  assert.deepEqual(calls.at(-1), ['gh', 'workflow', 'run', promotionWorkflow, '--repo', 'owner/repo', '--ref', 'main', '-f', 'promote=true']);
});

test('unit:promotion-status — master status reports the last promoted SHA, how many merges production is behind, and when the next promotion is due', async () => {
  const { api } = stubReads({ mainSha: MAIN, promotedSha: PROMOTED, promotedAt: '2026-10-05T03:40:00.000Z', behind: 5 }, []);
  const { state } = await promotionCycle(null, api, { now: T0, everyMinutes: 120 });
  const report = promotionStatus(promotionStateSchema.parse(state) satisfies PromotionState);
  assert.equal(report.lastPromotedSha, PROMOTED);
  assert.equal(report.behind, 5);
  assert.equal(report.nextDueAt, new Date(T0 + minutes(120)).toISOString());
  // Before the loop has checked, the fields are present and say so rather than guessing.
  const unchecked = promotionStatus(null);
  assert.deepEqual([unchecked.lastPromotedSha, unchecked.behind, unchecked.nextDueAt], [null, null, null]);
  assert.match(unchecked.reason ?? '', /not checked/);
});
