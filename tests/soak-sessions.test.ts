import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Work } from '../src/model.js';
import { containmentRefusalCause } from '../src/daemon/cycle-reclaim.js';
import { maxApproverLaunches, maxLostApproverRuns } from '../src/daemon/decisions.js';
import { liveRuns, pruneRunDirectories, runDirectoryRetentionMs, runsDirectory, watchedRuns } from '../src/runner/registry.js';
import { clock, hour, minute } from './helpers/soak-world.js';
import { basePlan, soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * Sessions and their fences: the loop's own master session, idle and dead workers, headless
 * approver runs, credential and spent-account failures, and containment fences and quarantines.
 * One concern of the release-candidate soak (GY-404), split per concern (GY-1363) so concurrent
 * changes stop colliding in one file: the world is tests/helpers/soak-world.ts, the control planes
 * tests/helpers/soak-plane.ts, the day itself tests/helpers/soak-simulation.ts, and every suite
 * asserts the system invariants after every cycle.
 */
soakControlPlanes('soak-sessions', 407);

test('unit:soak-invariants-hold — the loop\'s own master session across a day: launched once, relaunched within three cycles of dying while the registry refuses to end its session (which stays owed until it is ended), rotated at its budget, never two at once, woken only by material events with the heartbeat as the fallback, and rotated once off a spent account it keeps retrying on while working', { timeout: 600_000 }, async () => {
  // GY-898: the master-session step runs every cycle of the real loop here. The session dies at
  // minute 70, inside a window (minutes 60–100) in which the registry refuses every end, so the
  // rotation's release is owed and retried; the relaunched session passes its 90-minute budget.
  // GY-1223: the third session works from minute 200 with a bare limit notice of its own on screen,
  // and from minute 230 its runtime retries on its spent account, still working.
  const plan = { exitAt: 70 * minute, refuseRelease: { from: 60 * minute, to: 100 * minute }, sessionMinutes: 90, heartbeatMinutes: 30, working: { from: 200 * minute, retryAt: 230 * minute } };
  // No low-lane item: its application is refused once by design (GY-883), so its decision changes in
  // two consecutive cycles — two material events, not a storm, which the wake assertion below could
  // not tell apart. The main day asserts that scenario.
  const day = await simulateDay({ hours: 6, master: plan, plan: { lowLane: 0 } });
  const { final, violations, failures, state, master, cycles } = day;
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'all fifteen items are delivered with the master session in the loop');
  assert.deepEqual(violations, [], 'every system invariant holds, and never two master sessions at once');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.equal(master.maxLive, 1, 'exactly one master session ran at a time');
  assert.equal(master.launches[0].at, 0, 'the first cycle launches the master session');
  assert.ok(master.killed, 'the scenario killed the live master session');
  // AC-1: the dead session is relaunched within three cycles, and its refused release stays owed until the registry answers.
  assert.ok(master.launches[1] && master.launches[1].at > plan.exitAt && master.launches[1].at <= plan.exitAt + 3 * minute,
    `the dead master was relaunched within three cycles: ${JSON.stringify(master.launches.slice(0, 2))}`);
  assert.match(master.rotations[0]?.detail ?? '', /\(exited\)/);
  assert.ok(master.refusedEnds.includes(master.launches[0].session), 'the rotation\'s registry end was refused inside the window');
  assert.ok(master.ended.includes(master.launches[0].session), 'the owed registry session was ended once the registry answered');
  assert.deepEqual(state.master.unreleased, [], 'nothing is owed to the registry at the end of the day');
  // AC-1: a budget rotation, one budget after the relaunch (deferred at most 30 minutes while a
  // guarded merge on an open item runs), on the clock the loop measures the budget by: the cycle
  // that rotated read it between `before` and `after`.
  const budget = master.rotations.find(rotation => /\(budget\)/.test(rotation.detail));
  const relaunched = master.launches[1]?.startedAt;
  assert.ok(relaunched !== undefined, 'the relaunch recorded its start');
  assert.ok(budget && budget.after >= relaunched + plan.sessionMinutes * minute && budget.before <= relaunched + (plan.sessionMinutes + 32) * minute,
    `the relaunched session rotated at its ${plan.sessionMinutes}-minute budget: ${JSON.stringify({ relaunched, rotations: master.rotations })}`);
  assert.equal(master.launches.length, master.rotations.length + 1, 'every rotation relaunched exactly one session');
  // GY-1223: a working master is read and judged every cycle by the real loop; its own prose about
  // the banner never rotates it, the retry banner rotates it exactly once, its account is held to
  // the banner's reset, and no later launch takes that account before the reset.
  const worked = master.launches.findIndex(launch => launch.pane === master.worked);
  assert.ok(worked >= 0 && master.bannerAt !== null, `the scenario set a live master working and printed its retry banner: ${JSON.stringify({ worked: master.worked, bannerAt: master.bannerAt })}`);
  const workingReads = master.reads.filter(read => read.pane === master.worked && read.status === 'working');
  assert.ok(workingReads.some(read => read.at < master.bannerAt!), `the loop read the working master's own prose before the banner: ${workingReads.length} reads`);
  // The soak cadence equals workingOutputReadMs, so this proves one read per cycle, not the
  // throttle itself; unit:working-session-output-read-throttled pins the throttle.
  assert.ok(workingReads.length <= new Set(workingReads.map(read => read.at)).size, 'a working master is read at most once a cycle (the throttle is pinned by its unit test)');
  const exhausted = master.rotations.filter(rotation => /\(exhausted\)/.test(rotation.detail));
  assert.equal(exhausted.length, 1, `exactly one rotation off the spent account: ${JSON.stringify(master.rotations)}`);
  assert.ok(exhausted[0].at >= master.bannerAt! && exhausted[0].at <= master.bannerAt! + 2 * minute, `the retrying master rotated within two cycles of its banner: ${JSON.stringify({ bannerAt: master.bannerAt, rotation: exhausted[0] })}`);
  assert.match(exhausted[0].detail, /is retrying on its provider's limit notice/);
  assert.ok(!master.rotations.some(rotation => rotation.at >= plan.working.from && rotation.at < master.bannerAt!), 'the working master\'s own prose about the banner rotated nothing');
  assert.deepEqual(master.holds.map(hold => hold.account), [master.accounts[worked]], 'the spent account, and only it, was held');
  assert.equal(master.holds[0].resetsAt, day.retryReset.toISOString(), 'the hold lasts until the banner\'s reset');
  assert.ok(master.accounts.slice(worked + 1).length > 0 && master.accounts.slice(worked + 1).every(account => account !== master.accounts[worked]),
    `no later master launched into the held account before its reset: ${JSON.stringify(master.accounts)}`);
  assert.equal(master.launches[worked + 1]?.at !== undefined && master.launches[worked + 1].at <= exhausted[0].at + 3 * minute, true, 'the role relaunched within three cycles of the rotation');
  // AC-2: at most one wake per cycle, every event wake names its causes, heartbeats are spaced by
  // the configured window, and no cycle repeats the previous cycle's causes (a wake storm).
  const perCycle = new Map<number, number>();
  for (const wake of master.wakes) perCycle.set(wake.cycle, (perCycle.get(wake.cycle) ?? 0) + 1);
  assert.ok([...perCycle.values()].every(count => count === 1), 'never more than one wake in a cycle');
  const events = master.wakes.filter(wake => !/heartbeat fallback/.test(wake.text));
  assert.ok(events.length > 0, 'the day\'s material events woke the master');
  assert.ok(events.every(wake => /Changed subjects, by key: (?!none)\S/.test(wake.text)), 'every event wake names the subjects that changed');
  const causes = (text: string) => /Changed subjects, by key: ([^.]*)\./.exec(text)?.[1] ?? '';
  const repeats = events.filter((wake, index) => index > 0 && events[index - 1].cycle === wake.cycle - 1 && causes(events[index - 1].text) === causes(wake.text));
  assert.deepEqual(repeats.map(wake => `+${Math.round(wake.at / minute)} min: ${causes(wake.text)}`), [], 'no wake repeats the previous cycle\'s causes');
  const heartbeats = master.wakes.filter(wake => /heartbeat fallback/.test(wake.text));
  for (let index = 1; index < heartbeats.length; index++) assert.ok(heartbeats[index].clock! - heartbeats[index - 1].clock! >= plan.heartbeatMinutes * minute, `heartbeats are spaced by the quiet window: ${JSON.stringify(heartbeats.map(wake => wake.clock))}`);
  assert.ok(master.wakes.length < cycles / 2, `wakes are events, not every cycle: ${master.wakes.length} wakes in ${cycles} cycles`);
});

test('unit:soak-invariants-hold — a worker idle past its bound whose pane died is reclaimed without pasting into or closing the pane the reused agent name holds, and is still delivered', { timeout: 600_000 }, async () => {
  // GY-852: one worker takes its lease and then idles at its prompt for ever. Past the idle bound
  // the loop re-prompts it once — in its own pane. The pane then dies and the profile's agent name
  // is taken by another session (the shape that delivered GY-589's re-prompt to GY-831-4's pane),
  // so the reclaim runs while the name holds a pane this attempt does not own: nothing is pasted
  // into it, nothing closes it, and the item is handed to a new attempt that delivers it. The
  // routing repeats per cycle here, which is why it lives in this world.
  const n = basePlan.reassigned;
  const { items, final, violations, failures, lost, herdrClosed, prompts, state, reassign } = await simulateDay({
    hours: 6, reassigned: n,
    plan: { items: 6, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 6, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 6 } },
  });
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'all seven items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds across the idle re-prompt and the reclaim');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost: the idle attempt was reclaimed');
  assert.ok(reassign.pane && reassign.phantom, `the scenario ran: ${JSON.stringify(reassign)}`);
  assert.ok(reassign.phantomGone, 'the other session ended once the attempt was reclaimed');
  // Every paste went to the pane it was addressed to: the idle re-prompt reached the worker's own
  // pane exactly once, and the pane the reused name holds received nothing, ever.
  const mine = prompts.filter(entry => entry.key === items[n - 1].key);
  assert.deepEqual(mine.map(entry => entry.pane), [reassign.pane], `the re-prompt reached only its own pane: ${JSON.stringify(prompts.map(entry => entry.pane))}`);
  assert.ok(!prompts.some(entry => entry.pane === reassign.phantom), 'no paste ever reached the pane the reused name holds');
  assert.ok(!herdrClosed.includes(reassign.phantom!), 'the loop never closed the pane the reused name holds');
  // The reclaim is on the record with why, and the attempt it ended was followed by a delivered one.
  const reclaim = state.actions[`resume:reclaim:${items[n - 1].id}:1`];
  assert.equal(reclaim?.state, 'done');
  assert.match(reclaim.detail, /its pane .* has been gone from the runtime .* keeping the attempt's branch/);
  assert.equal(final.find(item => item.key === items[n - 1].key)!.stage, 'done', 'the item was delivered by its next attempt');
});

