import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import * as environments from '../src/master/environments.js';
import { heldTwin, observedExhaustions, providerIdentity, recordObservedExhaustion, reportPendingExhaustions, selectAccount, type ObservedExhaustion } from '../src/master/environments.js';
import { accountIneligibility, applyRegistryMutation, chooseSession, emptyRegistry, foldObservations, proposedRuntimes, type AgentRegistry, type FleetSession, type QuotaObservation } from '../src/model/registry.js';
import { plannerEffects } from '../src/daemon/planner.js';
import { acceptanceEffects } from '../src/daemon/acceptance.js';
import { doctorEffects } from '../src/daemon/doctor.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { claudeHomes as loopHomes, controlPlane, heldAccountLoop, loopConfig, registryOf as loopRegistryOf } from './helpers/held-account-loop.js';
import { clock, minute } from './helpers/soak-world.js';

/**
 * GY-1574: follow-ups from GY-1573's shared-identity holds. An operator quota mark naming identity
 * null clears the account's login; a legacy configured environment named like a registry account is
 * judged by its own home; a hold the registry missed is retried at once and every cycle until it
 * lands, a pre-upgrade hold is resent with its login kept on it first, a reset already past holds
 * nothing beyond the fallback hour, and every narrow role's selection reports what this host holds.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const HOST = 'vishrog';
const spentAt = Date.parse('2026-10-09T05:30:28Z'), now = spentAt + 60_000;
const resetsAt = new Date(Date.UTC(2026, 9, 11, 5)).toISOString();
const notice = `You've hit your weekly limit · resets Oct 10, 10pm (America/Los_Angeles)`;
const shared = 'claude:' + 'a'.repeat(32);
const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });
const token = `${'t'.repeat(40)}\n`;
const scratch = async (name: string) => { const directory = await temporaryDirectory(name); directories.push(directory); return directory; };
const spent = { at: new Date(spentAt).toISOString(), resetsAt, reason: notice, role: 'worker' as const, profile: 'builder', work: 'GY-1571' };
type ObserveRequest = { host: string; observations: { account: string; quota: QuotaObservation }[] };

function registryOf(accounts: { name: string; home?: string; host?: string }[], roles: { name: string; accounts: string[] }[] = [{ name: 'worker', accounts: accounts.map(account => account.name) }]): AgentRegistry {
  return applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [proposedRuntimes.find(runtime => runtime.name === 'claude')!], models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: accounts.map(account => ({ name: account.name, runtime: 'claude', model: 'opus', credential: { host: account.host ?? HOST, home: account.home ?? `/home/operator/.coding_agents/${account.name}` } })),
    roles: roles.map(role => ({ ...role, concurrency: 4 })), reason: 'fixture',
  }, { actor: 'operator', at: new Date(spentAt - 3_600_000).toISOString() }).registry;
}
const probed = (registry: AgentRegistry, host: string, observations: { account: string; identity: string | null }[]) =>
  foldObservations(registry, { host, observations: observations.map(({ account, identity }) => ({ account, quota: { loggedIn: true, state: 'unknown', usage: [], resetsAt: null, reason: null, identity } })) }, { actor: 'executor', at: new Date(spentAt).toISOString() });
const account = (registry: AgentRegistry, name: string) => registry.accounts.find(entry => entry.name === name)!;
/** A registry with `claude` on another host on the same login as `claude-a` here: it is held only once the registry hears of claude-a's hold. */
function twinElsewhere() {
  const registry = registryOf([{ name: 'claude-a' }, { name: 'claude', host: 'otherhost' }]);
  probed(registry, HOST, [{ account: 'claude-a', identity: shared }]);
  probed(registry, 'otherhost', [{ account: 'claude', identity: shared }]);
  return registry;
}
const twinHeld = (registry: AgentRegistry) => accountIneligibility(registry, account(registry, 'claude'), now, 'otherhost');

