import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minute } from './helpers/soak-world.js';
import { soakControlPlanes } from './helpers/soak-plane.js';
import { simulateDay } from './helpers/soak-simulation.js';

/**
 * Session coordinates across a control-plane outage (GY-1895), over the real loop's cycles. One
 * concern of the release-candidate soak (GY-404), split per concern (GY-1363). The 2026-10-17
 * registry outage (08:53–10:25Z) kept the plane from answering the session-coordinate writes that
 * carry a pane — a launch's own coordinate, a record move, a re-prompt's handle record — for every
 * item and epoch the window covered. Let go, each pane-less handle refused every later paste, the
 * refusals counted as four session-liveness instances, and the GY-953 bound reclaimed attempts with
 * their applied scope decisions undelivered. Here the plane refuses exactly those writes, Railway's
 * 502, for an hour across several items' launches and epochs, then answers: every retried write
 * carries the pane its own launch returned, the retries stay bounded and converge, each cleared
 * wait is delivered once, no pane is closed or pasted that a launch did not return, and every
 * system invariant holds after every cycle.
 */
soakControlPlanes('soak-coordinate-outage', 420);

test('unit:soak-invariants-hold — an outage that refuses every pane-carrying coordinate write across items and epochs leaves the launch-bound retries bounded and convergent, delivers each cleared wait once, reopens no session, and never faults the sessions it touched', { timeout: 600_000 }, async () => {
  const from = 20 * minute, to = 80 * minute, window = to - from;
  const day = await simulateDay({ hours: 5, coordinateOutage: { from, to } });
  const { violations, failures, state, final, coordinateOutageDay, panes, prompts, sessions, exitedLive, closedLeased, cycles } = day;
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.ok(cycles >= window / minute, 'the loop cycled through the whole window');

  // The window caught real traffic: more than one item, launches whose epochs differ, and the
  // launches it caught are the day's own, each holding the pane its runtime returned.
  const refused = coordinateOutageDay.refused, landed = coordinateOutageDay.landed;
  assert.ok(refused.length >= 3, `the outage refused the pane-carrying coordinate writes it covered: ${refused.length}`);
  const refusedItems = new Set(refused.map(entry => entry.key));
  assert.ok(refusedItems.size >= 2, `the outage covered more than one item's coordinates: ${[...refusedItems].join(', ')}`);
  const refusedEpochs = new Set(refused.map(entry => entry.id));
  assert.ok(refusedEpochs.size >= refusedItems.size, `the covered writes span the attempts the window caught: ${[...refusedEpochs].join(', ')}`);
  for (const write of [...refused, ...landed]) {
    const session = sessions.find(entry => entry.pane === write.pane);
    assert.ok(session && `${session.profile.principal}:${session.epoch}` === write.id,
      `every pane a coordinate write carried is the one its own launch returned: ${JSON.stringify(write)}`);
  }

  // Bounded and convergent: a refused write is retried at the start of each step that bounds the
  // call — a few sends per cycle, the same cadence every carried call has — and by the day's end
  // every ledger row has retired: nothing stays owed.
  const intervalMs = 60_000;
  const boundPerHandle = 4 * (window / intervalMs + 1) + 1;
  const perHandle = new Map<string, number>();
  for (const write of refused) perHandle.set(write.id, (perHandle.get(write.id) ?? 0) + 1);
  for (const [id, count] of perHandle) assert.ok(count <= boundPerHandle, `the retries for ${id} stay bounded: ${count} refused sends over the window`);
  const owedRows = Object.entries(state.actions).filter(([key, row]) => key.startsWith('owed:') && row.state === 'waiting');
  assert.deepEqual(owedRows.map(([key]) => key), [], 'every owed coordinate write retired once the plane answered: none stays owed at the day\'s end');
  // And the record carries what the instances' handles lacked: every pane a launch returned stands
  // on that attempt's own handle, landed by the retry that carried it.
  for (const session of sessions) {
    const recorded = panes.get(`${session.work}:${session.profile.principal}:${session.epoch}`);
    assert.equal(recorded, session.pane, `${session.key} epoch ${session.epoch}'s own handle records the pane its launch returned`);
  }

  // The sessions the outage touched were never faulted for it: the failed pastes its pane-less
  // handles owed count no action:session instance, no attempt is reclaimed for a coordinate write
  // that is still owed (its live session would read finished while it works), and the window's
  // instances are at most the ordinary submit-gap readings every attempt's end raises.
  const windowFaults = state.faults.instances.filter(instance => instance.faultClass === 'session-liveness'
    && Date.parse(instance.at) - day.dayStart >= from - minute && Date.parse(instance.at) - day.dayStart < to + minute);
  for (const instance of windowFaults)
    assert.match(instance.text, /is not seen since/, `the outage window opened no instance of its own: ${JSON.stringify([instance.kind, instance.subject, instance.text.slice(0, 120)])}`);
  const actionSession = state.faults.instances.filter(instance => instance.kind === 'action:session');
  assert.deepEqual(actionSession.map(entry => [entry.subject, entry.at]), [], 'no failed paste of the day counts an action:session instance');
  // Nor is any attempt the window covered reclaimed for its coordinates — while the write stands
  // owed, or on the recovery cycle whose snapshot predates its landing.
  const coordinateReclaims = Object.entries(state.actions).filter(([key, row]) => key.startsWith('resume:reclaim:') && /coordinate write has not completed|has not been on the record since/.test(row.detail));
  assert.deepEqual(coordinateReclaims.map(([key]) => key), [], 'no attempt was reclaimed for a coordinate write the outage held');

  // Each cleared wait is delivered once: no key and epoch ever sees a second resume delivery.
  const deliveries = new Map<string, number>();
  for (const paste of prompts) {
    if (!/is telling it, once, that what it waited on is resolved/.test(paste.text)) continue;
    const key = `${paste.key}:${paste.epoch}`;
    deliveries.set(key, (deliveries.get(key) ?? 0) + 1);
  }
  for (const [key, count] of deliveries) assert.ok(count === 1, `${key}'s cleared wait was delivered once: ${count}`);
  assert.ok(deliveries.size >= 1, `the day delivered its scope decisions: ${JSON.stringify([...deliveries.keys()])}`);

  // No session the loop closed was still an agent, and no pane under a live lease was closed: the
  // outage recovery neither orphans nor reopens a session.
  assert.deepEqual(exitedLive, [], 'no finished handle names an agent that is still live');
  assert.deepEqual(closedLeased, [], 'no pane was closed under a live lease');
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'every item is delivered');
});