test('unit:soak-invariants-hold — a worker that stays working and renews its lease without ever submitting is stopped once past the 120-minute reclaim bound with no unsubmitted-attempt fault filed, then requeued with its worktree kept and delivered — a first attempt, a rework attempt on an open pull request and one that pushed once and stalled alike; a long worker that pushes as it goes is never stopped, and every invariant holds', { timeout: 600_000 }, async () => {
  // GY-1460: GY-1457's shape. Each stuck item's session stays `working` to Herdr and its supervisor
  // renews the lease every cycle, so no idle or lapse path ever sees it: the first attempt of item 2;
  // item 5's rework attempt, whose branch carries the pull request every cycle polls; and item 4's
  // first attempt, which bound its session to a pushed head ten minutes in and stalled while the
  // loop rewrote its handle on every session report. Neither a poll nor a rewrite is progress. The
  // progressing item's first session runs 150 minutes but pushes a head every ten. All run fenced
  // under a supervisor scope, as supervised launches are.
  const stuck = 2, progressing = 3, pushedOnce = 4, rework = 5;
  const { items, final, violations, failures, lost, state, sessions, unboundedDay, dayStart } = await simulateDay({
    hours: 8, unbounded: { stuck, progressing, pushedOnce, rework },
    plan: { items: 6, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set([rework]), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 6, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 6 } },
  });
  const long = items[progressing - 1];
  assert.deepEqual(violations, [], 'every system invariant holds across the faults, the stops and the reclaims');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost: each stopped attempt ended on the record and was reclaimed by the loop');
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item is delivered, each stuck one by its next attempt');
  const stuckAttempts = [[stuck, 1], [pushedOnce, 1], [rework, 2]].map(([n, attempt]) => sessions.find(session => session.key === items[n - 1].key && session.attempt === attempt)!);
  assert.ok(stuckAttempts.every(Boolean), 'every stuck attempt ran');
  assert.ok(unboundedDay.pushes.some(push => push.key === items[pushedOnce - 1].key), 'the pushed-once attempt bound its session to a head');
  // GY-1557: an attempt inside the reclaim bound is the record's to name, not the loop's to count;
  // past it a reclaim that ends the attempt this cycle opens none. The stuck attempts here are each
  // stopped just past 120 minutes and requeued, so no unsubmitted-attempt instance is filed.
  const faults = state.faults.instances.filter(instance => instance.kind === 'unsubmitted-attempt');
  assert.deepEqual(faults, [], `a successful reclaim opens no unsubmitted-attempt instance: ${JSON.stringify(faults)}`);
  assert.ok(!Object.keys(state.faults.open).some(key => key.startsWith('unsubmitted-attempt|')), 'no unsubmitted-attempt fault stands open');
  // The supervisor was stopped exactly once per stuck attempt, through its recorded scope, past the reclaim bound.
  assert.deepEqual(unboundedDay.stops.map(stop => [stop.key, stop.epoch, stop.unit]).sort(), stuckAttempts.map(session => [session.key, session.epoch, `graphyard-watch-${session.key.toLowerCase()}-${session.epoch}.scope`]).sort(), `one stop each: ${JSON.stringify(unboundedDay.stops)}`);
  for (const session of stuckAttempts) {
    const stop = unboundedDay.stops.find(entry => entry.key === session.key)!, stoppedAfter = dayStart + stop.elapsed - session.dispatchAt;
    assert.ok(stoppedAfter > 120 * minute && stoppedAfter < 135 * minute, `${session.key} stopped just past the 120-minute reclaim bound, not before: ${stoppedAfter / minute} minutes in`);
    const action = state.actions[`unbounded:${session.work}:${session.epoch}`];
    assert.equal(action?.state, 'done', `${session.key}: the stop is on the record`);
    assert.equal(action.attempts, 1, `${session.key}: made once, never retried`);
    assert.match(action.detail, /held its lease past the 120-minute reclaim bound without a submission .*; the loop stopped renewing it: the attempt ended on the record, its supervisor \(pid \d+\) was stopped through graphyard-watch-.+\.scope, .* with its worktree kept$/);
    assert.equal(session.state, 'reclaimed');
    // The stopped attempt's worktree was kept, and a later attempt delivered the item.
    const later = sessions.filter(entry => entry.key === session.key && entry.attempt > session.attempt);
    assert.ok(later.length && later.at(-1)!.state === 'submitted', `a later attempt delivered ${session.key}: ${later.map(entry => `${entry.epoch}:${entry.state}`).join(', ')}`);
    assert.ok(final.find(item => item.id === session.work)!.workspaces.some(workspace => workspace.epoch === session.epoch), `${session.key}: the stopped attempt's worktree stays on the record`);
  }
  // The long attempt ran past both bounds, pushing as it went, and was never stopped or faulted.
  const longAttempt = sessions.find(session => session.key === long.key && session.attempt === 1)!;
  assert.equal(longAttempt.state, 'submitted', 'the long attempt submitted its own work');
  assert.ok(unboundedDay.pushes.filter(push => push.key === long.key).length >= 12, `it pushed every ten minutes: ${unboundedDay.pushes.length}`);
  assert.ok(!Object.keys(state.actions).some(key => key.startsWith(`unbounded:${long.id}:`)), 'nothing stopped the progressing attempt');
});