/** Claude login homes as Claude Code writes them: `claude-a` and `claude` on one subscription, `claude-c` on another. */
async function claudeHomes(root: string) {
  const login = async (name: string, id: string) => {
    const home = join(root, name);
    await mkdir(home, { recursive: true });
    await writeFile(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `access-${name}`, refreshToken: `refresh-${name}`, expiresAt: spentAt + 86_400_000 } }));
    await writeFile(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: id, organizationUuid: `org-${id}` } }));
    return home;
  };
  return { 'claude-a': await login('claude-a', 'account-1'), claude: await login('claude', 'account-1'), 'claude-c': await login('claude-c', 'account-2') };
}
async function writeHolds(config: { credentialFile: string }, exhausted: Record<string, ObservedExhaustion>, logged: Record<string, unknown> = {}) {
  const log = await environments.readEnvironmentLog(config);
  await writeFile(environments.environmentLogPath(config), JSON.stringify({ ...log, environments: { ...log.environments, ...logged }, exhausted }));
}
const loopRegistry = (homes: Record<'claude-a' | 'claude' | 'claude-c', string>, at: string) =>
  loopRegistryOf((['claude-a', 'claude', 'claude-c'] as const).map(name => ({ name, home: homes[name] })), [{ name: 'doctor', accounts: ['claude', 'claude-c'] }], at);
const health = (name: string, home: string, identity: string | null) => ({ name, kind: 'claude', home, variable: 'CLAUDE_CONFIG_DIR', checkedAt: new Date(spentAt).toISOString(), loggedIn: true, quota: 'unknown', usage: [], healthy: true, reason: null, note: null, login: null, identity });

test('unit:quota-mark-explicit-null-identity — an operator quota mark naming identity null clears the recorded provider identity; a mark omitting identity keeps the last one', () => {
  const registry = registryOf([{ name: 'claude-a' }, { name: 'claude' }]);
  probed(registry, HOST, [{ account: 'claude-a', identity: shared }, { account: 'claude', identity: shared }]);
  const at = { actor: 'operator', at: new Date(spentAt).toISOString() };

  const kept = applyRegistryMutation(registry, 'account.quota', { name: 'claude-a', quota: { state: 'exhausted', resetsAt }, reason: 'weekly limit' }, at).registry;
  assert.equal(account(kept, 'claude-a').quota.identity, shared, 'a mark that omits identity keeps the last one read');
  assert.match(accountIneligibility(kept, account(kept, 'claude'), now, HOST)!, /same provider login as claude-a/, 'so the twin is held');

  const cleared = applyRegistryMutation(kept, 'account.quota', { name: 'claude-a', quota: { state: 'exhausted', resetsAt, identity: null }, reason: 'weekly limit; now an API-key login' }, at).registry;
  assert.equal(account(cleared, 'claude-a').quota.identity, null, 'an explicit null clears it, as the schema states');
  assert.equal(accountIneligibility(cleared, account(cleared, 'claude'), now, HOST), null, 'an account of a former login is not over-held until the reset');
  assert.match(accountIneligibility(cleared, account(cleared, 'claude-a'), now, HOST)!, /^claude-a quota is exhausted until 2026-10-11T05:00:00\.000Z/, 'the marked account itself stays held');

  // Through the wire schema as well: null is carried, not stripped to "omitted".
  const wire = applyRegistryMutation(kept, 'account.quota', JSON.parse(JSON.stringify({ name: 'claude-a', quota: { state: 'exhausted', resetsAt, identity: null }, reason: 'cleared' })), at).registry;
  assert.equal(account(wire, 'claude-a').quota.identity, null);
});

