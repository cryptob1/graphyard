import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { observedExhaustions, providerIdentity, recordObservedExhaustion } from '../src/master/environments.js';
import { accountIneligibility, foldObservations } from '../src/model/registry.js';
import { doctorEffects } from '../src/daemon/doctor.js';
import { HOST, claudeHomes, controlPlane, heldAccountLoop, loopConfig, registryOf } from './helpers/held-account-loop.js';
import { clock, hour, minute } from './helpers/soak-world.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1574. A held account's report to the agent registry over three simulated days of the real loop:
 * a cycle every ten minutes, each one's snapshot the one `daemonEffects` builds, so the pending-hold
 * report runs where production runs it. claude-a is spent while the control plane cannot take the
 * report; claude, on the same provider login, is its twin. The report is resent every cycle while it
 * fails and delivered exactly once when the plane answers, and the hold leaves at its reset. A second
 * hold the plane never takes is resent until its reset and never after. The doctor selects through
 * the same plane every six hours: while claude-a is held it lands on the healthy login and the hold
 * survives; once it resets the twin is free again. Every system invariant the loop checks holds after
 * every cycle.
 */
const start = Date.parse('2026-10-09T05:30:00Z'), reset = start + 47 * hour + 30 * minute, resetsAt = new Date(reset).toISOString();
const outage = { from: 0, to: 2 * hour }, lapsing = { at: 32 * hour, resetsIn: hour };
const spent = { at: new Date(start).toISOString(), resetsAt, reason: 'You\'ve hit your weekly limit · resets Oct 10, 10pm (America/Los_Angeles)', role: 'worker' as const, profile: 'builder', work: 'GY-1571' };
const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