test('unit:soak-invariants-hold — headless approver runs through loop restarts (GY-453): each adopted and applied exactly once, lost ones retried within a bound, the run registry bounded', { timeout: 480_000 }, async () => {
  const { items, final, violations, failures, state, headless } = await simulateDay({ hours: 6, headless: true });
  const { pi, root, applied, submitted, runs, restarts, adoptedLive, adoptedEnded } = headless!;
  const keyOf = (n: number) => items[n - 1].key;
  // The item whose approver is lost one time more than is given back, and the one whose approver is lost every time.
  const [lostOnceMore, lostAlways] = [...basePlan.killedApprovers].sort(([, a], [, b]) => a - b).map(([n]) => n);
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle, across every restart');
  assert.deepEqual(failures, [], 'no cycle failed');
  // Every item is delivered but the one whose approver is killed every time: its decision is escalated.
  assert.deepEqual(final.filter(item => item.stage !== 'done' || !item.delivery).map(item => item.key), [keyOf(lostAlways)]);
  // The loop restarted with runs live, and adopted both runs still live and runs that ended while unwatched.
  assert.ok(restarts >= 3 && adoptedLive > 0 && adoptedEnded > 0, `restarts ${restarts}, adopted live ${adoptedLive}, adopted ended ${adoptedEnded}`);
  // Exactly once: every submitted verdict applied once, whether its run was watched or adopted, and each on disk as applied.
  assert.ok(submitted.length >= 4, `verdicts submitted: ${submitted.length}`);
  assert.deepEqual([...applied].sort(), [...submitted].sort(), 'each submitted verdict applied exactly once');
  // Bounded per decision, lost runs included: at most maxApproverLaunches + maxLostApproverRuns runs.
  assert.ok([...runs.values()].every(count => count <= maxApproverLaunches + maxLostApproverRuns), `runs per decision: ${[...runs.values()].join(', ')}`);
  const killed = Object.values(state.approvals).find(watch => watch.work === keyOf(lostAlways))!;
  assert.equal(runs.get(killed.decision), maxApproverLaunches + maxLostApproverRuns, 'an approver killed every time is relaunched only within the bound');
  assert.deepEqual([killed.launches, killed.lostRuns, !!killed.exhaustedAt, killed.settledAt], [maxApproverLaunches, maxLostApproverRuns, true, null], 'then its decision is escalated as unjudged');
  assert.equal(final.find(item => item.key === keyOf(lostOnceMore))!.stage, 'done', 'an approver lost one time more than is given back still judges its decision');
  // The registry is bounded: nothing left running or watched, one directory per run, each applied
  // run recorded, and every one of them removed once past its retention.
  assert.deepEqual([pi.live(), watchedRuns(), liveRuns().length], [0, 0, 0]);
  const registry = runsDirectory(root);
  assert.equal(readdirSync(registry).length, pi.started.length);
  assert.equal(pi.started.filter(directory => existsSync(join(directory, 'record.json'))).length, pi.started.length, 'every run, lost ones included, has its record');
  pruneRunDirectories(registry, clock.now() + runDirectoryRetentionMs + hour);
  assert.deepEqual(readdirSync(registry), [], 'ended runs leave the registry once past their retention');
});