test('unit:legacy-environment-twin-by-home — a legacy configured environment named like a registry account but on another home is held by its own home\'s login, never by the shared name', async () => {
  const root = await scratch('followups-legacy-home');
  const homes = await claudeHomes(root);
  const credentialFile = join(root, 'coordinator.token');
  // The registry account claude-a ran in its own home (account-1) and was spent there.
  const registryHome = { credentialFile, environments: [] };
  await environments.recordEnvironmentLog(registryHome, [health('claude-a', homes['claude-a'], (await providerIdentity('claude', homes['claude-a'])) ?? null) as never]);
  const hold = await recordObservedExhaustion(registryHome, 'claude-a', spent, now);
  assert.equal(hold.home, homes['claude-a'], 'the hold names the home it was spent in');

  // A legacy configured `claude-a` on another subscription's home (account-2) is not held by the shared name.
  const onOther = [{ name: 'claude-a', kind: 'claude' as const, home: homes['claude-c'] }];
  const held = await observedExhaustions({ credentialFile }, now);
  assert.equal(environments.spentHere(held['claude-a'], onOther[0]), false);
  assert.equal(await heldTwin(onOther, held, 'claude-a'), null, 'another login on another home is free');
  const config = { credentialFile, environments: onOther, run: masterConfigSchema.shape.run.parse({}) } as Pick<MasterConfig, 'environments' | 'credentialFile' | 'run'>;
  const launched = await selectAccount(config, 'worker', { name: 'builder', accounts: ['claude-a'] }, { quota: false, cacheMs: 0, now: () => now });
  assert.equal(launched.account?.name, 'claude-a', 'the legacy environment launches on its own, healthy login');

  // On a home of the spent login it is held as the twin it is, by that home's login.
  const onSame = [{ name: 'claude-a', kind: 'claude' as const, home: homes.claude }];
  assert.match((await heldTwin(onSame, held, 'claude-a'))!.reason, /^claude-a is the same provider login as claude-a exhausted its quota mid-session/);
  await assert.rejects(selectAccount({ ...config, environments: onSame }, 'worker', { name: 'builder', accounts: ['claude-a'] }, { quota: false, cacheMs: 0, now: () => now }), /same provider login as claude-a/);
  // The configured home that was spent is held by name as before.
  const onSpent = [{ name: 'claude-a', kind: 'claude' as const, home: homes['claude-a'] }];
  assert.equal(environments.spentHere(held['claude-a'], onSpent[0]), true);

  // A pre-upgrade hold with no login and no home reads the home its launch last ran in, not the same-named configured one.
  const legacy = { credentialFile: join(root, 'legacy.token') };
  await writeHolds(legacy, { 'claude-a': { ...spent, until: resetsAt } }, { 'claude-a': health('claude-a', homes['claude-a'], null) });
  const logged = (await environments.readEnvironmentLog(legacy)).environments;
  const legacyHeld = await observedExhaustions(legacy, now);
  const twins = [{ name: 'claude-a', kind: 'claude' as const, home: homes['claude-c'] }, { name: 'claude', kind: 'claude' as const, home: homes.claude }, { name: 'claude-c', kind: 'claude' as const, home: homes['claude-c'] }];
  assert.match((await heldTwin(twins, legacyHeld, 'claude', logged))!.reason, /^claude is the same provider login as claude-a/, 'the spent login\'s twin is held');
  assert.equal(await heldTwin(twins, legacyHeld, 'claude-c', logged), null, 'the configured home\'s login is not');
  // Nor is the same-named legacy environment on that other home held by the name: the logged launch home decides.
  assert.equal(environments.spentHere(legacyHeld['claude-a'], twins[0], logged['claude-a']), false);
  assert.equal(environments.spentHere(legacyHeld['claude-a'], { home: homes['claude-a'] }, logged['claude-a']), true);
  assert.equal(await heldTwin(twins, legacyHeld, 'claude-a', logged), null);
  const legacyLaunch = await selectAccount({ ...legacy, environments: twins, run: masterConfigSchema.shape.run.parse({}) }, 'worker', { name: 'builder', accounts: ['claude-a'] }, { quota: false, cacheMs: 0, now: () => now });
  assert.equal(legacyLaunch.account?.home, homes['claude-c'], 'the legacy environment launches on its own login');

  // What this host reports to the registry: a same-named hold spent on another home and another login is not the probed account's.
  const other = await providerIdentity('claude', homes['claude-c']), probedQuota = (identity: string | null | undefined): QuotaObservation => ({ loggedIn: true, state: 'available', usage: [], resetsAt: null, reason: null, identity });
  assert.equal(environments.heldOverlay(held, 'claude-a', probedQuota(other)).state, 'available', 'a registry account on another login is not held by the shared name');
  assert.equal(environments.heldOverlay(held, 'claude-a', probedQuota(held['claude-a'].identity)).state, 'exhausted', 'the spent login reads spent');
  assert.equal(environments.heldOverlay(held, 'claude-a', probedQuota(null)).state, 'exhausted', 'with no registry home to judge by, an unknown login is held by the name');
  // The registry account's own home decides, whatever either login reads.
  assert.equal(environments.heldOverlay(held, 'claude-a', probedQuota(null), homes['claude-c']).state, 'available', 'a registry claude-a on another home with an unknown login is not held by the name');
  assert.equal(environments.heldOverlay(held, 'claude-a', probedQuota(other), homes['claude-c']).state, 'available');
  assert.equal(environments.heldOverlay(held, 'claude-a', probedQuota(null), homes['claude-a']).state, 'exhausted', 'the account spent in its own home is held, its login unknown or not');
  assert.equal(environments.heldOverlay(held, 'claude-a', probedQuota(other), homes['claude-a']).state, 'exhausted');
  assert.match(environments.heldOverlay(held, 'claude-a', probedQuota(held['claude-a'].identity), homes['claude-c']).reason!, /^claude-a is the same provider login as claude-a/, 'another home on the spent login is held as a twin');
  // A legacy environment's API-key login (identity null) spent on another home holds a registry account on a known login not at all.
  const keyLogin = { 'claude-a': { ...spent, until: resetsAt, identity: null, home: homes['claude-c'] } };
  assert.equal(environments.heldOverlay(keyLogin, 'claude-a', probedQuota(held['claude-a'].identity), homes['claude-a']).state, 'available');
  assert.equal(environments.heldOverlay(keyLogin, 'claude-a', probedQuota(null), homes['claude-a']).state, 'available');

  // Every role's selection judges by the registry's home: heldAwareProbe reads the document and reports the account unspent.
  const selections: QuotaObservation[] = [], onHomeA = registryOf([{ name: 'claude-a', home: homes['claude-a'] }, { name: 'claude', home: homes.claude }]);
  const legacyHome = { credentialFile: join(root, 'legacy-home.token'), hostId: HOST };
  await writeHolds(legacyHome, keyLogin);
  const selecting = { document: async () => onHomeA, end: async () => {}, select: async (request: { observations: { quota: QuotaObservation }[] }) => { selections.push(...request.observations.map(entry => entry.quota)); return { selected: false, reason: 'probe', skipped: [], session: null, account: null, runtime: null, model: null, revision: 1 }; } };
  const wrapped = (await environments.heldAwareProbe(legacyHome, { registry: selecting as never })).registry!;
  for (const identity of [null, held['claude-a'].identity!]) await wrapped.select({ role: 'worker', host: HOST, work: null, group: null, principal: null, observations: [{ account: 'claude-a', quota: probedQuota(identity) }] });
  assert.deepEqual(selections.map(quota => quota.state), ['available', 'available'], 'the legacy hold on another home is not reported as the registry account\'s');

  // Nor is it reported to the registry as the account's own: neither the account nor its twin is marked, with its login known or null.
  for (const identity of [other, null]) {
    const reporting = { credentialFile: join(root, `report-${identity ? 'known' : 'null'}.token`), hostId: HOST }, registry = registryOf([{ name: 'claude-a', home: homes['claude-a'] }, { name: 'claude', home: homes.claude }]);
    probed(registry, HOST, [{ account: 'claude-a', identity: held['claude-a'].identity! }, { account: 'claude', identity: held['claude-a'].identity! }]);
    await writeHolds(reporting, { 'claude-a': { ...spent, until: resetsAt, identity, home: homes['claude-c'] } });
    const sent: ObserveRequest[] = [], client = { document: async () => registry, observe: async (request: ObserveRequest) => { sent.push(request); return foldObservations(registry, request, { actor: 'executor', at: new Date(now).toISOString() }); } };
    assert.equal(await reportPendingExhaustions(reporting, { registry: client }, now), 0);
    assert.deepEqual(sent, [], 'nothing is sent as claude-a');
    assert.notEqual(account(registry, 'claude-a').quota.state, 'exhausted');
    assert.equal(accountIneligibility(registry, account(registry, 'claude'), now, HOST), null, 'no twin is marked');
    // The same hold spent in the registry account's own home is its own, and is reported.
    await writeHolds(reporting, { 'claude-a': { ...spent, until: resetsAt, identity: held['claude-a'].identity, home: homes['claude-a'] } });
    assert.equal(await reportPendingExhaustions(reporting, { registry: client }, now), 1);
    assert.equal(account(registry, 'claude-a').quota.state, 'exhausted');
    assert.match(accountIneligibility(registry, account(registry, 'claude'), now, HOST)!, /same provider login as claude-a/);
  }

  // An unreadable login falls back to the identity the log recorded only when it was read from the same home.
  const unreadable = await scratch('followups-unreadable');
  await writeFile(join(unreadable, '.claude.json'), '{"oauthAccount": {"accountUu');
  const recorded = { 'claude-x': { identity: shared, home: homes.claude } };
  assert.equal(await heldTwin([{ name: 'claude-x', kind: 'claude', home: unreadable }], { 'claude-a': { ...spent, until: resetsAt, identity: shared } }, 'claude-x', recorded), null, 'another home\'s recorded login is not borrowed');
  assert.ok(await heldTwin([{ name: 'claude-x', kind: 'claude', home: unreadable }], { 'claude-a': { ...spent, until: resetsAt, identity: shared } }, 'claude-x', { 'claude-x': { identity: shared, home: unreadable } }), 'its own is');
});

