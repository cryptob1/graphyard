import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daemonSummary } from '../src/master-daemon.js';
import { acknowledgeCommand, mainWatchAttention, mainWatchHistoryLimit, mainWatchSettleMs } from '../src/daemon/main-watch.js';
import { clock, hour, minute } from './helpers/soak-world.js';
import { soakConfig, soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay, type MainWatchLanding } from './helpers/soak-simulation.js';

/**
 * GY-1519: the main watch over a simulated day of the real loop. One
 * concern of the release-candidate soak (GY-404), split per concern (GY-1363): the world is
 * tests/helpers/soak-world.ts, the control planes tests/helpers/soak-plane.ts, the day itself
 * tests/helpers/soak-simulation.ts, and every suite asserts the system invariants after every
 * cycle. Foreign commits are pushed straight onto the simulated main at their hour, beside the
 * day's own scripted pushes (a file split, a NOTICE, a docs reword); the watch reads main's first
 * parents from the checkout every cycle and the policy from the real control plane, and an admin
 * acknowledges through the real route.
 */
soakControlPlanes('soak-main-watch', 417);

const fullSha = /^[0-9a-f]{40}$/;
const minutes = (ms: number) => Math.round(ms / minute);

/** The day's landings as the watch should have seen them: every commit on main no delivery explains, oldest first. A cycle's elapsed time is read at its start, so a commit landing inside the read settles up to one interval after the cycle that reports it began. */
function landings(day: Awaited<ReturnType<typeof simulateDay>>) {
  const watch = day.mainWatchDay!;
  const landed = [...watch.landed].sort((a, b) => a.at - b.at);
  const elapsed = (entry: Pick<MainWatchLanding, 'at'>) => entry.at - day.dayStart;
  return { watch, landed, elapsed, foreign: landed.filter(entry => !entry.own), own: landed.filter(entry => entry.own) };
}

function trace(label: string, day: Awaited<ReturnType<typeof simulateDay>>) {
  if (!process.env.SOAK_TRACE) return;
  const { watch, landed, elapsed } = landings(day);
  const at = (time: number) => minutes(time - day.dayStart);
  console.error(`${label}: ${JSON.stringify({ landed: landed.map(entry => `${entry.own ? 'own' : 'foreign'} +${minutes(elapsed(entry))} ack ${entry.acknowledgedAt === null ? 'never' : `+${at(entry.acknowledgedAt)}`} ${entry.subject}`),
    reports: watch.reports.map(report => minutes(report.at)), unknownSeen: [...watch.unknownSeen.values()].map(seen => [minutes(seen.first), minutes(seen.last)]),
    historyReads: watch.historyReads, policyReads: watch.policyReads, largestHistory: watch.largestHistory, largestUnknown: watch.largestUnknown, rowPruned: watch.rowPruned, cycles: day.cycles, vanished: watch.vanished.map(entry => ({ ...entry, sha: entry.sha.slice(0, 8), at: minutes(entry.at), tip: entry.tip?.slice(0, 8) })), policyLog: watch.policyLog.map(entry => ({ ...entry, at: minutes(entry.at) })) })}`);
}