test('unit:soak-invariants-hold — sessions blocked on a GitHub credential failure are ended once each and relaunched on the retry ladder: one item recovers and is delivered, one that never recovers is held at the attempt cap, and every invariant holds', { timeout: 600_000 }, async () => {
  // GY-999: a worker whose push is refused for want of a valid GitHub login records that blocker.
  // The loop ends the attempt in the cycle that sees it — work kept, pane closed, lease released —
  // and the item is launched again with a fresh credential. The ending counts on the GY-885 retry
  // ladder: each relaunch waits its backoff, and an item whose every attempt fails that way is held
  // at the cap for an independent approver's decision instead of being ended and relaunched for ever. The ending and the relaunch run per item and per cycle, so they live here.
  const recovers = 2, never = 3;
  const { items, final, violations, failures, lost, herdrClosed, sessions, state } = await simulateDay({
    hours: 6, credentialBlocked: { recovers, never },
    plan: { items: 6, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 6, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 6 } },
  });
  assert.deepEqual(violations, [], 'every system invariant holds across the credential endings and the relaunches');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost: each blocked attempt was ended by the loop');
  const recovering = items[recovers - 1], held = items[never - 1];
  assert.deepEqual(final.filter(item => item.stage !== 'done' && item.id !== held.id).map(item => `${item.key} ${item.stage}`), [], 'every other item, the recovering one included, is delivered');

  const attemptsOf = (work: Work) => sessions.filter(session => session.key === work.key);
  const endings = (work: Work) => Object.entries(state.actions).filter(([key]) => key.startsWith(`resume:credential:${work.id}:`));
  // The recovering item: two blocked attempts, each ended once, then the third delivers.
  const mine = attemptsOf(recovering);
  assert.equal(mine.length, 3, `two blocked attempts and the one that delivered: ${mine.map(session => `${session.epoch}:${session.state}`).join(', ')}`);
  assert.deepEqual(mine.slice(0, 2).map(session => session.state), ['reclaimed', 'reclaimed']);
  assert.deepEqual(endings(recovering).map(([, action]) => [action.state, action.attempts]), [['done', 1], ['done', 1]], 'each blocked attempt was ended once');
  assert.ok(mine.slice(0, 2).every(session => herdrClosed.includes(session.pane)), 'the loop closed each blocked pane');
  // The relaunches wait the ladder's backoff: 5 minutes after the first ending, 15 after the second.
  assert.ok(mine[1].dispatchAt - mine[0].dispatchAt >= 5 * minute + 5 * minute, `the second attempt waited its backoff: ${(mine[1].dispatchAt - mine[0].dispatchAt) / minute} min`);
  assert.ok(mine[2].dispatchAt - mine[1].dispatchAt >= 5 * minute + 15 * minute, `the third attempt waited its backoff: ${(mine[2].dispatchAt - mine[1].dispatchAt) / minute} min`);

  // The never-curing item: bounded at the cap, never relaunched past it while the approver's refusal stands.
  const theirs = attemptsOf(held);
  assert.equal(theirs.length, 3, `the ladder bounds the relaunches at the cap: ${theirs.map(session => `${session.epoch}:${session.state}`).join(', ')}`);
  assert.deepEqual(endings(held).map(([, action]) => [action.state, action.attempts]), [['done', 1], ['done', 1], ['done', 1]]);
  assert.match(state.actions[`retry:held:${held.id}`]?.detail ?? '', /held: 3 attempts in a row ended without submitting.*credential-blocked attempt on epoch 1.*credential-blocked attempt on epoch 3/, 'the hold names every credential failure');
  assert.ok(state.actions[`retry:cap-request:${held.id}`], 'the loop asked for the decision that alone resumes the item, rather than relaunching it');
  assert.ok(theirs.every(session => session.state === 'reclaimed'), 'no blocked session was left holding its lease');
});