test('unit:exhaustion-hold-observe-retried — a transient failure of the immediate registry observe is retried at once, so the hold reaches the registry before any selection runs', async () => {
  const root = await scratch('followups-retried');
  const registry = twinElsewhere();
  const config = { credentialFile: join(root, 'coordinator.token'), hostId: HOST };
  let calls = 0;
  const flaky = { observe: async (request: ObserveRequest) => { calls++; if (calls === 1) throw new Error('observe timed out'); return foldObservations(registry, request, { actor: 'executor', at: new Date(now).toISOString() }); } };
  await recordObservedExhaustion(config, 'claude-a', { ...spent, identity: shared }, now, { registry: flaky });
  assert.equal(calls, 2, 'the failed observe is sent again');
  assert.equal((await observedExhaustions(config, now))['claude-a'].reported, true, 'the hold is delivered, not left for a later selection');
  assert.match(twinHeld(registry)!, /^claude quota is exhausted until 2026-10-11T05:00:00\.000Z: it is the same provider login as claude-a/, 'the twin on the other host is refused at once');

  // A registry still down after the retry leaves the hold pending for the loop's next cycle.
  const down = { credentialFile: join(root, 'down.token'), hostId: HOST };
  let attempts = 0;
  await recordObservedExhaustion(down, 'claude-a', { ...spent, identity: shared }, now, { registry: { observe: async () => { attempts++; throw new Error('observe timed out'); } } });
  assert.equal(attempts, 2);
  assert.equal((await observedExhaustions(down, now))['claude-a'].reported, false);
});

