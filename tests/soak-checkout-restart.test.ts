import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selfUpgradeBoundMs } from '../src/master-resources.js';
import { closesFaultClass } from '../src/model/fault-classes.js';
import { hour, minute } from './helpers/soak-world.js';
import { soakControlPlanes, store } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * GY-1531 under the real loop for simulated hours. Instances 2026-10-08T01:09Z and 04:11Z: the
 * coordinator checkout's HEAD moved under the running loop, the dirty-checkout guard stood for hours
 * naming one remedy, the loaded-revision resource sat at its bound with no headroom, and the
 * supervisor's restart — the remedy — was itself recorded as a refusal by the stopping loop. The
 * doctor's own vehicle for the class was refused on every cycle: its filing proved a criterion by
 * `e2e:self-upgrade-loaded-revision-clears`, a scenario nothing had registered.
 *
 * One concern of the release-candidate soak (GY-404), in its own file (GY-1363): the world is
 * tests/helpers/soak-world.ts, the control planes tests/helpers/soak-plane.ts, the day
 * tests/helpers/soak-simulation.ts (`checkoutRestart`), and the system invariants are asserted after
 * every cycle. The day moves HEAD twice: once restored by hand (the first remedy), once left where it
 * moved until the supervisor restarts the loop onto it (the second); the diagnostician's provider is
 * spent all day, so the filed items stand open as filed, unclosed by any diagnosis.
 */
soakControlPlanes('soak-checkout-restart', 415);

const scenario = 'self-upgrade-loaded-revision-clears';
const headMove = { from: 80 * minute, to: 100 * minute }, moveAt = 2 * hour, restartAt = 3 * hour + 40 * minute;
const doctor = { scenario, from: 130 * minute, outage: { from: 130 * minute, to: 160 * minute } };
const plan = { items: 4, leftovers: 0, slowRecompute: 0, unstable: 0, attested: 0, workMs: 15 * minute, rework: new Set<number>(), deaths: new Set<number>(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set<number>(), misread: new Set<number>(), exits: new Set<number>(), spentProducer: 0, lostRuns: 0,
  outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 }, loopRestarts: [] as number[], dirtyCheckout: { from: 99 * hour, to: 100 * hour }, headMove };
const short = (sha: string) => sha.slice(0, 12);
type Day = Awaited<ReturnType<typeof simulateDay>>;
/** The day: HEAD moved `kind`-wise and restarted onto; a `forward` day never aligns (no deploy), so the base tip stands ahead of what the loop loaded. */
const restartDay = (kind: 'foreign' | 'forward', withDoctor: boolean) => simulateDay({ hours: 6, plan: { ...plan, deploys: kind === 'forward' ? [] : [hour] }, diagnosisLimit: { from: 0, to: 99 * hour },
  checkoutRestart: { moveAt, restartAt, kind, ...(withDoctor ? { doctor } : {}) } });
let foreignDay: Day | null = null;