test('unit:soak-invariants-hold — attempts the loop ends with their containment fences raised are settled by the next cycle without waiting out the grace window, a 502 is retried on the cycle after it, the timed read stays one a cycle and only while such a fence stands, and every invariant holds', { timeout: 600_000 }, async () => {
  // GY-1155: the credential-blocked day with every launch fenced as `watch` fences it. The loop ends
  // each blocked attempt on its record, and its supervisor leaves the fence standing; the reclaim
  // step settles every fence of an attempt the loop ended as soon as the host verifies it gone —
  // per item, per cycle, which is why it lives here. The plane answers one settlement with Railway's
  // 502: that fence is retried on the next cycle, not held on the action backoff.
  const recovers = 2, never = 3;
  const { items, final, violations, failures, lost, state, fenced } = await simulateDay({
    hours: 6, credentialBlocked: { recovers, never }, containment: { failUntil: 0, slowUntil: 0, refuseSettle: recovers },
    plan: { items: 6, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 6, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 6 } },
  });
  assert.deepEqual(violations, [], 'every system invariant holds while the ended attempts\' fences stand and once they settle');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost');
  const held = items[never - 1];
  assert.deepEqual(final.filter(item => item.stage !== 'done' && item.id !== held.id).map(item => `${item.key} ${item.stage}`), [], 'every other item is delivered behind its settled fences');
  assert.deepEqual(final.filter(item => item.containmentQuarantine).map(item => item.key), [], 'no fence outlives the day');

  // Every attempt the loop ended had its fence settled once, by the cycle after the ending — the
  // record ended its lease, so nothing waited out the grace window — and the 502 cost one cycle more.
  const endings = Object.entries(state.actions).filter(([key, action]) => key.startsWith('resume:credential:') && action.state === 'done');
  assert.equal(endings.length, 5, `two endings of the recovering item and three of the held one: ${endings.map(([key]) => key).join(', ')}`);
  for (const [key, ending] of endings) {
    const [id, epoch] = key.slice('resume:credential:'.length).split(':');
    const settle = state.actions[`settle:${id}:${epoch}`], item = items.find(entry => entry.id === id)!;
    const refused = fenced.refused.some(entry => entry.key === item.key && entry.epoch === Number(epoch));
    assert.equal(settle?.state, 'done', `${item.key} epoch ${epoch}: its fence was settled: ${settle?.detail}`);
    assert.equal(settle.attempts, refused ? 2 : 1, `${item.key} epoch ${epoch}: settled ${refused ? 'on its retry after the 502' : 'at its first attempt'}`);
    assert.ok(settle.cycle - ending.cycle <= (refused ? 2 : 1), `${item.key} epoch ${epoch}: ended on cycle ${ending.cycle}, settled on cycle ${settle.cycle}`);
    assert.equal(fenced.settled.filter(entry => entry.key === item.key && entry.epoch === Number(epoch)).length, 1, `${item.key} epoch ${epoch}: lowered exactly once`);
  }
  assert.equal(fenced.refused.length, 1, 'the plane refused one settlement');
  const retried = fenced.settled.find(entry => entry.key === fenced.refused[0].key && entry.epoch === fenced.refused[0].epoch)!;
  assert.equal(retried.cycle, fenced.refused[0].cycle + 1, 'the refused settlement was retried on the very next cycle');

  // The volume stays bounded: at most one timed read a cycle, only in a cycle with a fence the
  // loop could settle, and none once the last one settled.
  const perCycle = new Map<number, number>();
  for (const probe of fenced.probes) perCycle.set(probe.cycle, (perCycle.get(probe.cycle) ?? 0) + 1);
  assert.deepEqual([...perCycle.values()].filter(count => count > 1), [], 'never more than one timed read in a cycle');
  assert.deepEqual([...perCycle.keys()].filter(cycle => !fenced.assessable.has(cycle)), [], 'a timed read only in a cycle with a fence the loop could settle');
  const lastSettled = Math.max(...fenced.settled.map(entry => entry.elapsed));
  assert.deepEqual(fenced.probes.filter(probe => probe.elapsed > lastSettled).map(probe => probe.elapsed / minute), [], 'no read after the last fence settled');
  assert.ok(perCycle.size <= endings.length + fenced.refused.length, `one read per fence, and one more for the 502: ${perCycle.size} reads for ${endings.length} fences`);
});

