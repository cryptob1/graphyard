import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daemonSummary } from '../src/master-daemon.js';
import { acknowledgeCommand, mainWatchAttention, mainWatchHistoryLimit, mainWatchSettleMs } from '../src/daemon/main-watch.js';
import { promotionFrozenReason } from '../src/daemon/deployment.js';
import { clock, hour, minute } from './helpers/soak-world.js';
import { soakConfig, soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay, type MainWatchLanding } from './helpers/soak-simulation.js';

/**
 * GY-1519: the main watch over a simulated day of the real loop, beside the promotion drive. One
 * concern of the release-candidate soak (GY-404), split per concern (GY-1363): the world is
 * tests/helpers/soak-world.ts, the control planes tests/helpers/soak-plane.ts, the day itself
 * tests/helpers/soak-simulation.ts, and every suite asserts the system invariants after every
 * cycle. Foreign commits are pushed straight onto the simulated main at their hour, beside the
 * day's own scripted pushes (a file split, a NOTICE, a docs reword); the watch reads main's first
 * parents from the checkout every cycle and the policy from the real control plane, and an admin
 * acknowledges through the real route. The foreign commits land outside the promotion day's
 * scripted fetch-failure window (+60 to +90 min), where the drive's ledger is stale by design.
 */
soakControlPlanes('soak-main-watch', 417);

const promotion = { validationMs: 8 * minute, promoteAfterMs: 6 * minute, soakMs: 25 * minute };
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
    reports: watch.reports.map(report => minutes(report.at)), unknownSeen: [...watch.unknownSeen.values()].map(seen => [minutes(seen.first), minutes(seen.last)]), frozenAt: watch.frozenAt.map(minutes), unfrozenAt: watch.unfrozenAt.map(minutes),
    dispatches: day.promotion.dispatches.map(at), promotions: day.promotion.promotions.map(at), historyReads: watch.historyReads, policyReads: watch.policyReads, largestHistory: watch.largestHistory, largestUnknown: watch.largestUnknown, rowPruned: watch.rowPruned, cycles: day.cycles, driveViolations: day.promotion.violations, vanished: watch.vanished.map(entry => ({ ...entry, sha: entry.sha.slice(0, 8), at: minutes(entry.at), tip: entry.tip?.slice(0, 8) })), policyLog: watch.policyLog.map(entry => ({ ...entry, at: minutes(entry.at) })) })}`);
}

test('unit:soak-main-watch-report-only — a simulated day of the real loop in report-only mode: GitHub merges and the loop\'s promotions explain every delivered commit on main, while the day\'s own pushes and two commits pushed by hand are each reported once (sha, subject, author) once settled and never again across the cursor\'s pruning of their rows; promotion runs on, nothing is reverted or reworked, the reads stay bounded and the state lists every unexplained commit until the day ends', { timeout: 600_000 }, async () => {
  const hours = 6, interval = soakConfig.run.intervalSeconds * 1000;
  const foreign = [{ at: hour + 40 * minute, author: 'A. Stranger', subject: 'Hotfix pushed straight to main', acknowledgeAfterMs: null }, { at: 3 * hour + 20 * minute, author: 'B. Operator', subject: 'Bump a pin by hand', acknowledgeAfterMs: null }];
  const day = await simulateDay({ hours, promotion, mainWatch: { freeze: false, foreign, acknowledgeOwnAfterMs: null } });
  trace('report-only', day);
  const { promotion: drive, violations, failures, lost, state, cycles, dayStart, final, github } = day;
  const { watch, landed, elapsed, foreign: pushed, own } = landings(day);
  const at = (time: number) => minutes(time - dayStart);
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  assert.deepEqual(drive.violations, [], 'the promotion drive kept its own invariants beside the watch');
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
  // Nothing reverted, reworked or decided over an unexplained commit; no revert pull request exists; promotion was never frozen.
  assert.equal(github.reverts.size, 0, 'no revert was opened');
  const naming = Object.keys(state.actions).filter(key => pushed.some(entry => key.includes(entry.sha)));
  assert.ok(naming.length >= 2 && naming.every(key => /^(main-watch|review|promotion):/.test(key)), `a foreign commit is named only by the watch's line, a review's base or a candidate's tip, never by a rework or revert: ${naming}`);
  assert.ok(Object.keys(state.actions).every(key => !/revert|main-guard/.test(key)), 'no revert or main guard action was recorded');
  assert.deepEqual(watch.vanished, [], 'no commit left the unknown list: nothing was acknowledged');
  assert.deepEqual(watch.frozenAt, [], 'report-only never freezes promotion');
  assert.ok(![...watch.reasons].some(reason => reason.startsWith('Promotion is frozen')), 'the drive never named a freeze');

  // Promotion ran on: candidates were dispatched and promoted after each foreign commit landed.
  for (const entry of pushed) assert.ok(drive.dispatches.some(time => time > entry.at + mainWatchSettleMs), `a candidate was dispatched after the commit landed at +${at(entry.at)} min: ${drive.dispatches.map(at)}`);
  assert.ok(drive.promotions.length >= 3, `the runs promoted their candidates over ${hours} h: ${drive.promotions.map(at)}`);

  // The state lists every unexplained commit, newest first, until the day ends; master status shows the count and the newest; the attention names each once.
  assert.deepEqual(state.mainWatch?.unknown.map(entry => entry.sha), [...landed].reverse().map(entry => entry.sha));
  assert.equal(state.mainWatch?.frozen, null);
  for (const entry of landed) assert.ok(watch.unknownSeen.get(entry.sha)!.last >= hours * hour - 2 * interval, `"${entry.subject}" stayed unknown to the day's end`);
  assert.deepEqual(daemonSummary(state, clock.now(), interval).mainWatch, { checkedAt: state.mainWatch!.checkedAt, tip: state.mainWatch!.tip, unknown: landed.length, newestUnknown: landed.at(-1)!.sha, frozen: null });
  assert.equal(mainWatchAttention(state.mainWatch, 'main').length, landed.length);
  assert.equal(watch.largestUnknown, landed.length, 'never more than the unexplained commits were unknown');

  // Bounded: one history read a cycle, the policy read only while something is unknown, the history never past the fallback bound.
  assert.ok(watch.historyReads <= cycles + 1, `one history read per cycle (${watch.historyReads} over ${cycles})`);
  assert.ok(watch.policyReads >= 1 && watch.policyReads <= watch.historyReads, `the policy is read at most once a cycle (${watch.policyReads})`);
  assert.ok(watch.largestHistory >= 1 && watch.largestHistory <= mainWatchHistoryLimit, `the history stays within the bound (${watch.largestHistory})`);
});