/** What every restart day must show of the guard, whichever way HEAD moved. */
function assertGuard(day: Day, kind: 'foreign' | 'forward') {
  const r = day.restartDay!, label = `${kind} move`;
  assert.deepEqual(day.violations, [], `${label}: every system invariant holds after every cycle`);
  assert.deepEqual(day.failures, [], `${label}: no cycle failed`);
  assert.deepEqual(day.lost, [], `${label}: no lease was lost`);
  assert.equal(day.guardReads.headMoves, 2, `${label}: the day moved HEAD twice`);
  const loaded = r.readings.find(sample => sample.elapsed >= moveAt)!.loaded, to = r.movedTo!;
  assert.equal(day.github.commits.has(to), kind === 'forward', `${label}: a forward move lands on merged code, a foreign one off the graph`);
  // The first remedy: the HEAD moved by a session outside the loop stood refused for its window and
  // was put back; the clearance is recorded and said in the journal.
  const restored = r.refusals.filter(sample => sample.elapsed >= headMove.from && sample.elapsed < headMove.to);
  assert.ok(restored.length >= 2 && restored.every(sample => sample.refusal && /moved from/.test(sample.refusal) && sample.escalation?.state === 'failed'), `${label}: the first move stood refused across its window (${restored.length} cycles)`);
  const putBack = r.refusals.find(sample => sample.elapsed >= headMove.to)!;
  assert.equal(putBack.refusal, null, `${label}: the restored checkout refuses nothing`);
  assert.equal(putBack.escalation?.state, 'done', `${label}: the restore ends the refusal`);
  assert.ok(r.journal.some(entry => entry.elapsed >= headMove.to && entry.elapsed < moveAt && entry.line === `[graphyard-master] escalation done: the coordinator checkout at /soak/coordinator is clean again at ${short(loaded)}, the commit the loop runs`), `${label}: the clearance is in the journal`);
  // The second move, which nothing restores: the refusal names both remedies, every cycle, with the
  // one escalation row standing unchanged — a standing refusal grows nothing.
  const standing = r.refusals.filter(sample => sample.elapsed >= moveAt && sample.elapsed < r.restartedAt!);
  assert.ok(standing.length >= 6 && r.restartedAt! - moveAt >= 90 * minute, `${label}: the refusal stood for ${(r.restartedAt! - moveAt) / minute} minutes over ${standing.length} cycles`);
  assert.equal(new Set(standing.map(sample => sample.refusal)).size, 1, `${label}: one refusal text all window`);
  const refusal = standing[0].refusal!;
  assert.match(refusal, new RegExp(`^the master loop refuses to restart or self-upgrade from the coordinator checkout at /soak/coordinator: its HEAD moved from ${short(loaded)} to ${short(to)} while the loop was running, so HEAD is not the commit it runs\\.`), `${label}: the refusal names the commit the loop runs and the HEAD it found`);
  assert.ok(refusal.includes(`either remedy ends this refusal (GY-1531): restore the checkout with git -C /soak/coordinator checkout --detach ${short(loaded)} and restart the loop, or leave it at ${short(to)} and restart the loop onto that HEAD (systemctl --user restart graphyard-master), which loads it`), `${label}: the refusal names both remedies: ${refusal}`);
  assert.equal(new Set(standing.map(sample => `${sample.escalation?.state}/${sample.escalation?.attempts}`)).size, 1, `${label}: the escalation row stands unchanged while the refusal stands (its attempts grow only when what it names changes)`);
  assert.equal(standing[0].escalation?.state, 'failed');
  // The restart: the stopping loop reports the drift to its caller, records no refusal for the
  // HEAD the restart loads, and says so; the new process loads that HEAD, refuses nothing, ends the
  // standing escalation and says that too — then no refusal recurs for the rest of the day.
  const stop = r.stop!;
  assert.ok(stop.elapsed >= restartAt && stop.elapsed < restartAt + 10 * minute && stop.elapsed === r.restartedAt, `${label}: the supervisor's restart landed at +${stop.elapsed / minute} min`);
  assert.match(stop.refusal ?? '', /moved from/, `${label}: the stopping loop still reports the drift`);
  assert.equal(stop.upgraded, null, `${label}: no self-upgrade runs in a stopping loop`);
  assert.deepEqual({ state: stop.escalation?.state, attempts: stop.escalation?.attempts }, { state: 'failed', attempts: standing.at(-1)!.escalation!.attempts }, `${label}: the stopping loop recorded no new refusal: the row stands as the last cycle left it`);
  assert.ok(r.journal.some(entry => entry.elapsed >= stop.elapsed && entry.elapsed < stop.elapsed + minute && entry.line === `[graphyard-master] stopping with the coordinator checkout's HEAD at ${short(to)}, not ${short(loaded)} the loop loaded: the next loop runs the checkout's HEAD, so no dirty-checkout refusal is recorded`), `${label}: the stop says why no refusal is recorded: ${r.journal.filter(entry => entry.elapsed >= stop.elapsed).map(entry => entry.line).join(' | ')}`);
  assert.equal(r.startRefusal, null, `${label}: the restarted loop refuses nothing at startup`);
  // The restart cycle's own sample is the stopping loop's read, which reports the drift it does not record.
  const after = r.refusals.filter(sample => sample.elapsed > r.restartedAt!);
  assert.ok(after.length >= 6 && after.at(-1)!.elapsed - r.restartedAt! >= hour, `${label}: the day ran on for ${(after.at(-1)!.elapsed - r.restartedAt!) / minute} minutes after the restart`);
  assert.ok(after.every(sample => sample.refusal === null), `${label}: no dirty-checkout refusal stands after the restart: ${after.filter(sample => sample.refusal).map(sample => `+${sample.elapsed / minute} min`).join(', ')}`);
  assert.ok(after.every(sample => sample.escalation?.state === 'done'), `${label}: the escalation stays settled`);
  const ended = Date.parse(after[0].escalation!.at) - day.dayStart;
  assert.ok(ended >= r.restartedAt! && ended < r.restartedAt! + minute, `${label}: the restart's startup read ended the refusal at +${ended / minute} min`);
  assert.ok(r.journal.some(entry => entry.elapsed >= stop.elapsed && entry.line === `[graphyard-master] escalation done: the coordinator checkout at /soak/coordinator is clean again at ${short(to)}, the commit the loop runs`), `${label}: the restart's clearance is in the journal`);
  assert.equal(r.journal.filter(entry => entry.line.startsWith('[graphyard-master] escalation done:')).length, 2, `${label}: one clearance per remedy`);
  assert.ok(!r.journal.some(entry => entry.elapsed > stop.elapsed && entry.line.startsWith('[graphyard-master] escalation failed')), `${label}: no refusal is raised after the restart`);
  assert.equal(Object.keys(day.state.actions).filter(key => key.startsWith('escalation:dirty-checkout')).length, 1, `${label}: the guard keeps one escalation row`);
  assert.equal(day.state.release?.commit, to, `${label}: the re-executed loop reports the release the checkout holds`);
  assert.equal(day.checkout.head, to, `${label}: the checkout stays where the restart found it`);
}