test('unit:soak-invariants-hold — sessions Herdr reports working whose runtime retries on a spent account are failed over: the account is held until the reset, the attempt ends with its partial work kept, the next launch takes another account, working sessions with no banner are left alone, and every invariant holds', { timeout: 600_000 }, async () => {
  // GY-973: OpenCode 1.18 on a spent account prints its "Limit Exhausted" banner with a retry
  // marker and retries for ever, so Herdr reports the session working. The loop reads every
  // working worker's and approver's screen tail on every cycle; across the day exactly the two
  // retrying sessions — one worker, one approver — are failed over, once each, and every other
  // working session, read just as often, is left to its work.
  const worker = 2, approver = 3;
  const { items, final, violations, failures, lost, sessions, state, heldAccounts, approverAccounts, retryReset } = await simulateDay({
    hours: 6, retrying: { worker, approver },
    plan: { items: 6, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set([approver]), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 6, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 6 } },
  });
  assert.deepEqual(violations, [], 'every system invariant holds across the failovers');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost: the retrying attempt was ended by the loop');
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item is delivered, the two whose sessions were spent included');
  const resetsAt = retryReset.toISOString();
  const failovers = Object.entries(state.actions).filter(([, action]) => action.kind === 'failover');
  assert.deepEqual(failovers.map(([, action]) => [action.work, action.state, action.attempts]).sort(), [[items[worker - 1].key, 'done', 1], [items[approver - 1].key, 'done', 1]].sort(),
    `exactly the two retrying sessions were failed over, once each: ${JSON.stringify(failovers)}`);

  // The worker: its attempt ended with its work kept, its account held until the banner's reset,
  // and the item went to another account, which delivered it; the spent account took no launch since.
  const spent = items[worker - 1], attempts = sessions.filter(session => session.key === spent.key);
  assert.equal(attempts[0].state, 'failed-over', `the retrying session was stopped on its ended lease: ${attempts.map(session => `${session.epoch}:${session.state}`).join(', ')}`);
  const [, workerFailover] = failovers.find(([, action]) => action.work === spent.key)!;
  assert.ok(workerFailover.detail.includes(`exhausted account-${attempts[0].profile.name} mid-session (Weekly/Monthly Limit Exhausted`) && workerFailover.detail.includes(`resets ${resetsAt}`), workerFailover.detail);
  assert.match(workerFailover.detail, /Partial work committed at [0-9a-f]{12}; the attempt ended as released/);
  const exhaustion = final.find(item => item.id === spent.id)!.capacity!.exhaustions[0];
  assert.deepEqual([exhaustion.account, exhaustion.resetsAt, exhaustion.partialWork.state], [`account-${attempts[0].profile.name}`, resetsAt, 'committed']);
  assert.equal(heldAccounts.get(`account-${attempts[0].profile.name}`)?.resetsAt, resetsAt, 'the account is held until the reset the banner names');
  assert.ok(attempts.length >= 2 && attempts[1].profile.name !== attempts[0].profile.name, `the next attempt went to another account: ${attempts.map(session => session.profile.name).join(', ')}`);
  const failedAt = Date.parse(workerFailover.at);
  assert.deepEqual(sessions.filter(session => session.profile.name === attempts[0].profile.name && session.dispatchAt > failedAt).map(session => session.key), [], 'no launch went to the held account after the failover');

  // The approver: its decision went to the next account in the same cycle, which judged it.
  const [, approverFailover] = failovers.find(([, action]) => action.work === items[approver - 1].key)!;
  assert.ok(approverFailover.detail.includes('exhausted approver-a mid-session (Weekly/Monthly Limit Exhausted') && approverFailover.detail.includes(`resets ${resetsAt}`), approverFailover.detail);
  assert.deepEqual(approverAccounts.filter(entry => entry.key === items[approver - 1].key).map(entry => entry.account).slice(0, 2), ['approver-a', 'approver-b'], 'the same decision was relaunched on the next account');
  assert.equal(heldAccounts.get('approver-a')?.resetsAt, resetsAt);
  assert.ok(!approverAccounts.some(entry => entry.account === 'approver-a' && entry !== approverAccounts.find(first => first.key === items[approver - 1].key)), 'no approver launched on the held account after it was held');
});

test('unit:soak-invariants-hold — a worker blocked on Claude\'s usage-limit menu is failed over once by the real loop across the day: never answered, its account held until the reset its notice names, its attempt ended and the item delivered on another account, while a worker blocked over its own prose about a quota is left to its work, and every invariant holds', { timeout: 600_000 }, async () => {
  // GY-1566: the loop reads every blocked worker's screen on every cycle. One worker's first
  // attempt stops on Claude's usage-limit menu, five minutes in; another blocks for three minutes
  // over its own words quoting the notice, the question and the choices, then carries on.
  const worker = 2, prose = 4;
  const { items, final, violations, failures, lost, sessions, state, heldAccounts, limitMenuDay, menuReset, menuNotice } = await simulateDay({
    hours: 6, limitMenu: { worker, prose },
    plan: { items: 6, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 6, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 6 } },
  });
  assert.deepEqual(violations, [], 'every system invariant holds across the failover');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost: the blocked attempt was ended by the loop');
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item is delivered, the spent one included');
  const resetsAt = menuReset.toISOString();

  // Bounded and once only: exactly one failover across the day's cycles, of the spent attempt, in one attempt.
  const failovers = Object.entries(state.actions).filter(([, action]) => action.kind === 'failover');
  const spent = items[worker - 1];
  assert.deepEqual(failovers.map(([, action]) => [action.work, action.state, action.attempts]), [[spent.key, 'done', 1]], `exactly the menu's session was failed over, once: ${JSON.stringify(failovers)}`);
  const [, failover] = failovers[0];
  assert.ok(failover.detail.includes(`mid-session (${menuNotice}; resets ${resetsAt})`), failover.detail);
  assert.deepEqual(limitMenuDay.holds.map(entry => [entry.account, entry.resetsAt]), [[failover.detail.match(/exhausted (account-\S+) mid-session/)![1], resetsAt]], 'one account held, once, until the reset the notice names in its own zone');
  assert.deepEqual(limitMenuDay.answered, [], 'the loop never chose on the menu, least of all "Switch to usage credits"');

  // The spent attempt was stopped within a cycle or two of the menu, and the item went to another account, which delivered it.
  const attempts = sessions.filter(session => session.key === spent.key);
  assert.equal(attempts[0].state, 'failed-over', attempts.map(session => `${session.epoch}:${session.state}`).join(', '));
  const menuAt = attempts[0].dispatchAt + 5 * minute;
  assert.ok(Date.parse(failover.at) - menuAt <= 2 * minute, `failed over within two cycles of the menu: ${JSON.stringify({ menuAt: new Date(menuAt), failoverAt: failover.at })}`);
  assert.deepEqual(limitMenuDay.stoppedAt.map(entry => `${entry.key}:${entry.epoch}`), [`${spent.key}:${attempts[0].epoch}`], 'its supervisor stopped on the ended lease, once');
  const exhaustion = final.find(item => item.id === spent.id)!.capacity!.exhaustions[0];
  assert.deepEqual([exhaustion.account, exhaustion.reason, exhaustion.resetsAt, exhaustion.partialWork.state], [`account-${attempts[0].profile.name}`, menuNotice, resetsAt, 'committed']);
  assert.equal(heldAccounts.get(`account-${attempts[0].profile.name}`)?.resetsAt, resetsAt, 'the spent account is held until it resets');
  assert.ok(attempts.length >= 2 && attempts[1].profile.name !== attempts[0].profile.name, `redispatched to a healthy account: ${attempts.map(session => session.profile.name).join(', ')}`);
  assert.ok(attempts[1].dispatchAt - Date.parse(failover.at) <= 2 * minute, 'within a cycle or two of the failover, with no master action');
  assert.deepEqual(sessions.filter(session => session.profile.name === attempts[0].profile.name && session.dispatchAt > Date.parse(failover.at)).map(session => session.key), [], 'no launch went to the held account after the failover');

  // GY-402: the prose session blocked over its own words, was read on those cycles, and was neither failed over nor held.
  assert.deepEqual(limitMenuDay.proseBlocked, [items[prose - 1].key], 'the prose session blocked over its own words');
  const proseAttempts = sessions.filter(session => session.key === items[prose - 1].key);
  assert.deepEqual(proseAttempts.map(session => session.state), ['submitted'], `its one attempt carried on and submitted: ${proseAttempts.map(session => `${session.epoch}:${session.state}`).join(', ')}`);
});

