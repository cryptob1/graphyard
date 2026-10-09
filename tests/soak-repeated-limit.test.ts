import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDaemonState } from '../src/master-daemon.js';
import { observedExhaustions, repeatedLimitAccount } from '../src/master.js';
import type { Principal, Work } from '../src/model.js';
import type { InvariantCheck } from '../src/model/invariants.js';
import { clock, hour, minute } from './helpers/soak-world.js';
import { api, engine, id, principals, soakControlPlanes, store, token, url } from './helpers/soak-plane.js';
import { limitHost, limitLoop, type LimitPlane } from './helpers/limit-loop.js';

/**
 * Repeated limit endings across a day (GY-1582): the real loop, dispatching through the production
 * `dispatchWork` and account choice, on a host whose preferred Claude account claude-b is spent for
 * the day's first three hours and whose other account, claude-c, logs in only after two and a half hours. Each
 * session launched on claude-b in that window stops on Claude's limit menu ten minutes in, naming no
 * reset, and the loop fails it over. The hold each notice places lapses on the assumed hour while
 * claude-b is still spent, so a selection that only read the holds would hand claude-b back to the
 * same item a third time; the dispatch holds it again instead, and the attempt goes to claude-c.
 * Every system invariant holds after every cycle, every hold is bounded, and claude-b takes a new
 * item's launch again once its spent window and the repeat's hold have passed. The day ends inside
 * the loop's 120-minute reclaim bound of the attempts on claude-c, which stand for the work itself.
 * A second day pins the run: notices of launches with one between them that ended another way are
 * no repeat, so claude-b is chosen again rather than held.
 */
soakControlPlanes('soak-repeated-limit', 427);