test('unit:soak-main-watch-freeze — a simulated day of the real loop with the freeze asked for: every unexplained commit on main freezes promotion once settled and no candidate is dispatched until the admin\'s acknowledgement is read through the real route, after which promotion resumes before the next one lands; the day\'s own pushes and two foreign commits are each acknowledged and lifted, the third foreign commit stands to the day\'s end with master status and the drive\'s reason naming it, each is reported once, and the day\'s merges and invariants are untouched', { timeout: 600_000 }, async () => {
  const hours = 6, interval = soakConfig.run.intervalSeconds * 1000;
  const foreign = [
    { at: 2 * hour + 20 * minute, author: 'A. Stranger', subject: 'Hotfix pushed straight to main', acknowledgeAfterMs: 40 * minute },
    { at: 4 * hour, author: 'B. Operator', subject: 'Bump a pin by hand', acknowledgeAfterMs: 25 * minute },
    { at: 5 * hour + 20 * minute, author: 'C. Nobody', subject: 'Force-pushed fix', acknowledgeAfterMs: null },
  ];
  const day = await simulateDay({ hours, promotion, mainWatch: { freeze: true, foreign, acknowledgeOwnAfterMs: 15 * minute } });
  trace('freeze', day);
  const { promotion: drive, violations, failures, lost, state, cycles, dayStart, final, github } = day;
  const { watch, landed, elapsed, foreign: pushed, own } = landings(day);
  const at = (time: number) => minutes(time - dayStart);
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  assert.deepEqual(drive.violations, [], 'the promotion drive kept its own invariants beside the freeze');
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item was delivered: the freeze holds promotion, never a merge');

  assert.equal(pushed.length, 3, 'all three foreign commits landed');
  assert.ok(own.length >= 2, `the day's own pushes to main were seen: ${own.map(entry => entry.subject)}`);
  assert.deepEqual(watch.reports.map(report => report.sha), landed.map(entry => entry.sha), 'each unexplained commit was reported exactly once, in the order it landed');
  for (const report of watch.reports) assert.match(report.detail, /Promotion is frozen until an admin acknowledges it/);
  assert.ok(watch.rowPruned, 'the cursor pruned the first raised line\'s row, and the commit was not raised again');

  // Each commit was unknown from the cycle it settled until the cycle its acknowledgement was read, never leaving the
  // list before (the day's scripted loop outage included); the unacknowledged one stays to the day's end.
  const standing = pushed[2];
  assert.deepEqual(watch.vanished, [], 'no commit left the unknown list before its acknowledgement was recorded');
  for (const entry of landed) {
    const seen = watch.unknownSeen.get(entry.sha)!, settledAt = elapsed(entry) + mainWatchSettleMs;
    assert.ok(seen && seen.first >= settledAt - interval && seen.first <= settledAt + 2 * interval, `"${entry.subject}" became unknown once settled (+${minutes(seen?.first ?? 0)} min, landed +${minutes(elapsed(entry))})`);
    if (entry.acknowledgedAt === null) { assert.equal(entry, standing); assert.ok(seen.last >= hours * hour - 2 * interval, 'the unacknowledged commit stays unknown to the end'); continue; }
    const acknowledgedAt = entry.acknowledgedAt - dayStart;
    assert.ok(acknowledgedAt >= seen.first && seen.last <= acknowledgedAt, `the admin acknowledged "${entry.subject}" while it was unknown, and the cycle that read it dropped it (last unknown +${minutes(seen.last)} min, acknowledged +${minutes(acknowledgedAt)})`);
  }
  // The freeze stood exactly while something was unknown, and no candidate was dispatched inside any of its windows.
  assert.ok(watch.frozenAt.length >= 3 && watch.frozenAt.length === watch.unfrozenAt.length + 1, `freezes ${watch.frozenAt.map(minutes)} lifted ${watch.unfrozenAt.map(minutes)}: the last stands`);
  const windows = watch.frozenAt.map((from, index) => [from, watch.unfrozenAt[index] ?? hours * hour] as const);
  for (const [from, to] of windows) assert.ok(!drive.dispatches.some(time => time - dayStart >= from && time - dayStart < to), `no candidate was dispatched while frozen (+${minutes(from)} to +${minutes(to)} min): ${drive.dispatches.map(at)}`);
  // A foreign commit holds promotion from its landing (the tip unclassified, then frozen) to its lift, and promotion resumes before the next one lands.
  for (const [index, entry] of pushed.entries()) {
    const landedAt = elapsed(entry), next = pushed[index + 1] ? elapsed(pushed[index + 1]) : hours * hour;
    if (entry.acknowledgedAt === null) { assert.ok(!drive.dispatches.some(time => time - dayStart >= landedAt), `nothing was dispatched after the unacknowledged commit landed at +${minutes(landedAt)} min: ${drive.dispatches.map(at)}`); continue; }
    const lifted = watch.unfrozenAt.find(time => time >= watch.unknownSeen.get(entry.sha)!.first)!;
    assert.ok(lifted !== undefined && lifted <= entry.acknowledgedAt - dayStart + 2 * interval, `the freeze on "${entry.subject}" lifted with its acknowledgement (+${minutes(lifted)} min)`);
    assert.ok(!drive.dispatches.some(time => time - dayStart >= landedAt && time - dayStart <= lifted), `no candidate was dispatched between +${minutes(landedAt)} and +${minutes(lifted)} min: ${drive.dispatches.map(at)}`);
    assert.ok(drive.dispatches.some(time => time - dayStart > lifted && time - dayStart < next), `promotion resumed after the lift at +${minutes(lifted)} min, before +${minutes(next)}: ${drive.dispatches.map(at)}`);
  }
  assert.ok(drive.promotions.length >= 2, `candidates still promoted between the freezes: ${drive.promotions.map(at)}`);

  // The third commit stands: master status and the drive's reason name it and the acknowledge command; the attention line names it once.
  assert.deepEqual(state.mainWatch?.unknown.map(entry => entry.sha), [standing.sha], 'only the unacknowledged commit is still unknown');
  assert.equal(state.mainWatch?.frozen?.sha, standing.sha);
  assert.equal(state.promotion?.reason, promotionFrozenReason(state.mainWatch!.frozen!), 'the drive names the freeze and its lift');
  assert.ok(watch.reasons.has(promotionFrozenReason({ sha: landed[0].sha, since: 'T' })), 'the first freeze was the drive\'s reason while it stood');
  assert.deepEqual(daemonSummary(state, clock.now(), interval).mainWatch, { checkedAt: state.mainWatch!.checkedAt, tip: state.mainWatch!.tip, unknown: 1, newestUnknown: standing.sha, frozen: state.mainWatch!.frozen });
  const attention = mainWatchAttention(state.mainWatch, 'main');
  assert.equal(attention.length, 1); assert.match(attention[0].text, /Promotion is frozen/); assert.ok(attention[0].next.includes(acknowledgeCommand(standing.sha)));
  // The acknowledgements are on the control plane's record, by the admin, and the loop read them from there.
  assert.ok(landed.filter(entry => entry !== standing).every(entry => entry.acknowledgedAt !== null));
  assert.equal(github.reverts.size, 0, 'no revert was opened');

  // Bounded, as in report-only mode.
  assert.ok(watch.historyReads <= cycles + 1, `one history read per cycle (${watch.historyReads} over ${cycles})`);
  assert.ok(watch.policyReads >= 1 && watch.policyReads <= watch.historyReads, `the policy is read at most once a cycle (${watch.policyReads})`);
  assert.ok(watch.largestHistory <= mainWatchHistoryLimit, `the history stays within the bound (${watch.largestHistory})`);
  assert.ok(watch.largestUnknown <= 3, `never more than three commits were unknown at once (${watch.largestUnknown})`);
});