test('unit:soak-held-account-report — over three simulated days of the real loop a hold the registry missed is resent each cycle, delivered once, and dropped at its reset; a hold never delivered stops at its reset; role selection skips the held twin until then; and every system invariant holds', { timeout: 300_000 }, async () => {
  const root = await temporaryDirectory('soak-held-account'); directories.push(root);
  const homes = await claudeHomes(root, start + 7 * 24 * hour);
  const config = await loopConfig(root), login = (await providerIdentity('claude', homes['claude-a']))!;
  const registry = { current: registryOf([...(['claude-a', 'claude', 'claude-c'] as const).map(name => ({ name, home: homes[name] })), { name: 'claude-o', home: '/home/operator/.coding_agents/claude-o', host: 'otherhost' }], [{ name: 'doctor', accounts: ['claude', 'claude-c'] }], new Date(start - hour).toISOString()) };
  const probe = (account: string) => ({ account, quota: { loggedIn: true, state: 'unknown' as const, usage: [], resetsAt: null, reason: null, identity: login } });
  foldObservations(registry.current, { host: HOST, observations: [probe('claude-a'), probe('claude')] }, { actor: 'executor', at: new Date(start - hour).toISOString() });
  // Where this host's sessions ran: a hold reads the login it was spent on from its home.
  const configured = { ...config, environments: (['claude-a', 'claude', 'claude-c'] as const).map(name => ({ name, kind: 'claude' as const, home: homes[name] })) };
  // claude-o, on another host, shares the login: only the registry hearing of the hold can hold it there.
  foldObservations(registry.current, { host: 'otherhost', observations: [probe('claude-o')] }, { actor: 'executor', at: new Date(start - hour).toISOString() });
  const plane = controlPlane(registry), loop = heldAccountLoop(config, root, plane.fetcher);
  const sent = (name: string) => plane.observes.filter(observe => observe.accounts.includes(name));
  const original = globalThis.fetch;
  globalThis.fetch = plane.fetcher;
  clock.install(start);
  const violations: string[] = [], failures: string[] = [], selections: { at: number; account: string; skipped: string | null }[] = [];
  try {
    plane.mode = 'down';
    await recordObservedExhaustion(configured, 'claude-a', spent, Date.now(), { fetch: plane.fetcher });
    assert.equal((await observedExhaustions(config))['claude-a'].reported, false, 'the immediate report and its retry both failed');
    let lapsingSent = -1;
    for (let elapsed = 10 * minute; elapsed <= 3 * 24 * hour; elapsed += 10 * minute) {
      clock.advance(10 * minute);
      const now = start + elapsed, before = sent('claude-a').length, beforeLapsing = sent('claude-c').length;
      plane.mode = elapsed < outage.to || (elapsed >= lapsing.at && elapsed <= lapsing.at + lapsing.resetsIn + hour) ? 'down' : 'up';
      if (elapsed === lapsing.at) await recordObservedExhaustion(configured, 'claude-c', { ...spent, at: new Date(now).toISOString(), resetsAt: new Date(now + lapsing.resetsIn).toISOString() }, now, { fetch: plane.fetcher });
      await loop.cycle().catch(error => failures.push(`+${elapsed / minute} min: ${error.message}`));
      for (const check of loop.state.invariants.report) if (!check.holds) violations.push(`+${elapsed / minute} min: ${check.invariant} — ${check.reading}`);

      const held = await observedExhaustions(config), hold = held['claude-a'];
      const sends = sent('claude-a').length - before;
      if (elapsed < outage.to) {
        assert.equal(sends, 1, `+${elapsed / minute} min: the pending hold is resent once a cycle while the plane is down`);
        assert.equal(hold.reported, false);
        assert.notEqual(registry.current.accounts.find(entry => entry.name === 'claude-a')!.quota.state, 'exhausted', 'the registry has not heard of it');
        // Until a role's selection here reports the twin spent, only the report could hold the twin on another host.
        if (elapsed < hour) assert.equal(accountIneligibility(registry.current, registry.current.accounts.find(entry => entry.name === 'claude-o')!, now, 'otherhost'), null, 'so the twin on another host is not held yet');
      } else if (now < reset) {
        assert.equal(hold.reported, true, `+${elapsed / minute} min: delivered`);
        assert.equal(sends, elapsed === outage.to ? 1 : 0, `+${elapsed / minute} min: delivered on the first cycle the plane answers, and never sent again`);
        assert.match(accountIneligibility(registry.current, registry.current.accounts.find(entry => entry.name === 'claude-o')!, now, 'otherhost') ?? '', /same provider login as claude-a/, 'the twin on another host is held fleet-wide');
      } else {
        assert.equal(hold, undefined, `+${elapsed / minute} min: the hold left at its reset`);
        assert.equal(sends, 0);
      }
      // The hold the plane never takes is resent every cycle until its reset, and never after.
      const lapsingSends = sent('claude-c').length - beforeLapsing;
      if (elapsed > lapsing.at && elapsed < lapsing.at + lapsing.resetsIn) assert.equal(lapsingSends, 1, `+${elapsed / minute} min: the undelivered hold is resent`);
      if (elapsed >= lapsing.at + lapsing.resetsIn) {
        assert.equal(lapsingSends, 0, `+${elapsed / minute} min: nothing past its reset is reported`);
        assert.equal(held['claude-c'], undefined);
        if (lapsingSent < 0) lapsingSent = sent('claude-c').length;
      }

      // The doctor selects through the same plane every six hours.
      if (elapsed % (6 * hour) === hour) {
        await doctorEffects(config, root, async () => ({})).runner('primary');
        const session = registry.current.sessions.filter(entry => entry.role === 'doctor').at(-1)!;
        selections.push({ at: elapsed, account: session.account, skipped: session.skipped.find(skip => skip.account === 'claude')?.reason ?? null });
        if (now < reset) {
          assert.equal(session.account, 'claude-c', `+${elapsed / minute} min: the doctor lands on the healthy login`);
          assert.match(session.skipped.find(skip => skip.account === 'claude')!.reason, /same provider login as claude-a/);
          assert.ok((await observedExhaustions(config))['claude-a'], 'the hold survives the selection');
          assert.equal(registry.current.accounts.find(entry => entry.name === 'claude-a')!.quota.state, elapsed < outage.to ? 'unknown' : 'exhausted', 'and the selection clears no mark');
        } else assert.equal(session.account, 'claude', `+${elapsed / minute} min: past the reset the twin is free again`);
      }
    }
    assert.deepEqual(failures, [], 'no cycle failed');
    assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
    assert.equal(sent('claude-a').filter(observe => observe.delivered).length, 1, 'the hold was delivered exactly once');
    assert.equal(sent('claude-a').length, 2 + outage.to / (10 * minute), 'the immediate report, its retry, and one resend a cycle until delivered');
    assert.equal(sent('claude-c').filter(observe => observe.delivered).length, 0, 'the second hold never reached the registry');
    assert.equal(sent('claude-c').length, lapsingSent, 'and was not sent once its reset passed');
    assert.ok(selections.length >= 12, `the doctor selected through the whole run: ${selections.length}`);
    assert.ok(loop.state.invariants.report.length > 0, 'the loop checked its invariants');
  } finally { clock.uninstall(); globalThis.fetch = original; }
});

/**
 * GY-1574. A legacy configured claude-a runs in claude-c's home, on claude-c's login, while the
 * registry's claude-a logs in from its own home on another login. Its hold is never reported as the
 * registry's claude-a; the spent login reaches the registry through claude-c, the account here the
 * registry knows on it. Until claude-c's login has been probed the hold stays pending, resent each
 * cycle, and claude-o on another host on that login is still eligible; the first cycle after the probe
 * delivers it once, claude-o is held fleet-wide until the reset and free after, and registry claude-a
 * is never marked.
 */