test('manual:coordinator-checkout-restored-and-loop-restarted — over a simulated day of the real loop, a HEAD moved under the running loop stands refused naming both remedies; restoring it ends the refusal, and so does the supervisor restart: the stopping loop records no refusal for the HEAD the restart loads, the new process loads it, settles the escalation audibly and no refusal recurs for the rest of the day, for a foreign and a forward move alike', { timeout: 600_000 }, async () => {
  foreignDay ??= await restartDay('foreign', true);
  assertGuard(foreignDay, 'foreign');
  assertGuard(await restartDay('forward', false), 'forward');
});

test('manual:loaded-revision-equals-checkout-head-after-restart — the loaded-revision reading over the same day: at its bound with no headroom once the moved HEAD outlived the self-upgrade bound, then zero commits behind, loaded revision equal to the checkout HEAD and never at its limit again across the whole hour after the restart and beyond', { timeout: 600_000 }, async () => {
  foreignDay ??= await restartDay('foreign', true);
  const r = foreignDay.restartDay!, loaded = r.readings.find(sample => sample.elapsed >= moveAt)!.loaded, to = r.movedTo!;
  const calm = r.readings.filter(sample => sample.elapsed < headMove.from || (sample.elapsed >= headMove.to && sample.elapsed < moveAt));
  assert.ok(calm.length > 0 && calm.every(sample => sample.used === 0 && sample.state === 'ok' && !sample.attention), 'with the checkout at the commit it loaded the loop is nothing behind');
  // Inside the self-upgrade's bound the move is the upgrade under way; past it, the fault: behind
  // by the one commit HEAD moved onto, at its bound of zero, no headroom, raising attention —
  // every cycle until the restart.
  const grace = r.readings.filter(sample => sample.elapsed >= moveAt && sample.elapsed < moveAt + selfUpgradeBoundMs);
  assert.ok(grace.length > 0 && grace.every(sample => sample.used === 0 && /the self-upgrade has until/.test(sample.detail)), 'within the bound the move reads as the upgrade under way');
  const atLimit = r.readings.filter(sample => sample.elapsed >= moveAt + selfUpgradeBoundMs && sample.elapsed < r.restartedAt!);
  assert.ok(atLimit.length >= 6 && r.restartedAt! - (moveAt + selfUpgradeBoundMs) >= hour, `the fault stood ${(r.restartedAt! - moveAt - selfUpgradeBoundMs) / minute} minutes past the bound over ${atLimit.length} cycles`);
  assert.ok(atLimit.every(sample => sample.used === 1 && sample.state === 'exhausted' && sample.attention), `the reading sits at its bound with no headroom until the restart: ${JSON.stringify(atLimit.find(sample => !sample.attention))}`);
  assert.ok(atLimit.every(sample => sample.detail === `the loop loaded ${short(loaded)}; the checkout is at ${short(to)}`), `the reading names what the loop loaded and what the checkout holds: ${atLimit[0].detail}`);
  // After the restart: the loaded revision is the checkout HEAD, zero commits behind, headroom
  // restored, and the reading never reports at-limit again — sampled every cycle for well over the hour.
  const after = r.readings.filter(sample => sample.elapsed >= r.restartedAt!);
  assert.ok(after.length >= 6 && after.at(-1)!.elapsed - r.restartedAt! >= hour, `${after.length} readings over ${(after.at(-1)!.elapsed - r.restartedAt!) / minute} minutes after the restart`);
  assert.ok(after.every(sample => sample.loaded === to && sample.checkout === to), 'the loaded revision equals the coordinator checkout HEAD after the restart');
  assert.ok(after.every(sample => sample.used === 0 && sample.state === 'ok' && !sample.attention), `0 commits behind with headroom, never at-limit, through the following hour and beyond: ${JSON.stringify(after.find(sample => sample.used !== 0 || sample.attention))}`);
  assert.ok(after.every(sample => sample.detail === `the loop loaded ${short(to)}; the checkout is at ${short(to)}`), `the reading names the one revision: ${after[0].detail}`);
  assert.equal(foreignDay.state.release?.commit, to, 'the restarted process reports the checkout\'s revision as its release');
});