test('unit:pending-exhaustion-report-retried-across-cycles — under the real loop a failed report stays pending and is resent each cycle within its timeout, is delivered once the registry answers, and leaves the pending set at its reset', { timeout: 60_000 }, async () => {
  const root = await scratch('followups-cycles');
  const homes = await loopHomes(root, spentAt + 7 * 86_400_000);
  const config = await loopConfig(root);
  const registry = { current: loopRegistry(homes, new Date(spentAt - 3_600_000).toISOString()) };
  probed(registry.current, HOST, [{ account: 'claude', identity: shared }]);
  const plane = controlPlane(registry), loop = heldAccountLoop(config, root, plane.fetcher);
  const sends = () => plane.observes.filter(observe => observe.accounts.includes('claude-a'));
  clock.install(now);
  try {
    // claude-a is spent while the control plane is down: the immediate report and its retry both fail.
    plane.mode = 'down';
    await recordObservedExhaustion({ ...config, environments: [] }, 'claude-a', { ...spent, identity: shared }, Date.now(), { fetch: plane.fetcher });
    assert.equal(sends().length, 2, 'reported at once, and retried at once');
    assert.equal((await observedExhaustions(config))['claude-a'].reported, false);

    // Cycle 1: the control plane never answers; the loop's report is abandoned at its five-second timeout, and the cycle goes on.
    plane.mode = 'hanging';
    const started = performance.now();
    await loop.cycle();
    assert.ok(performance.now() - started < 5_000 + 3_000, `the cycle is bounded by the observe timeout: ${Math.round(performance.now() - started)} ms`);
    assert.equal(sends().length, 3, 'the cycle resent the pending hold');
    assert.ok(sends().every(observe => observe.bounded), 'every report carries its timeout');
    assert.equal((await observedExhaustions(config))['claude-a'].reported, false);
    // Cycles 2 and 3: it answers 503; each cycle resends the hold, and it stays pending.
    for (const cycle of [2, 3]) {
      clock.advance(minute);
      plane.mode = 'down';
      await loop.cycle();
      assert.equal(sends().length, cycle + 2, `cycle ${cycle} resent the hold`);
      assert.equal((await observedExhaustions(config))['claude-a'].reported, false);
    }
    assert.notEqual(account(registry.current, 'claude-a').quota.state, 'exhausted', 'the registry has not heard of the hold yet');
    // Cycle 4: it answers, and the hold is delivered.
    clock.advance(minute);
    plane.mode = 'up';
    await loop.cycle();
    assert.deepEqual(sends().map(observe => observe.delivered), [false, false, false, false, false, true]);
    assert.equal((await observedExhaustions(config))['claude-a'].reported, true);
    assert.equal(account(registry.current, 'claude-a').quota.state, 'exhausted');
    assert.match(accountIneligibility(registry.current, account(registry.current, 'claude'), Date.now(), HOST)!, /same provider login as claude-a/, 'the twin is held fleet-wide');
    // Later cycles send a delivered hold no more.
    for (let cycle = 0; cycle < 3; cycle++) { clock.advance(minute); await loop.cycle(); }
    assert.equal(sends().length, 6, 'a delivered hold is not sent again');

    // A hold that never landed is resent until its reset and drops out of the pending set once it passes.
    plane.mode = 'down';
    await recordObservedExhaustion({ ...config, environments: [] }, 'claude-c', { ...spent, resetsAt: new Date(Date.now() + 10 * minute).toISOString() }, Date.now(), { fetch: plane.fetcher });
    const lapsing = () => plane.observes.filter(observe => observe.accounts.includes('claude-c')).length;
    clock.advance(minute); await loop.cycle();
    assert.equal(lapsing(), 3, 'pending: resent by the cycle');
    clock.advance(10 * minute); await loop.cycle();
    assert.equal(lapsing(), 3, 'nothing past its reset is reported');
    assert.equal((await observedExhaustions(config)).hasOwnProperty('claude-c'), false);
  } finally { clock.uninstall(); }
});