test('unit:soak-held-login-of-legacy-environment — over two simulated days of the real loop a legacy environment\'s hold reaches the registry through the accounts on its spent login, never by its shared name', { timeout: 300_000 }, async () => {
  const root = await temporaryDirectory('soak-held-legacy'); directories.push(root);
  const legacyStart = Date.parse('2026-10-09T05:30:00Z'), legacyReset = legacyStart + 36 * hour, probedAt = 2 * hour;
  const homes = await claudeHomes(root, legacyStart + 7 * 24 * hour);
  const config = await loopConfig(root), spentLogin = (await providerIdentity('claude', homes['claude-c']))!, ownLogin = (await providerIdentity('claude', homes['claude-a']))!;
  const registry = { current: registryOf([{ name: 'claude-a', home: homes['claude-a'] }, { name: 'claude-c', home: homes['claude-c'] }, { name: 'claude-o', home: '/home/operator/.coding_agents/claude-o', host: 'otherhost' }], [{ name: 'doctor', accounts: ['claude-c'] }], new Date(legacyStart - hour).toISOString()) };
  const probe = (account: string, identity: string) => ({ account, quota: { loggedIn: true, state: 'unknown' as const, usage: [], resetsAt: null, reason: null, identity } });
  foldObservations(registry.current, { host: HOST, observations: [probe('claude-a', ownLogin)] }, { actor: 'executor', at: new Date(legacyStart - hour).toISOString() });
  foldObservations(registry.current, { host: 'otherhost', observations: [probe('claude-o', spentLogin)] }, { actor: 'executor', at: new Date(legacyStart - hour).toISOString() });
  const legacy = { ...config, environments: [{ name: 'claude-a', kind: 'claude' as const, home: homes['claude-c'] }] };
  const plane = controlPlane(registry), loop = heldAccountLoop(config, root, plane.fetcher);
  const named = (name: string) => plane.observes.filter(observe => observe.accounts.includes(name));
  const elsewhere = (now: number) => accountIneligibility(registry.current, registry.current.accounts.find(entry => entry.name === 'claude-o')!, now, 'otherhost');
  const original = globalThis.fetch;
  globalThis.fetch = plane.fetcher;
  clock.install(legacyStart);
  const violations: string[] = [], failures: string[] = [];
  try {
    await recordObservedExhaustion(legacy, 'claude-a', { ...spent, resetsAt: new Date(legacyReset).toISOString() }, Date.now(), { fetch: plane.fetcher });
    assert.equal((await observedExhaustions(config))['claude-a'].reported, false, 'no account here is known on the spent login yet');
    for (let elapsed = 10 * minute; elapsed <= 2 * 24 * hour; elapsed += 10 * minute) {
      clock.advance(10 * minute);
      const now = legacyStart + elapsed, before = named('claude-c').length;
      if (elapsed === probedAt) foldObservations(registry.current, { host: HOST, observations: [probe('claude-c', spentLogin)] }, { actor: 'executor', at: new Date(now).toISOString() });
      await loop.cycle().catch(error => failures.push(`+${elapsed / minute} min: ${error.message}`));
      for (const check of loop.state.invariants.report) if (!check.holds) violations.push(`+${elapsed / minute} min: ${check.invariant} — ${check.reading}`);
      const hold = (await observedExhaustions(config))['claude-a'], deliveries = named('claude-c').length - before;
      assert.equal(named('claude-a').length, 0, `+${elapsed / minute} min: nothing is ever reported as registry claude-a`);
      assert.notEqual(registry.current.accounts.find(entry => entry.name === 'claude-a')!.quota.state, 'exhausted');
      if (elapsed < probedAt) {
        assert.equal(hold.reported, false, `+${elapsed / minute} min: pending while no account here is known on the login`);
        assert.equal(elsewhere(now), null, `+${elapsed / minute} min: so the other host's twin is still eligible`);
      } else if (now < legacyReset) {
        assert.equal(hold.reported, true, `+${elapsed / minute} min: delivered`);
        assert.equal(deliveries, elapsed === probedAt ? 1 : 0, `+${elapsed / minute} min: delivered on the first cycle after the probe, and never again`);
        assert.match(elsewhere(now) ?? '', /same provider login as claude-c/, `+${elapsed / minute} min: the other host's twin is held`);
      } else {
        assert.equal(hold, undefined, `+${elapsed / minute} min: the hold left at its reset`);
        assert.equal(elsewhere(now), null, `+${elapsed / minute} min: and the other host's twin is free again`);
      }
    }
    assert.deepEqual(failures, [], 'no cycle failed');
    assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
    assert.equal(named('claude-c').length, 1, 'the spent login was delivered exactly once');
    assert.ok(loop.state.invariants.report.length > 0, 'the loop checked its invariants');
  } finally { clock.uninstall(); globalThis.fetch = original; }
});