test('unit:soak-invariants-hold — two items whose launches on claude-b each end on its limit notice twice are routed to claude-c by the real dispatch on their third launch, never onto claude-b a third time, every hold stays bounded and lapses, claude-b takes a later item again, and every invariant holds after every cycle', { timeout: 300_000 }, async () => {
  const dayStart = clock.now(), spentUntil = dayStart + 3 * hour, loginAt = dayStart + 2 * hour + 30 * minute, newItemAt = dayStart + 3 * hour + 30 * minute, dayEnd = dayStart + 3 * hour + 55 * minute;
  const worker = (principal: string): Principal => ({ id: principal, role: 'worker' });
  const plane: LimitPlane = { url, coordinatorToken: token(principals.coordinator), api: (as, method, path, body) => api(as === 'coordinator' ? principals.coordinator : worker(as), method, path, body) };
  const profiles = ['one', 'two', 'three'].map(name => ({ name, principal: `worker-${name}`, token: token(worker(`worker-${name}`)), accounts: ['claude-b', 'claude-c'] }));
  const host = await limitHost(plane, profiles, { 'claude-b': 'subscription-b', 'claude-c': 'subscription-c' }, ['claude-c']);
  const { launches, refused, stopped, spend, cycle } = limitLoop(plane, host);
  const state = emptyDaemonState(host.config);
  const item = async (title: string) => {
    const work = await api(principals.operator, 'POST', 'work', { title, plannedFiles: [`src/${id().slice(0, 8)}.ts`], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:wait'] }] }) as Work;
    return api(principals.operator, 'POST', `work/${work.id}/ready`, {}) as Promise<Work>;
  };
  const spentItems = [await item('repeated limit one'), await item('repeated limit two')];
  let later: Work | null = null, loggedIn = false;
  const violations: string[] = [], observed = new Set<string>(), holds: { at: number; account: string; until: number; reason: string }[] = [], spends: { key: string; epoch: number; at: number }[] = [];

  for (let now = clock.now(); now < dayEnd; now = clock.now()) {
    if (!loggedIn && now >= loginAt) { await host.login('claude-c'); loggedIn = true; }
    if (!later && now >= newItemAt) later = await item('after the spent window');
    // Every live session renews its lease; one on claude-b inside the spent window draws the limit menu ten minutes in.
    for (const launch of launches.filter(entry => !stopped.includes(`${entry.key}:${entry.epoch}`))) {
      const work = (await store.list()).find(entry => entry.key === launch.key)!;
      if (work.lease?.epoch === launch.epoch) await engine.execute(worker(`worker-${launch.profile}`), 'heartbeat', work.id, { epoch: launch.epoch }, id());
      if (launch.account === 'claude-b' && launch.at < spentUntil && now - launch.at >= 10 * minute && !spends.some(entry => entry.key === launch.key && entry.epoch === launch.epoch)) {
        spend(launch, null);
        spends.push({ key: launch.key, epoch: launch.epoch, at: now });
      }
    }
    await cycle(state);
    for (const check of state.invariants.report as InvariantCheck[]) {
      if (check.observed) observed.add(check.invariant);
      if (!check.holds) violations.push(`+${Math.round((now - dayStart) / minute)} min ${check.line}`);
    }
    { const read = Date.now(); for (const [account, held] of Object.entries(await observedExhaustions(host.config, read))) holds.push({ at: read, account, until: Date.parse(held.until), reason: held.reason }); }
    clock.advance(minute); await store.pool.query('UPDATE simulated_clock SET offset_ms=$1', [clock.offsetMs]);
  }

  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.ok(observed.size > 0, 'the loop evaluated its invariants');
  assert.deepEqual(refused.filter(entry => !/no (healthy|eligible|usable)|exhausted|not logged in|could not|held/i.test(entry.error)), [], 'a refused dispatch is only one with no account to launch on');
  assert.ok(!refused.some(entry => /hold that keeps the next launch off it could not be placed/.test(entry.error)), 'every hold the dispatch needed was placed');

  const final = await store.list();
  for (const spent of spentItems) {
    const own = launches.filter(entry => entry.key === spent.key);
    assert.deepEqual(own.map(entry => [entry.epoch, entry.account]), [[1, 'claude-b'], [2, 'claude-b'], [3, 'claude-c']], `${spent.key} ended twice on claude-b, then the real dispatch routed it to claude-c: ${JSON.stringify(refused.filter(entry => entry.key === spent.key))}`);
    const work = final.find(entry => entry.id === spent.id)!;
    assert.deepEqual(work.capacity!.exhaustions.map(entry => [entry.epoch, entry.account]), [[1, 'claude-b'], [2, 'claude-b']], 'each limit ending charged to claude-b, the account the attempt launched on');
    assert.equal(work.lease?.epoch, 3, `${spent.key} is still worked on claude-c`);
  }
  assert.equal(spends.length, 4, 'four limit endings: two per item, never a third');
  assert.equal(stopped.length, 4, 'each ending stopped its attempt once');

  // Every hold is bounded: on claude-b only, never more than an hour past the instant it is read, and none stands at the day's end.
  assert.ok(holds.length > 0);
  assert.deepEqual([...new Set(holds.map(entry => entry.account))], ['claude-b'], 'only the spent account is ever held');
  assert.deepEqual(holds.filter(entry => entry.until - entry.at > hour), [], 'no hold reaches more than an hour ahead');
  const lastHeld = Math.max(...holds.map(entry => entry.at));
  assert.ok(lastHeld < newItemAt, `the last hold lapses before the later item arrives (+${Math.round((lastHeld - dayStart) / minute)} min)`);
  // The third launches were kept off claude-b by the repeat's hold, not by a notice's own: theirs had lapsed.
  // (one item's dispatch places the hold; the other finds it standing).
  assert.ok(holds.some(entry => spentItems.some(spent => entry.reason.startsWith(`${spent.key}'s last 2 worker launches (epochs 1, 2) each ended on claude-b's limit notice`))), 'a repeat held claude-b');
  assert.deepEqual(await observedExhaustions(host.config), {}, 'no hold stands at the day\'s end');
  for (const spent of spentItems) assert.equal(repeatedLimitAccount(final.find(entry => entry.id === spent.id)!), null, 'the repeat has aged out of its window');

  // claude-b is not lost for good: the later item launches on it at once, and works.
  assert.ok(later);
  assert.deepEqual(launches.filter(entry => entry.key === later!.key).map(entry => [entry.epoch, entry.account]), [[1, 'claude-b']], 'the later item launches on claude-b once its window has passed');
  assert.equal(launches.length, 7, `seven launches across the day: ${launches.map(entry => `${entry.key}:${entry.epoch}@${entry.account}`).join(', ')}`);
});

test('unit:soak-invariants-hold — an item whose launches on claude-b end on its limit notice at epochs 1 and 3, with epoch 2 between them ended another way, is launched on claude-b again by the real dispatch: no repeat is held, and every invariant holds after every cycle', { timeout: 300_000 }, async () => {
  // claude-c logs in only after the fourth launch is due, so a repeat wrongly held would leave the item no account at all.
  const dayStart = clock.now(), spentUntil = dayStart + 2 * hour, loginAt = dayStart + 2 * hour + 50 * minute, dayEnd = dayStart + 3 * hour;
  const worker = (principal: string): Principal => ({ id: principal, role: 'worker' });
  const plane: LimitPlane = { url, coordinatorToken: token(principals.coordinator), api: (as, method, path, body) => api(as === 'coordinator' ? principals.coordinator : worker(as), method, path, body) };
  const host = await limitHost(plane, [{ name: 'one', principal: 'worker-one', token: token(worker('worker-one')), accounts: ['claude-b', 'claude-c'] }], { 'claude-b': 'subscription-b', 'claude-c': 'subscription-c' }, ['claude-c']);
  const { launches, refused, stopped, spend, end, cycle } = limitLoop(plane, host);
  let loggedIn = false;
  const state = emptyDaemonState(host.config);
  const created = await api(principals.operator, 'POST', 'work', { title: 'limit notices with a gap', plannedFiles: [`src/${id().slice(0, 8)}.ts`], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:wait'] }] }) as Work;
  const gap = await api(principals.operator, 'POST', `work/${created.id}/ready`, {}) as Work;
  const violations: string[] = [], holds: { at: number; account: string; until: number; reason: string }[] = [], spends: string[] = [];

  for (let now = clock.now(); now < dayEnd; now = clock.now()) {
    if (!loggedIn && now >= loginAt) { await host.login('claude-c'); loggedIn = true; }
    for (const launch of launches.filter(entry => !stopped.includes(`${entry.key}:${entry.epoch}`))) {
      const work = (await store.list()).find(entry => entry.key === launch.key)!;
      if (work.lease?.epoch === launch.epoch) await engine.execute(worker(`worker-${launch.profile}`), 'heartbeat', work.id, { epoch: launch.epoch }, id());
      if (launch.account !== 'claude-b' || launch.at >= spentUntil || now - launch.at < 10 * minute || spends.includes(`${launch.epoch}`)) continue;
      spends.push(`${launch.epoch}`);
      // Epoch 2 ends another way: its supervisor settles, the item is released, and no notice is read.
      if (launch.epoch === 2) await end(launch); else spend(launch, null);
    }
    await cycle(state);
    for (const check of state.invariants.report as InvariantCheck[]) if (!check.holds) violations.push(`+${Math.round((now - dayStart) / minute)} min ${check.line}`);
    { const read = Date.now(); for (const [account, held] of Object.entries(await observedExhaustions(host.config, read))) holds.push({ at: read, account, until: Date.parse(held.until), reason: held.reason }); }
    clock.advance(minute); await store.pool.query('UPDATE simulated_clock SET offset_ms=$1', [clock.offsetMs]);
  }

  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(refused.filter(entry => !/no (healthy|eligible|usable)|exhausted|not logged in|could not|held/i.test(entry.error)), [], 'a refused dispatch is only one with no account to launch on');
  assert.deepEqual(launches.map(entry => [entry.epoch, entry.account]), [[1, 'claude-b'], [2, 'claude-b'], [3, 'claude-b'], [4, 'claude-b']], `epochs 1 and 3 are no repeat, so the fourth launch is on claude-b again: ${launches.map(entry => `${entry.key}:${entry.epoch}@${entry.account}`).join(', ')}`);
  const work = (await store.list()).find(entry => entry.id === gap.id)!;
  assert.deepEqual(work.capacity!.exhaustions.map(entry => [entry.epoch, entry.account]), [[1, 'claude-b'], [3, 'claude-b']]);
  assert.equal(work.lease?.epoch, 4, 'the fourth attempt is still worked on claude-b');
  assert.deepEqual(holds.filter(entry => /worker launches \(epochs/.test(entry.reason)), [], 'no repeat hold was ever placed');
  assert.deepEqual(holds.filter(entry => entry.until - entry.at > hour), [], 'no hold reaches more than an hour ahead');
  assert.deepEqual(await observedExhaustions(host.config), {}, 'no hold stands at the day\'s end');
});