test('unit:soak-invariants-hold — a worker spent on Claude\'s usage-limit menu holds its twin, the account on the same provider login, across every cycle until the reset its notice names: neither takes a launch meanwhile, the item is delivered on the other subscription, both return at the reset, and every invariant holds', { timeout: 600_000 }, async () => {
  // GY-1573: worker profiles one and two run on two login homes of one Claude subscription, three on
  // another. The loop reads every profile's accounts on every cycle through the real account read,
  // and the menu's hold is recorded where that read finds it; the notice's reset falls inside the day.
  const worker = 2;
  const { items, final, violations, failures, lost, sessions, state, limitMenuDay, menuReset, menuNotice, dayStart } = await simulateDay({
    hours: 6, limitMenu: { worker, prose: 99, twinLogin: true },
    plan: { items: 6, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 6, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 6 } },
  });
  assert.deepEqual(violations, [], 'every system invariant holds while the twin is held and after it is released');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost');
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item is delivered');
  const resetsAt = menuReset.toISOString(), reset = menuReset.getTime();

  const spent = items[worker - 1], attempts = sessions.filter(session => session.key === spent.key);
  const failovers = Object.entries(state.actions).filter(([, action]) => action.kind === 'failover');
  assert.deepEqual(failovers.map(([, action]) => [action.work, action.state, action.attempts]), [[spent.key, 'done', 1]], JSON.stringify(failovers));
  const failedAt = Date.parse(failovers[0][1].at);
  assert.deepEqual(limitMenuDay.answered, [], 'the menu is never answered');
  const spentProfile = attempts[0].profile.name;
  assert.ok(['one', 'two'].includes(spentProfile), `the menu's session ran on one of the twin logins: ${spentProfile}`);
  const twin = spentProfile === 'one' ? 'two' : 'one';
  assert.deepEqual(limitMenuDay.holds.map(entry => [entry.account, entry.resetsAt]), [[`account-${spentProfile}`, resetsAt]], 'only the spent account is held by name; its twin is held by its login');

  // Every cycle between the hold and the reset read both logins unavailable, the twin naming the spent one; the other subscription never.
  const holdStart = limitMenuDay.holds[0].elapsed, releaseAt = reset - dayStart;
  const between = limitMenuDay.twinReads.filter(read => read.elapsed > holdStart && read.elapsed < releaseAt), after = limitMenuDay.twinReads.filter(read => read.elapsed >= releaseAt);
  assert.ok(between.length >= 60, `the hold stood across many cycles: ${between.length} reads`);
  for (const read of between) {
    assert.ok(read.unavailable[spentProfile] && read.unavailable[twin], `both logins of the spent subscription are unavailable at ${read.elapsed}: ${JSON.stringify(read.unavailable)}`);
    assert.match(read.unavailable[twin], new RegExp(`account-${twin} is the same provider login as account-${spentProfile} exhausted its quota mid-session`));
    assert.ok(read.unavailable[twin].includes(menuNotice) && read.unavailable[twin].includes(`it resets ${resetsAt}`), read.unavailable[twin]);
    assert.equal(read.unavailable.three, undefined, 'the other subscription is unaffected');
  }
  assert.ok(after.length > 0, 'the day reads accounts past the reset');
  for (const read of after) assert.deepEqual(read.unavailable, {}, `both logins return at the reset: ${read.elapsed} ${JSON.stringify(read.unavailable)}`);

  // Neither login took a launch between the failover and the reset; the item went to the other subscription.
  assert.deepEqual(sessions.filter(session => [spentProfile, twin].includes(session.profile.name) && session.dispatchAt > failedAt && session.dispatchAt < reset).map(session => `${session.key}@${session.profile.name}`), [],
    'no launch landed on the spent subscription before its reset');
  assert.equal(attempts[1]?.profile.name, 'three', `redispatched on the other subscription: ${attempts.map(session => session.profile.name).join(', ')}`);
});