test('unit:legacy-hold-without-reported-is-pending — a hold saved before `reported` existed is sent to the registry like a reported:false hold', async () => {
  const root = await scratch('followups-legacy-pending');
  const registry = twinElsewhere();
  const config = { credentialFile: join(root, 'coordinator.token'), hostId: HOST };
  await writeHolds(config, { 'claude-a': { ...spent, until: resetsAt, identity: shared } });
  assert.equal((await observedExhaustions(config, now))['claude-a'].reported, undefined, 'recorded before GY-1573 added the field');
  const sent: QuotaObservation[] = [];
  const up = { observe: async (request: ObserveRequest) => { sent.push(...request.observations.map(entry => entry.quota)); return foldObservations(registry, request, { actor: 'executor', at: new Date(now).toISOString() }); } };
  assert.equal(await reportPendingExhaustions(config, { registry: up }, now), 1, 'the legacy hold is pending');
  assert.equal(sent[0].state, 'exhausted');
  assert.equal(sent[0].resetsAt, resetsAt);
  assert.equal(sent[0].identity, shared);
  assert.match(twinHeld(registry)!, /same provider login as claude-a/);
  assert.equal((await observedExhaustions(config, now))['claude-a'].reported, true);
  assert.equal(await reportPendingExhaustions(config, { registry: up }, now), 0);
});

test('unit:past-reset-not-recorded — a resetsAt not in the future when recorded is dropped for the fallback hold, so neither the account nor its twin is held past the fallback', async () => {
  const root = await scratch('followups-past-reset');
  const homes = await claudeHomes(root);
  const configured = (['claude-a', 'claude'] as const).map(name => ({ name, kind: 'claude' as const, home: homes[name] }));
  const config = { credentialFile: join(root, 'coordinator.token'), environments: configured };
  for (const reset of [new Date(now - 60_000).toISOString(), new Date(now).toISOString()]) {
    const entry = await recordObservedExhaustion(config, 'claude-a', { ...spent, resetsAt: reset }, now);
    assert.equal(entry.resetsAt, null, `${reset} is not kept`);
    assert.equal(entry.until, new Date(now + environments.unknownResetHoldMs).toISOString(), 'the fallback hour holds the account');
    const held = await observedExhaustions(config, now);
    assert.equal(await heldTwin(configured, held, 'claude'), null, 'its twin is not held by a guessed hour');
    assert.equal(environments.heldObservation('claude-a', held['claude-a']).identity, null, 'the registry hears a hold that names no login');
    assert.deepEqual(await observedExhaustions(config, now + environments.unknownResetHoldMs + 1), {}, 'nothing is held past the fallback');
  }
  // A future reset is kept and holds the twin until then.
  const future = await recordObservedExhaustion(config, 'claude-a', spent, now);
  assert.equal(future.resetsAt, resetsAt);
  assert.match((await heldTwin(configured, await observedExhaustions(config, now), 'claude'))!.reason, /same provider login as claude-a/);
});