test('manual:fault-filing-dirty-checkout-succeeds-after-scenario-fix — over the same day the doctor files the guard fault as it wrote it: the loop class, refused by the real control plane for its unregistered e2e scenario, is refused and dropped — recorded failed under fix-item and escalated by name for the master to file by hand, never re-filed; the configuration class is deduplicated against the open item already covering it; filings queued through a plane outage converge with bounded create attempts, nothing stays pending or failed, and the dropped filing is never kept for a retry', { timeout: 600_000 }, async () => {
  const day = await restartDay('foreign', true), r = day.restartDay!, { outage } = doctor;
  assert.deepEqual(day.violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(day.failures, [], 'no cycle failed');
  // The plane away: every create the doctor's filing cost was refused 503 and queued for a retry;
  // the retries are bounded by the backoff, never one a cycle for ever.
  const outageCreates = r.creates.filter(create => create.elapsed >= outage.from && create.elapsed < outage.to);
  assert.ok(outageCreates.length >= 3, `the filing was tried during the outage (${outageCreates.length} creates)`);
  assert.ok(outageCreates.every(create => /\(503\)/.test(create.outcome) && create.faultClass === 'loop' && create.proofs[1].includes(`e2e:${scenario}`)), `every create in the outage was refused by the unreachable plane, as the doctor wrote it: ${JSON.stringify(outageCreates)}`);
  const pendingKeys = new Set(r.pending.flatMap(sample => sample.keys)), outageCycles = r.pending.filter(sample => sample.elapsed >= outage.from && sample.elapsed < outage.to).length;
  assert.ok(pendingKeys.size >= 1 && outageCreates.length <= pendingKeys.size * (1 + Math.ceil(Math.log2(Math.max(2, outageCycles)))), `${outageCreates.length} creates for ${pendingKeys.size} pending filing(s) over ${outageCycles} cycles: bounded by the retry backoff`);
  assert.ok(r.pending.some(sample => sample.elapsed >= outage.from && sample.elapsed < outage.to && sample.keys.length > 0), 'the filing stood pending through the outage');
  // The plane back: the real engine refuses the unregistered scenario once with a 409; the filing is
  // malformed, so it is dropped (GY-1530) and escalated by name, not mended and not retried.
  const afterOutage = r.creates.filter(create => create.elapsed >= outage.to);
  assert.ok(afterOutage.length >= 1 && afterOutage.every(create => /^refused: Graphyard refused work \(409\)/.test(create.outcome)), `after the outage every create was refused, none accepted: ${JSON.stringify(afterOutage)}`);
  const [refused] = afterOutage;
  assert.match(refused.outcome, new RegExp(`^refused: Graphyard refused work \\(409\\): Register E2E scenario ${scenario} before creating work that requires it`), 'the control plane refuses the unregistered scenario');
  assert.deepEqual(refused.proofs, [['manual:dirty-checkout-detach-restart'], [`e2e:${scenario}`]]);
  assert.ok(r.creates.every(create => create.faultClass === 'loop'), `the doctor's configuration filing never reached the plane: ${JSON.stringify(r.creates.filter(create => create.faultClass !== 'loop'))}`);
  const items = await store.list();
  assert.equal(items.filter(item => closesFaultClass(item) === 'loop').length, 0, 'the refused filing created no item');
  assert.ok(items.some(item => closesFaultClass(item) === 'configuration' && item.stage !== 'done'), 'the loop\'s own recurring-fault item already covers the configuration class');
  const actions = Object.values(day.state.actions), notes = actions.map(action => action.detail);
  assert.ok(notes.some(detail => detail.startsWith('Not filing "Master loop cannot restart or self-upgrade: the dirty-checkout guard stands for hours": the configuration fault class is already covered by an open item')), 'the configuration filing is deduplicated against it');
  assert.ok(actions.some(action => action.state === 'failed' && /is not filed again/.test(action.detail) && action.detail.includes(scenario)), 'the refusal is recorded failed, naming the scenario');
  assert.ok(day.state.faults.instances.some(instance => instance.kind === 'fix-item'), 'the refusal opened a fix-item (proof) instance');
  assert.ok(actions.some(action => action.kind === 'escalation' && action.detail.includes(`e2e:${scenario}`) && /register it, or file the item by hand/.test(action.detail)), 'the escalation names the unregistered scenario for the master');
  // Convergence: nothing stays pending, and the dropped filing is never kept for a retry.
  assert.deepEqual(r.pending.at(-1)!.keys, [], 'no filing is left pending at the end of the day');
  // Each later create is a later doctor run proposing the filing afresh (the simulated doctor re-emits it
  // while no item covers the class), never the dropped pending file: the cursor holds none of them.
  assert.equal(r.creates.filter(create => create.elapsed > refused.elapsed).length, afterOutage.length - 1, 'every create after the first is a fresh run\'s filing');
});
