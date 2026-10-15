import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hour, minute } from './helpers/soak-world.js';
import { basePlan, soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * GY-1698 under the real loop over three simulated days. Item 1 ships with a post-deploy
 * verification whose reading is an intervention rate per three days; 25 minutes after its merge the
 * day files the follow-up exactly as master verify-deployment does (filePostDeployFollowUps over the
 * day's items, the report's projection read for the pattern) and releases it at once — as GY-1689 was
 * filed at 03:36Z for a 03:11Z merge and released at 06:39Z, days before the reading it owed could
 * exist. The filing is repeated on every later cycle, as verify-deployment runs after every deploy
 * observation, so the day shows one follow-up per parent however often it is asked. Every cycle of
 * the day samples the loop's own view of the follow-up: master status's row, its plain sentence,
 * its action queue, the sessions launched for it, the faults and escalations naming it, and
 * whether a master session is live. One concern of the day (GY-1363), in its own file: the world is
 * tests/helpers/soak-world.ts, the control planes tests/helpers/soak-plane.ts, the day
 * tests/helpers/soak-simulation.ts (`observationWindow`), and the system invariants are asserted
 * after every cycle.
 */
soakControlPlanes('soak-observation-window', 442);

const dayMs = 24 * hour, windowDays = 3, items = 5, filedAfterMs = 25 * minute;
const plan = { items, releaseEveryMs: 5 * minute, leftovers: 0, slowRecompute: 0, workMs: 15 * minute, rework: new Set<number>(), deaths: new Set<number>(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set<number>(), misread: new Set<number>(), exits: new Set<number>(), spentProducer: 0, lostRuns: 0,
  outOfQueue: { item: items, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: items }, loopRestarts: [] as number[], dirtyCheckout: { from: 99 * hour, to: 100 * hour }, headMove: { from: 99 * hour, to: 100 * hour }, deploys: basePlan.deploys };

test('unit:soak-invariants-hold — over three simulated days of the real loop, a post-deploy follow-up filed for a windowed criterion and released at once is held on its recorded instant: no dispatch, no stalled-gate attention, no fault and no session for two and a half days, every cycle naming the instant; past the instant it stays loop-owned — undispatched, unleased, without a session and without a fault — awaiting the loop\'s reading with no master session live, repeated filings add no second follow-up for the parent, and every system invariant holds', { timeout: 600_000 }, async () => {
  const day = await simulateDay({ hours: windowDays * 24 + 4, plan, observationWindow: { item: 1, windowDays, filedAfterMs } });
  const window = day.observationWindowDay!, iso = (ms: number) => new Date(ms).toISOString();
  assert.deepEqual(day.violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(day.failures, [], 'no cycle failed');
  assert.deepEqual(day.lost, [], 'no lease was lost');
  assert.deepEqual(day.final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'the five items are delivered');

  // Filed as verify-deployment files it, 25 minutes after the parent's merge, and released at once: the
  // follow-up carries the instant — the merge plus the criterion's three days, later than the report's
  // projection — and nothing dispatched it for the days before it.
  const parent = day.final[0], followUp = window.followUp!;
  assert.ok(parent.delivery && window.filedAt !== null && window.releasedAt !== null, 'the parent was delivered and its follow-up filed and released');
  const mergedAt = Date.parse(parent.delivery!.mergedAt), notBefore = mergedAt + windowDays * dayMs;
  assert.deepEqual([followUp.observationWindow?.notBefore, followUp.observationWindow?.basis], [iso(notBefore), 'criterion-window']);
  assert.match(followUp.observationWindow!.detail, new RegExp(`^${parent.key} merged at ${iso(mergedAt)} and AC-2 names a ${windowDays}-day window, so the reading can first exist at ${iso(notBefore)} \\(the intervention report's projection for the escalation reading at the build stage, ${iso(notBefore - 12 * hour)}, is earlier\\)$`));
  assert.deepEqual(followUp.dependencies, [parent.id]);
  assert.ok(window.filedAt - mergedAt >= filedAfterMs && window.filedAt - mergedAt < filedAfterMs + 2 * minute, `filed ${Math.round((window.filedAt - mergedAt) / minute)} minutes after the merge`);
  assert.ok(notBefore - window.releasedAt > 2 * dayMs, `released ${Math.round((notBefore - window.releasedAt) / hour)} hours before its instant`);
  // One follow-up per parent: the filing ran every cycle after the first and created one item.
  assert.ok(window.filings > 100, `the filing was repeated across the day: ${window.filings} filings`);
  assert.deepEqual(window.created, [followUp.key], 'one follow-up was created for the parent');
  assert.deepEqual(day.final.filter(item => item.key !== parent.key && item.dependencies.includes(parent.id)), [], 'and no other item depends on the parent');

  // Before the instant, on every cycle of the two and a half days: released and ready, no dispatch action,
  // no attention row, no fault, no escalation, no lease and no session; the status row and the plain
  // sentence name the instant; and the loop ran no master session all day.
  const before = window.samples.filter(sample => Date.parse(sample.at) < notBefore), after = window.samples.filter(sample => Date.parse(sample.at) >= notBefore);
  assert.ok(before.length >= 200 && Date.parse(before.at(-1)!.at) - Date.parse(before[0]!.at) > 2 * dayMs, `the loop cycled across the held days: ${before.length} cycles over ${Math.round((Date.parse(before.at(-1)!.at) - Date.parse(before[0]!.at)) / hour)} hours`);
  for (const sample of before) {
    const label = `${sample.at} (+${Math.round(sample.elapsed / hour)} h)`;
    assert.equal(sample.stage, 'ready', `${label}: released, at its ready stage`);
    assert.equal(sample.waiting, true, `${label}: master status reports the window still holding`);
    assert.equal(sample.attention, null, `${label}: no stalled-gate attention row: ${sample.attention}`);
    assert.equal(sample.attentionRows, 0, `${label}: no attention item`);
    assert.equal(sample.sentence, `Waiting for its observation window — the reading it owes can first exist at ${iso(notBefore)}`, label);
    assert.deepEqual(sample.dispatches, [], `${label}: no dispatch action was requested`);
    assert.deepEqual([sample.lease, sample.sessions, sample.faults, sample.escalations], [null, 0, [], []], `${label}: nobody holds it, no session, no fault, no escalation`);
  }
  assert.deepEqual(window.samples.filter(sample => sample.masterLive).map(sample => sample.at), [], 'no master session was live on any cycle of the day');

  // GY-1762: past the instant the reading is owed, not dispatchable: the follow-up is all manual post-deploy
  // proofs, so no code worker is ever launched, and it stays open until the loop's reading is recorded.
  const first = after[0]!;
  assert.ok(Date.parse(first.at) - notBefore <= 10 * minute, `the loop's first cycle past the instant ran within an idle step of it: ${first.at}`);
  assert.equal(first.waiting, false, 'master status reports the window no longer holding');
  for (const sample of after) {
    assert.deepEqual([sample.dispatches, sample.lease, sample.sessions, sample.stage], [[], null, 0, 'ready'], `${sample.at}: past its instant it is still undispatched, unleased and without a session`);
    assert.deepEqual(sample.faults, [], `${sample.at}: no fault names the follow-up`);
  }
  assert.equal(followUp.stage, 'ready', `the follow-up awaits the loop's reading: ${followUp.stage}`);
});

/**
 * GY-1726 and GY-1735 under the same real loop: the follow-up is filed without its window, as releases
 * before GY-1698 filed GY-1689 and GY-1721..GY-1725. The control plane derives the window that filing
 * owed it from the parent's own criterion at create (GY-1735), so the loop holds it from its filing as
 * it holds a windowed one: no worker is dispatched early, none has to defer or block, nothing escalates,
 * and past the instant it stays loop-owned, awaiting the loop's reading (GY-1762).
 */
test('unit:soak-invariants-hold — over three simulated days of the real loop, an unwindowed post-deploy follow-up is held from its filing on the window the control plane derives: no dispatch, no session, no defer, no fault and no escalation before the instant, loop-owned past it — undispatched, unleased and without a session, awaiting the loop\'s reading — nothing escalating it, and every system invariant holds', { timeout: 600_000 }, async () => {
  const day = await simulateDay({ hours: windowDays * 24 + 4, plan, observationWindow: { item: 1, windowDays, filedAfterMs, unwindowed: true } });
  const window = day.observationWindowDay!, iso = (ms: number) => new Date(ms).toISOString();
  assert.deepEqual(day.violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(day.failures, [], 'no cycle failed');
  assert.deepEqual(day.lost, [], 'no lease was lost');
  assert.deepEqual(day.final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'the five items are delivered');

  const parent = day.final[0], followUp = window.followUp!;
  const mergedAt = Date.parse(parent.delivery!.mergedAt), notBefore = mergedAt + windowDays * dayMs;
  // Filed without a window; the control plane derived the merge plus the criterion's three days, and no worker had to defer it.
  assert.deepEqual([followUp.observationWindow?.notBefore, followUp.observationWindow?.basis], [iso(notBefore), 'criterion-window']);
  assert.match(followUp.observationWindow!.detail, new RegExp(`^${parent.key} merged at ${iso(mergedAt)} and AC-2 names a ${windowDays}-day window, so the reading can first exist at ${iso(notBefore)}`));
  assert.deepEqual(window.deferred, [], 'no worker deferred it: none was dispatched before the instant');

  const before = window.samples.filter(sample => Date.parse(sample.at) < notBefore), after = window.samples.filter(sample => Date.parse(sample.at) >= notBefore);
  assert.ok(before.length >= 200, `the loop cycled across the held days: ${before.length} cycles`);
  for (const sample of before) {
    const label = `${sample.at} (+${Math.round(sample.elapsed / hour)} h)`;
    assert.equal(sample.waiting, true, `${label}: master status reports the window holding`);
    assert.equal(sample.sentence, `Waiting for its observation window — the reading it owes can first exist at ${iso(notBefore)}`, label);
    assert.deepEqual(sample.dispatches, [], `${label}: no dispatch was requested`);
    assert.deepEqual([sample.lease, sample.sessions, sample.faults, sample.escalations, sample.attention], [null, 0, [], [], null], `${label}: nobody holds it, no session, no fault, no escalation, no attention`);
  }
  for (const sample of window.samples) assert.deepEqual(sample.escalations, [], `${sample.at}: nothing escalated the follow-up`);
  assert.deepEqual(window.samples.filter(sample => sample.masterLive).map(sample => sample.at), [], 'no master session was live on any cycle of the day');

  // GY-1762: past the instant the reading is owed, not dispatchable: the follow-up is all manual post-deploy
  // proofs, so no code worker is ever launched, and it stays open until the loop's reading is recorded.
  const first = after[0]!;
  assert.ok(Date.parse(first.at) - notBefore <= 10 * minute, `the loop's first cycle past the instant ran within an idle step of it: ${first.at}`);
  for (const sample of after) {
    assert.deepEqual([sample.dispatches, sample.lease, sample.sessions, sample.stage], [[], null, 0, 'ready'], `${sample.at}: past its instant it is still undispatched, unleased and without a session`);
    assert.deepEqual(sample.faults, [], `${sample.at}: no fault names the follow-up`);
  }
  assert.equal(followUp.stage, 'ready', `the follow-up awaits the loop's reading: ${followUp.stage}`);
});

/**
 * GY-1732 under the real loop: the coordinator checkout is behind the serving release, and its own
 * filer predates observation windows (it files window-less, as 98070f3538 filed GY-1721..GY-1725). The
 * day files item 1's follow-up through master verify-deployment on every cycle, its criterion a live
 * window "over 24 hours". The serving release's own filer files it, with the instant the release was first
 * observed serving plus 24 hours; the loop dispatches nothing for it before then.
 */
test('integration:soak-stale-coordinator-no-early-dispatch — with the coordinator checkout behind the serving release, verify-deployment files the 24-hour follow-up with its window and the loop dispatches it only once its reading can exist', { timeout: 600_000 }, async () => {
  const windowHours = 24;
  const day = await simulateDay({ hours: windowHours + 5, plan, observationWindow: { item: 1, windowDays: 1, filedAfterMs, staleCoordinator: true, windowHours } });
  const window = day.observationWindowDay!, iso = (ms: number) => new Date(ms).toISOString();
  assert.deepEqual(day.violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(day.failures, [], 'no cycle failed');
  const parent = day.final[0], followUp = window.followUp!;
  assert.ok(window.filedAt !== null && window.releasedAt !== null, 'the follow-up was filed and released');
  assert.ok(window.staleFilings > 50 && window.staleFilings === window.filings, `every filing went through verify-deployment behind the release: ${window.staleFilings}`);
  assert.deepEqual(window.created, [followUp.key], 'one follow-up was created for the parent');
  // Filed by the release's own filer: first observed serving at the filing, plus 24 hours.
  const notBefore = window.filedAt! + windowHours * hour;
  assert.deepEqual([followUp.observationWindow?.notBefore, followUp.observationWindow?.basis], [iso(notBefore), 'criterion-window']);
  assert.match(followUp.observationWindow!.detail, new RegExp(`^${parent.key}'s serving release was first observed at ${iso(window.filedAt!)} and AC-2 names a 24-hour live window`));
  assert.match(followUp.description ?? '', /\n\nObservation window: the reading can first exist at /);
  const before = window.samples.filter(sample => Date.parse(sample.at) < notBefore), after = window.samples.filter(sample => Date.parse(sample.at) >= notBefore);
  assert.ok(before.length >= 100, `the loop cycled across the held window: ${before.length} cycles`);
  for (const sample of before) {
    assert.deepEqual(sample.dispatches, [], `${sample.at}: no dispatch before the reading can exist`);
    assert.deepEqual([sample.lease, sample.sessions, sample.waiting], [null, 0, true], `${sample.at}: held on its window`);
  }
  assert.ok(after.length > 0, 'the day ran past the instant');
  assert.deepEqual(after.flatMap(sample => sample.dispatches), [], 'GY-1762: past the instant the reading is owed to the loop, so no worker dispatch is ever requested');
  assert.equal(Math.max(...after.map(sample => sample.sessions)), 0, 'and no worker session is launched');
});

/**
 * GY-1740 under the real loop: three post-deploy follow-ups were each blocked by their first worker on a
 * reading that cannot exist before an instant 6, 14 and 22 hours into the day, as GY-1689, GY-1721 and
 * GY-1724 were. No worker can `defer` them (none holds a lease), so the loop's blocker step holds each
 * on its instant itself (`window`). Every cycle samples each one: held once, out of Blocked from the first
 * cycle with no worker launch, never dispatched or overdue before its instant, and past it left to the
 * loop's reading with no dispatch requested (GY-1762).
 */
test('unit:soak-invariants-hold — over a simulated day of the real loop, blocked unleased post-deploy follow-ups whose blockers name future instants are each held on their instant once, leave Blocked without a worker launch, stay undispatched and not overdue until it, request no dispatch past it while they await the loop\'s reading, and every system invariant holds', { timeout: 600_000 }, async () => {
  const hours = [6, 14, 22];
  const day = await simulateDay({ hours: 26, plan, blockedHolds: { hours } });
  const holds = day.blockedHoldDay!, iso = (ms: number) => new Date(ms).toISOString();
  assert.deepEqual(day.violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(day.failures, [], 'no cycle failed');
  assert.deepEqual(day.lost, [], 'no lease was lost');
  assert.equal(holds.seeded.length, hours.length);
  // Each is held exactly once, on the instant its blocker names, by the loop's first cycle.
  assert.deepEqual(holds.windows.map(entry => [entry.key, entry.notBefore]).sort(), holds.seeded.map(entry => [entry.key, iso(entry.notBefore)]).sort(), `each follow-up was held once: ${JSON.stringify(holds.windows)}`);
  assert.ok(holds.windows.every(entry => entry.at - day.dayStart < 2 * minute), 'on the loop\'s first cycle');
  for (const seeded of holds.seeded) {
    const samples = holds.samples.filter(sample => sample.key === seeded.key);
    const before = samples.filter(sample => Date.parse(sample.at) < seeded.notBefore), after = samples.filter(sample => Date.parse(sample.at) >= seeded.notBefore);
    assert.ok(before.length >= 30, `${seeded.key}: the loop cycled across its held hours: ${before.length} cycles`);
    // The seeded first attempt's own dispatch, requested before the loop's first cycle; every later one is new.
    // GY-1762: the loop requests no further dispatch; at most the seeded first attempt's own is on record.
    const seededDispatches = before[0]!.dispatches;
    assert.ok(seededDispatches.length <= 1, `${seeded.key}: only its seeded first attempt was ever dispatched`);
    const later = (sample: (typeof samples)[number]) => sample.dispatches.slice(seededDispatches.length);
    for (const sample of before) {
      const label = `${seeded.key} at ${sample.at}`;
      assert.deepEqual([sample.blocker, sample.window, sample.stage], [null, iso(seeded.notBefore), 'ready'], `${label}: its blocker is gone and its window holds it`);
      assert.notEqual(sample.group, 'blocked', `${label}: not in the Blocked group`);
      assert.equal(sample.overdue, false, `${label}: not overdue`);
      assert.deepEqual([sample.lease, sample.sessions, later(sample), sample.faults, sample.escalations], [null, 0, [], [], []], `${label}: no lease, no worker launch, no dispatch, no fault, no escalation`);
    }
    assert.ok(after.length > 0, `${seeded.key}: the day ran past its instant`);
    // GY-1762: past its instant the reading is owed to the loop; no worker is dispatched or launched, and no fault is raised.
    assert.deepEqual(after.flatMap(later), [], `${seeded.key}: no dispatch is requested past its instant`);
    assert.equal(Math.max(...after.map(sample => sample.sessions)), 0, `${seeded.key}: no worker session is launched for it`);
    for (const sample of after) assert.deepEqual([sample.faults, sample.blocker, sample.stage], [[], null, 'ready'], `${sample.key} at ${sample.at}: no fault, still released and awaiting the reading`);
    assert.equal(holds.final.find(item => item.key === seeded.key)!.stage, 'ready', `${seeded.key} awaits the loop's reading`);
  }
});