test('unit:role-selection-honours-held-twin — the planner, acceptance and doctor roles select through heldAwareProbe: with a twin held here they pick a healthy account, and the hold and the registry mark survive', async () => {
  const root = await scratch('followups-roles');
  const homes = await claudeHomes(root);
  const credentialFile = join(root, 'coordinator.token');
  await writeFile(credentialFile, token, { mode: 0o600 });
  const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: HOST,
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], operatorAgent: { id: 'graphyard-operator', credentialFile }, approver: { id: 'graphyard-approver', credentialFile } });
  const accounts = (['claude-a', 'claude', 'claude-c'] as const).map(name => ({ name, home: homes[name] }));
  const login = await providerIdentity('claude', homes['claude-a']);
  // claude-a was spent here; the hold names its login. The registry was told (claude-a exhausted) for the planner case only.
  await recordObservedExhaustion({ credentialFile, environments: accounts.map(entry => ({ ...entry, kind: 'claude' as const })) }, 'claude-a', spent, now);
  let registry = registryOf(accounts, [{ name: 'planner', accounts: ['claude-a', 'claude', 'claude-c'] }, { name: 'acceptance', accounts: ['claude', 'claude-c'] }, { name: 'doctor', accounts: ['claude', 'claude-c'] }]);
  foldObservations(registry, { host: HOST, observations: [{ account: 'claude-a', quota: environments.heldObservation('claude-a', (await observedExhaustions({ credentialFile }, now))['claude-a']) }] }, { actor: 'executor', at: new Date(now).toISOString() });
  assert.equal(account(registry, 'claude-a').quota.state, 'exhausted');

  // The control plane, in memory, behind the HTTP client every role uses; any other request (a provider usage read) is refused.
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname, body = init?.body ? JSON.parse(String(init.body)) : undefined, at = { actor: 'executor', at: new Date().toISOString() };
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (path === '/api/agent-registry/document') return json(registry);
    if (path === '/api/agent-registry/observe') { foldObservations(registry, body, at); return json(registry); }
    if (path.startsWith('/api/agent-registry/sessions/')) { const id = path.split('/')[4]; registry = { ...registry, sessions: registry.sessions.map(session => session.id === id ? { ...session, endedAt: at.at, endReason: body.reason } : session) }; return json({}); }
    if (path === '/api/agent-registry/select') {
      foldObservations(registry, body, at);
      const choice = chooseSession(registry, body, Date.now());
      if (!choice.account) return json({ selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision });
      const session: FleetSession = { id: crypto.randomUUID(), role: body.role, account: choice.account.name, runtime: choice.runtime.name, model: choice.model.name, host: HOST, work: body.work, principal: body.principal, group: body.group,
        selectedAt: at.at, selectedBy: 'coordinator', reason: choice.reason, skipped: choice.skipped, endedAt: null, endReason: null };
      registry = { ...registry, sessions: [...registry.sessions, session], revision: registry.revision + 1 };
      return json({ selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, policy: choice.policy, revision: registry.revision });
    }
    return new Response('{"error":"not here"}', { status: 404 });
  }) as typeof fetch;
  try {
    const goal = { key: 'GOAL-1' } as never, calls = { fetcher: globalThis.fetch, asCoordinator: async () => ({}), asOperatorAgent: async () => ({}), run: async () => '' } as never;
    // The planner's role lists claude-a itself: this host's probe reads it unspent, but it is reported as the hold, so its mark is not cleared.
    await plannerEffects(config, root, calls).runner('plan', 'primary', goal);
    assert.equal(registry.sessions.at(-1)!.role, 'planner');
    assert.equal(registry.sessions.at(-1)!.account, 'claude-c', 'the planner lands on the healthy login');
    assert.equal(account(registry, 'claude-a').quota.state, 'exhausted', 'the probe did not clear the registry\'s mark');
    assert.equal(account(registry, 'claude-a').quota.identity, login);

    // The acceptance and doctor roles list only the twin and a healthy account; the twin is reported spent from this host's hold.
    for (const [role, run] of [['acceptance', () => acceptanceEffects(config, root, calls).runner('draft', 'primary', goal)], ['doctor', () => doctorEffects(config, root, async () => ({})).runner('primary')]] as const) {
      // A registry that has not heard of claude-a's hold: only this host's report can hold the twin.
      foldObservations(registry, { host: HOST, observations: [{ account: 'claude-a', quota: { loggedIn: true, state: 'available', usage: [], resetsAt: null, reason: null, identity: login } }] }, { actor: 'executor', at: new Date().toISOString() });
      await run();
      const session = registry.sessions.filter(entry => entry.role === role).at(-1)!;
      assert.equal(session.account, 'claude-c', `${role} lands on the healthy login`);
      assert.match(session.skipped.find(skip => skip.account === 'claude')!.reason, /same provider login as claude-a/, `${role} skipped the held twin`);
      assert.equal(account(registry, 'claude').quota.state, 'exhausted');
    }
    assert.equal((await observedExhaustions({ credentialFile }, now)).hasOwnProperty('claude-a'), true, 'the local hold survives every role\'s selection');
  } finally { globalThis.fetch = original; }

  // The diagnostician (src/daemon/effects.ts) selects the same way.
  const source = await readFile(fileURLToPath(new URL('../src/daemon/effects.ts', import.meta.url)), 'utf8');
  assert.match(source, /selectFleetSession\(config, diagnosticianRole, [^\n]*await heldAwareProbe\(config, /);
});