test('unit:soak-invariants-hold — containment quarantines of dead workers stand across many cycles while the timed clock read fails and then answers slowly, one read a cycle and none without an assessable quarantine, each escalation recorded once, and they settle once reads are fast, with every invariant holding', { timeout: 600_000 }, async () => {
  // GY-811: every supervised launch raises a containment quarantine; two workers die, so their
  // fences outlive them and only the loop can lower them. The work snapshot takes 6 s to read, so
  // its bound is too wide to settle with — the shared cause of GY-466, GY-521 and GY-543. The
  // loop's light timed read of the plane's clock fails for the first stretch of the day, answers in
  // 6 s for the next, and only then answers fast: the fences stand, escalated once per cause, and
  // settle within a cycle or two of the fast reads. The day is short and its items released close
  // together: it runs last in the file, where each one-minute cycle costs the most (about 200 s on
  // a CI runner, so its bound is about twice that, like the regression day's), and last so that no
  // other day pays for the state it leaves.
  const failUntil = 35 * minute, slowUntil = hour, deaths = [2, 4];
  const { items, final, violations, failures, lost, escalations, fenced, cycles } = await simulateDay({
    hours: 3, containment: { failUntil, slowUntil },
    plan: { items: 6, leftovers: 2, slowRecompute: 0, releaseEveryMs: 5 * minute, workMs: 20 * minute, rework: new Set(), deaths: new Set(deaths), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set([3]), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 6, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 6 } },
  });
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}: ${item.gates.flatMap(gate => gate.reasons).join('; ')}`), [], 'all seven items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds while the fences stand and once they settle');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost: a dead worker lapses and its fence waits for the loop');
  assert.deepEqual(final.filter(item => item.containmentQuarantine).map(item => item.key), [], 'no fence outlives the day');

  // Probe volume is bounded: at most one timed read a cycle, exactly one in each cycle with a
  // quarantine past its grace window, and none in a cycle whose quarantines are all live or still in
  // grace, or that has none (GY-1044).
  const perCycle = new Map<number, number>();
  for (const probe of fenced.probes) perCycle.set(probe.cycle, (perCycle.get(probe.cycle) ?? 0) + 1);
  assert.deepEqual([...perCycle.values()].filter(count => count > 1), [], 'never more than one timed read in a cycle');
  assert.deepEqual([...perCycle.keys()].filter(cycle => !fenced.assessable.has(cycle)), [], 'a timed read only in a cycle with an assessable quarantine');
  assert.deepEqual([...fenced.assessable].filter(cycle => !perCycle.has(cycle)), [], 'every cycle with an assessable quarantine read the clock');
  assert.ok(fenced.liveOnly.size > 30, `many cycles held only live workers' fences, and read no clock (${fenced.liveOnly.size})`);
  assert.ok(fenced.bare.size > 0, 'cycles with no fence at all read no clock');
  assert.ok(fenced.graced.size > 0, `cycles whose fences were at most in their grace window read no clock (${fenced.graced.size})`);
  const lastSettled = Math.max(...fenced.settled.map(entry => entry.elapsed));
  assert.deepEqual(fenced.probes.filter(probe => probe.elapsed > lastSettled).map(probe => probe.elapsed / minute), [], `no read after the last fence settled, for the rest of the day's ${cycles} cycles`);
  for (const phase of ['fail', 'slow', 'fast'] as const) assert.ok(fenced.probes.some(probe => probe.phase === phase), `the fences stood through ${phase} reads`);

  for (const n of deaths) {
    const key = items[n - 1].key;
    // The dead attempt's fence stood through the failing and the slow reads, refused for the
    // width of the bound the read measured, and settled once the reads were fast.
    const refused = fenced.assessed.filter(entry => entry.key === key && entry.epoch === 1 && entry.refusals.length);
    assert.ok(refused.some(entry => entry.elapsed < failUntil && entry.refusals.some(reason => /the snapshot read of the control-plane clock took \d+ms round trip/.test(reason))),
      `${key}: while the timed read failed, the snapshot's bound was refused naming its round trip: ${JSON.stringify(refused.slice(0, 2))}`);
    assert.ok(refused.some(entry => entry.elapsed >= failUntil && entry.elapsed < slowUntil && entry.refusals.some(reason => /the timed read of the control-plane clock took 6\d{3}ms round trip/.test(reason))),
      `${key}: while the timed read was slow, it was refused naming that read's round trip`);
    const settled = fenced.settled.filter(entry => entry.key === key);
    assert.equal(settled.length, 1, `${key}: the dead attempt's fence settled exactly once: ${JSON.stringify(fenced.settled)}`);
    assert.ok(settled[0].elapsed >= slowUntil && settled[0].elapsed <= slowUntil + 3 * minute, `${key}: it settled within the first cycles of fast reads (+${Math.round(settled[0].elapsed / minute)} min)`);
    // Each cause of the standing fence was escalated once: the round trip a read measured, and
    // whether the timed or the snapshot read measured it, change from cycle to cycle, and neither
    // is a new cause (GY-1044) — the failing and the slow reads are one unbounded clock.
    const escalated = escalations.filter(detail => detail.startsWith(`${key}: containment quarantine from epoch 1 `));
    assert.ok(escalated.length >= 1 && escalated.length <= 3, `${key}: the standing fence was escalated once per cause, not once per cycle: ${escalated.length}`);
    assert.ok(escalated.some(detail => /control-plane clock took \d+ms round trip/.test(detail)), `${key}: the unbounded clock was escalated: ${JSON.stringify(escalated)}`);
    assert.equal(new Set(escalated.map(containmentRefusalCause)).size, escalated.length, `${key}: no escalation repeats: ${JSON.stringify(escalated)}`);
    assert.equal(final.find(item => item.key === key)!.stage, 'done', `${key}: delivered by the attempt after the settled one`);
  }
});

test('integration:soak-stuck-watches-invariants-hold — twelve approval watches whose registry sessions aged out of the registry\'s history are ended once each on the day\'s first cycle, and every system invariant, cycle-p90 among them, holds', { timeout: 480_000 }, async () => {
  // GY-1504: the live loop carried twelve such watches for long-closed items, each end answered 404
  // Unknown session and retried every cycle; the day starts with the same twelve in its state.
  const { final, violations, failures, state, stuck, cycles } = await simulateDay({ hours: 6, stuckWatches: 12, plan: { lowLane: 0 } });
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.ok(cycles > 12, `the day ran many cycles: ${cycles}`);
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => item.key), [], 'the day\'s items are delivered beside them');
  assert.equal(stuck.ends.size, 12, 'every aged-out session was asked to end');
  assert.deepEqual([...stuck.ends.values()].filter(count => count > 1), [], 'and none of them twice');
  assert.deepEqual(Object.values(state.approvals).filter(watch => watch.session && stuck.sessions.has(watch.session)), [], 'no watch keeps an aged-out session');
  assert.deepEqual(Object.values(state.actions).filter(action => action.kind === 'close' && action.state === 'failed' && /Unknown session/.test(action.detail)), [], 'no close failure stands for one');
});