test('unit:soak-main-watch-report-only — a simulated day of the real loop in report-only mode: GitHub merges explain every delivered commit on main, while the day\'s own pushes and two commits pushed by hand are each reported once (sha, subject, author) once settled and never again across the cursor\'s pruning of their rows; nothing is reverted or reworked, the reads stay bounded and the state lists every unexplained commit until the day ends', { timeout: 600_000 }, async () => {
  const hours = 6, interval = soakConfig.run.intervalSeconds * 1000;
  const foreign = [{ at: hour + 40 * minute, author: 'A. Stranger', subject: 'Hotfix pushed straight to main', acknowledgeAfterMs: null }, { at: 3 * hour + 20 * minute, author: 'B. Operator', subject: 'Bump a pin by hand', acknowledgeAfterMs: null }];
  const day = await simulateDay({ hours, mainWatch: { foreign, acknowledgeOwnAfterMs: null } });
  trace('report-only', day);
  const { violations, failures, lost, state, cycles, final, github } = day;
  const { watch, landed, elapsed, foreign: pushed, own } = landings(day);
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item was delivered: the unexplained commits held nothing back');

  // Both foreign commits landed at their hour; the day's own pushes were seen too; each was reported exactly once, once settled, in landing order, naming sha, subject and author.
  assert.equal(pushed.length, 2, 'both foreign commits landed');
  assert.ok(own.length >= 2, `the day's own pushes to main were seen: ${own.map(entry => entry.subject)}`);
  assert.ok(landed.every(entry => fullSha.test(entry.sha)));
  assert.deepEqual(watch.reports.map(report => report.sha), landed.map(entry => entry.sha), 'each unexplained commit was reported exactly once, in the order it landed');
  for (const [index, report] of watch.reports.entries()) {
    const entry = landed[index], settledAt = elapsed(entry) + mainWatchSettleMs;
    assert.ok(report.at >= settledAt - interval && report.at <= settledAt + 2 * interval, `"${entry.subject}" was reported once settled (+${minutes(report.at)} min, landed +${minutes(elapsed(entry))} min)`);
    assert.ok(report.detail.includes(`"${entry.subject}" by ${entry.author}`) && report.detail.includes(acknowledgeCommand(entry.sha)), report.detail);
    assert.match(report.detail, /Reported only: nothing is reverted or reworked/);
  }
  // Every delivered item's merge was explained: no report names a delivery's merge commit.
  const delivered = new Set(final.flatMap(item => item.delivery ? [item.delivery.mergeSha] : []));
  assert.ok(delivered.size >= 10 && watch.reports.every(report => !delivered.has(report.sha)), `no delivery was reported (${delivered.size} deliveries)`);
  // The cursor's bound retired the first report's row hours before the day ended, and no commit was raised again.
  assert.ok(watch.rowPruned, 'the cursor pruned the first raised line\'s row');
  assert.equal(state.actions[`main-watch:${landed[0].sha}`], undefined, 'the first row stays pruned');
  // Nothing reverted, reworked or decided over an unexplained commit; no revert pull request exists.
  assert.equal(github.reverts.size, 0, 'no revert was opened');
  const naming = Object.keys(state.actions).filter(key => pushed.some(entry => key.includes(entry.sha)));
  assert.ok(naming.length >= 2 && naming.every(key => /^(main-watch|review):/.test(key)), `a foreign commit is named only by the watch's line or a review's base, never by a rework or revert: ${naming}`);
  assert.ok(Object.keys(state.actions).every(key => !/revert|main-guard/.test(key)), 'no revert or main guard action was recorded');
  assert.deepEqual(watch.vanished, [], 'no commit left the unknown list: nothing was acknowledged');

  // The state lists every unexplained commit, newest first, until the day ends; master status shows the count and the newest; the attention names each once.
  assert.deepEqual(state.mainWatch?.unknown.map(entry => entry.sha), [...landed].reverse().map(entry => entry.sha));
  for (const entry of landed) assert.ok(watch.unknownSeen.get(entry.sha)!.last >= hours * hour - 2 * interval, `"${entry.subject}" stayed unknown to the day's end`);
  assert.deepEqual(daemonSummary(state, clock.now(), interval).mainWatch, { checkedAt: state.mainWatch!.checkedAt, tip: state.mainWatch!.tip, unknown: landed.length, newestUnknown: landed.at(-1)!.sha });
  assert.equal(mainWatchAttention(state.mainWatch, 'main').length, landed.length);
  assert.equal(watch.largestUnknown, landed.length, 'never more than the unexplained commits were unknown');

  // Bounded: one history read a cycle, the policy read only while something is unknown, the history never past the fallback bound.
  assert.ok(watch.historyReads <= cycles + 1, `one history read per cycle (${watch.historyReads} over ${cycles})`);
  assert.ok(watch.policyReads >= 1 && watch.policyReads <= watch.historyReads, `the policy is read at most once a cycle (${watch.policyReads})`);
  assert.ok(watch.largestHistory >= 1 && watch.largestHistory <= mainWatchHistoryLimit, `the history stays within the bound (${watch.largestHistory})`);
});