test('unit:legacy-hold-identity-persisted-before-reported — a pre-upgrade hold\'s reconstructed login is kept on it before it is reported, so a source relogin while the registry is down moves no hold', async () => {
  const root = await scratch('followups-identity-first');
  const homes = await claudeHomes(root);
  const configured = (['claude-a', 'claude', 'claude-c'] as const).map(name => ({ name, kind: 'claude' as const, home: homes[name] }));
  const config = { credentialFile: join(root, 'coordinator.token'), hostId: HOST, environments: configured };
  const spentLogin = await providerIdentity('claude', homes['claude-a']);
  // A hold saved before identities or `reported` were, whose log recorded no login either.
  await writeHolds(config, { 'claude-a': { ...spent, until: resetsAt } });
  const down = { observe: async () => { throw new Error('control plane down'); } };
  await assert.rejects(reportPendingExhaustions(config, { registry: down }, now), /control plane down/);
  const kept = (await observedExhaustions(config, now))['claude-a'];
  assert.equal(kept.identity, spentLogin, 'the login read from its home is kept on the hold before any report lands');
  assert.equal(kept.reported, undefined, 'and the hold is still pending');

  // The source home logs in afresh to another subscription before the registry answers.
  await writeFile(join(homes['claude-a'], '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'account-2', organizationUuid: 'org-account-2' } }));
  const held = await observedExhaustions(config, now);
  assert.match((await heldTwin(configured, held, 'claude'))!.reason, /^claude is the same provider login as claude-a/, 'the spent login\'s twin stays held');
  assert.equal(await heldTwin(configured, held, 'claude-c'), null, 'the new login inherits nothing');

  const sent: QuotaObservation[] = [];
  assert.equal(await reportPendingExhaustions(config, { registry: { observe: async (request: ObserveRequest) => { sent.push(...request.observations.map(entry => entry.quota)); return emptyRegistry(); } } }, now), 1);
  assert.equal(sent[0].identity, spentLogin, 'the registry is told the spent login, not the relogged one');
  const reported = (await observedExhaustions(config, now))['claude-a'];
  assert.equal(reported.reported, true);
  assert.equal(reported.identity, spentLogin);
  assert.match((await heldTwin(configured, await observedExhaustions(config, now), 'claude'))!.reason, /same provider login as claude-a/);
});
