import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FleetClient, FleetSelection } from '../src/fleet.js';
import { masterConfigSchema, selectAccount, type MasterConfig } from '../src/master.js';
import * as environments from '../src/master/environments.js';
import { observedExhaustions, recordObservedExhaustion } from '../src/master/environments.js';
import { accountIneligibility, applyRegistryMutation, chooseSession, emptyRegistry, fleetView, foldObservations, proposedRuntimes, type AgentRegistry, type FleetSession, type QuotaObservation } from '../src/model/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1573: two registry accounts logged in to one provider subscription share one limit. On
 * 2026-10-09 the loop saw claude-a hit its weekly limit at 05:30Z and relaunched GY-1571 on
 * `claude`, the same Claude login, whose own probe still read quota unknown; the session opened
 * straight onto the spent usage-limit menu. Each account now carries the provider identity its
 * executor read from the login, and an exhaustion recorded with a reset holds every account of
 * that identity until the reset, naming the twin; an unknown or different identity is unaffected.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const HOST = 'vishrog';
const spentAt = Date.parse('2026-10-09T05:30:28Z');
// "resets Oct 10, 10pm (America/Los_Angeles)"
const resetsAt = '2026-10-11T05:00:00.000Z';
const notice = `You've hit your weekly limit · resets Oct 10, 10pm (America/Los_Angeles)`;
const shared = 'claude:' + 'a'.repeat(32), other = 'claude:' + 'b'.repeat(32);
const directories: string[] = [];
// Read off the module, so a checkout without them fails these cases rather than the file's import.
const providerIdentity = (kind: string, home: string) => environments.providerIdentity(kind, home);
const heldTwin: typeof environments.heldTwin = (...args) => environments.heldTwin(...args);
const heldObservation: typeof environments.heldObservation = (...args) => environments.heldObservation(...args);
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

function registryOf(accounts: { name: string; home?: string | null }[]): AgentRegistry {
  return applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [proposedRuntimes.find(runtime => runtime.name === 'claude')!], models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: accounts.map(account => ({ name: account.name, runtime: 'claude', model: 'opus', credential: { host: HOST, home: account.home ?? `/home/operator/.coding_agents/${account.name}` } })),
    roles: [{ name: 'worker', accounts: accounts.map(account => account.name), concurrency: 4 }], reason: 'fixture',
  }, { actor: 'operator', at: new Date(spentAt - 3_600_000).toISOString() }).registry;
}
const observe = (registry: AgentRegistry, observations: { account: string; state: 'available' | 'exhausted' | 'unknown'; resetsAt?: string | null; reason?: string | null; identity?: string | null }[], at: number) =>
  foldObservations(registry, { host: HOST, observations: observations.map(({ account, state, resetsAt = null, reason = null, identity }) => ({ account, quota: { loggedIn: true, state, usage: [], resetsAt, reason, ...identity === undefined ? {} : { identity } } })) },
    { actor: 'executor', at: new Date(at).toISOString() });

test('unit:shared-identity-exhaustion-holds-twin — an account recorded exhausted with a reset holds every registry account of the same provider identity until that reset, and master registry names the twin and the exhaustion; a different or unknown identity is unaffected', async () => {
  const registry = registryOf([{ name: 'claude-a' }, { name: 'claude' }, { name: 'claude-c' }, { name: 'claude-d' }]);
  observe(registry, [
    { account: 'claude-a', state: 'exhausted', resetsAt, reason: notice, identity: shared },
    { account: 'claude', state: 'unknown', identity: shared },
    { account: 'claude-c', state: 'unknown', identity: other },
    { account: 'claude-d', state: 'unknown', identity: null },
  ], spentAt);
  const now = spentAt + 60_000;
  const reason = accountIneligibility(registry, registry.accounts.find(account => account.name === 'claude')!, now, HOST);
  assert.equal(reason, `claude quota is exhausted until ${resetsAt}: it is the same provider login as claude-a, whose quota is exhausted (${notice})`);
  assert.equal(accountIneligibility(registry, registry.accounts.find(account => account.name === 'claude-c')!, now, HOST), null, 'a different identity is unaffected');
  assert.equal(accountIneligibility(registry, registry.accounts.find(account => account.name === 'claude-d')!, now, HOST), null, 'an unknown identity is unaffected');

  // `master registry` renders this view: the twin is ineligible, naming claude-a and the observed exhaustion.
  const view = fleetView(registry, now, HOST);
  const twin = view.accounts.find(account => account.name === 'claude')!;
  assert.equal(twin.eligible, false);
  assert.match(twin.ineligible!, /same provider login as claude-a/);
  assert.match(twin.ineligible!, /You've hit your weekly limit/);
  assert.equal(view.roles.find(role => role.role === 'worker')!.next, 'claude-c');
  const chosen = chooseSession(registry, { role: 'worker', host: HOST }, now);
  assert.equal(chosen.account?.name, 'claude-c');
  assert.deepEqual(chosen.skipped.map(skip => skip.account), ['claude-a', 'claude']);

  // A later probe that cannot read the login file leaves the identity it last read: the login has not been seen to change.
  observe(registry, [{ account: 'claude', state: 'unknown' }], now);
  assert.match(accountIneligibility(registry, registry.accounts.find(account => account.name === 'claude')!, now, HOST)!, /same provider login as claude-a/);

  // The hold ends with the reset.
  assert.equal(accountIneligibility(registry, registry.accounts.find(account => account.name === 'claude')!, Date.parse(resetsAt) + 1, HOST), null);

  // A home logged in afresh with an API key reads a login naming no account: the former identity goes, and with it the hold.
  const relogged = registryOf([{ name: 'claude-a' }, { name: 'claude' }]);
  observe(relogged, [{ account: 'claude-a', state: 'exhausted', resetsAt, reason: notice, identity: shared }, { account: 'claude', state: 'unknown', identity: shared }], spentAt);
  assert.match(accountIneligibility(relogged, relogged.accounts.find(account => account.name === 'claude')!, now, HOST)!, /same provider login as claude-a/);
  observe(relogged, [{ account: 'claude', state: 'unknown', identity: null }], now);
  assert.equal(relogged.accounts.find(account => account.name === 'claude')!.quota.identity, null);
  assert.equal(accountIneligibility(relogged, relogged.accounts.find(account => account.name === 'claude')!, now, HOST), null, 'a changed login is not held under its former identity');
  // So does an operator's account.set for the same home: the next probe reads the identity again.
  observe(relogged, [{ account: 'claude', state: 'unknown', identity: shared }], now);
  const account = relogged.accounts.find(entry => entry.name === 'claude')!;
  const reset = applyRegistryMutation(relogged, 'account.set', { account: { name: account.name, runtime: account.runtime, model: account.model, credential: account.credential }, reason: 'logged in again' }, { actor: 'operator', at: new Date(now).toISOString() }).registry;
  assert.equal(reset.accounts.find(entry => entry.name === 'claude')!.quota.identity, null);
  assert.equal(accountIneligibility(reset, reset.accounts.find(entry => entry.name === 'claude')!, now, HOST), null);

  // An operator's exhausted mark holds the twin too, keeping the identity the probe read.
  const marked = registryOf([{ name: 'claude-a' }, { name: 'claude' }]);
  observe(marked, [{ account: 'claude-a', state: 'unknown', identity: shared }, { account: 'claude', state: 'unknown', identity: shared }], spentAt);
  const next = applyRegistryMutation(marked, 'account.quota', { name: 'claude-a', quota: { state: 'exhausted', resetsAt }, reason: 'weekly limit' }, { actor: 'operator', at: new Date(spentAt).toISOString() }).registry;
  assert.equal(next.accounts.find(account => account.name === 'claude-a')!.quota.identity, shared);
  assert.match(accountIneligibility(next, next.accounts.find(account => account.name === 'claude')!, now, HOST)!, /same provider login as claude-a, whose quota is marked exhausted by operator/);

  // An exhaustion with no reset time holds only the account it was recorded on.
  const unbounded = registryOf([{ name: 'claude-a' }, { name: 'claude' }]);
  observe(unbounded, [{ account: 'claude-a', state: 'exhausted', resetsAt: null, reason: 'limit reached', identity: shared }, { account: 'claude', state: 'unknown', identity: shared }], spentAt);
  assert.equal(accountIneligibility(unbounded, unbounded.accounts.find(account => account.name === 'claude')!, now, HOST), null);
  // So does a session notice naming no reset: the hour the host assumes is its guess, not the subscription's reset, so its report names no login.
  const guessed = registryOf([{ name: 'claude-a' }, { name: 'claude' }]);
  observe(guessed, [{ account: 'claude-a', state: 'unknown', identity: shared }, { account: 'claude', state: 'unknown', identity: shared }], spentAt);
  const unknownReset = { at: new Date(spentAt).toISOString(), until: new Date(spentAt + 3_600_000).toISOString(), resetsAt: null, reason: 'limit reached', role: 'worker' as const, profile: 'builder', work: 'GY-1571', identity: shared };
  foldObservations(guessed, { host: HOST, observations: [{ account: 'claude-a', quota: heldObservation('claude-a', unknownReset, { loggedIn: true, state: 'unknown', usage: [], resetsAt: null, reason: null, identity: shared }) }] }, { actor: 'executor', at: new Date(now).toISOString() });
  assert.match(accountIneligibility(guessed, guessed.accounts.find(account => account.name === 'claude-a')!, now, HOST)!, /^claude-a quota is exhausted/, 'the source itself is held for the hour');
  assert.equal(accountIneligibility(guessed, guessed.accounts.find(account => account.name === 'claude')!, now, HOST), null, 'its twin is not held by a guessed reset');

  // The hold reaches the registry the moment a session sees it, so a twin placed on another host is refused before this host asks for anything.
  const hosts = applyRegistryMutation(registryOf([{ name: 'claude-a' }]), 'account.set', { account: { name: 'claude', runtime: 'claude', model: 'opus', credential: { host: 'otherhost', home: '/home/operator/.coding_agents/claude' } }, reason: 'fixture' }, { actor: 'operator', at: new Date(spentAt).toISOString() }).registry;
  observe(hosts, [{ account: 'claude-a', state: 'unknown', identity: shared }], spentAt);
  foldObservations(hosts, { host: 'otherhost', observations: [{ account: 'claude', quota: { loggedIn: true, state: 'unknown', usage: [], resetsAt: null, reason: null, identity: shared } }] }, { actor: 'executor', at: new Date(spentAt).toISOString() });
  const reported = await temporaryDirectory('shared-identity-report'); directories.push(reported);
  const registryClient = { observe: async (request: { host: string; observations: { account: string; quota: QuotaObservation }[] }) => foldObservations(hosts, request, { actor: 'executor', at: new Date(now).toISOString() }) };
  await recordObservedExhaustion({ credentialFile: join(reported, 'coordinator.token'), hostId: HOST }, 'claude-a', { at: new Date(spentAt).toISOString(), resetsAt, reason: notice, role: 'worker', profile: 'builder', work: 'GY-1571' }, now, { registry: registryClient });
  assert.match(accountIneligibility(hosts, hosts.accounts.find(account => account.name === 'claude')!, now, 'otherhost')!, /^claude quota is exhausted until 2026-10-11T05:00:00\.000Z: it is the same provider login as claude-a/);

  // A spent home logged in afresh to another subscription moves no hold: the login recorded at exhaustion stays held, the new one is free.
  const relogin = await temporaryDirectory('shared-identity-relogin'); directories.push(relogin);
  const reloginHomes = await claudeHomes(relogin);
  const configured = Object.entries(reloginHomes).map(([name, home]) => ({ name, kind: 'claude' as const, home }));
  const spent = await recordObservedExhaustion({ credentialFile: join(relogin, 'coordinator.token'), environments: configured }, 'claude-a', { at: new Date(spentAt).toISOString(), resetsAt, reason: notice, role: 'worker', profile: 'builder', work: 'GY-1571' }, now);
  assert.equal(spent.identity, await providerIdentity('claude', reloginHomes.claude), 'the hold keeps the login it was spent on');
  await writeFile(join(reloginHomes['claude-a'], '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'account-2', organizationUuid: 'org-account-2' } }));
  const heldNow = await observedExhaustions({ credentialFile: join(relogin, 'coordinator.token') }, now);
  assert.match((await heldTwin(configured, heldNow, 'claude'))!.reason, /^claude is the same provider login as claude-a/, 'the spent subscription stays held');
  assert.equal(await heldTwin(configured, heldNow, 'claude-c'), null, 'the source\'s new subscription inherits nothing');
  const observation = heldObservation('claude-a', heldNow['claude-a'], { loggedIn: true, state: 'available', usage: [], resetsAt: null, reason: null, identity: await providerIdentity('claude', reloginHomes['claude-a']) });
  assert.equal(observation.identity, spent.identity, 'the registry is told the spent login, not the new one');

  // The identity is read from the login itself: two homes on one Claude OAuth account and organization read alike.
  const scratch = await temporaryDirectory('shared-identity'); directories.push(scratch);
  const homes = await claudeHomes(scratch);
  const [a, b, c] = await Promise.all([providerIdentity('claude', homes['claude-a']), providerIdentity('claude', homes.claude), providerIdentity('claude', homes['claude-c'])]);
  assert.match(a!, /^claude:[0-9a-f]{32}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(!a!.includes('account-1'), 'the identity is a digest; the provider ids stay on the host');
  assert.equal(await providerIdentity('claude', scratch), null, 'a home with no OAuth account has an unknown identity');
  await writeFile(join(scratch, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
  assert.equal(await providerIdentity('claude', scratch), null, 'an API-key login names no account');
  await writeFile(join(scratch, '.claude.json'), '{"oauthAccount": {"accountUu');
  assert.equal(await providerIdentity('claude', scratch), undefined, 'a login file caught mid-write is unreadable, not a changed login');
  assert.equal(await providerIdentity('opencode', homes.claude), null);
});

/** Claude login homes as Claude Code writes them: the OAuth token and the account it belongs to. */
async function claudeHomes(root: string) {
  const login = async (name: string, account: string) => {
    const home = join(root, name);
    await mkdir(home, { recursive: true });
    await writeFile(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `access-${name}`, refreshToken: `refresh-${name}`, expiresAt: spentAt + 86_400_000 } }));
    await writeFile(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: account, organizationUuid: `org-${account}`, emailAddress: 'operator@example.test' } }));
    return home;
  };
  return { 'claude-a': await login('claude-a', 'account-1'), claude: await login('claude', 'account-1'), 'claude-c': await login('claude-c', 'account-2') };
}

test('unit:shared-identity-dispatch-replay — replaying 2026-10-09 05:30Z (claude-a exhausted, claude on the same login, GY-1571 ready), dispatch selects neither claude-a nor claude and launches on claude-c', async () => {
  const scratch = await temporaryDirectory('shared-identity-replay'); directories.push(scratch);
  const homes = await claudeHomes(scratch);
  const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(scratch, 'coordinator.token'), cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: HOST, masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  // The control plane's registry, in memory: it folds what the executor observed and chooses exactly as the server does.
  let registry = registryOf([{ name: 'claude-a', home: homes['claude-a'] }, { name: 'claude', home: homes.claude }, { name: 'claude-c', home: homes['claude-c'] }]);
  const now = spentAt + 30_000;
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    select: async request => {
      foldObservations(registry, request, { actor: 'executor', at: new Date(now).toISOString() });
      const choice = chooseSession(registry, request, now);
      if (!choice.account) return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision } satisfies FleetSelection;
      const session: FleetSession = { id: crypto.randomUUID(), role: request.role, account: choice.account.name, runtime: choice.runtime.name, model: choice.model.name, host: HOST, work: request.work, principal: request.principal, group: request.group,
        selectedAt: new Date(now).toISOString(), selectedBy: 'coordinator', reason: choice.reason, skipped: choice.skipped, endedAt: null, endReason: null };
      registry = { ...registry, sessions: [...registry.sessions, session], revision: registry.revision + 1 };
      return { selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, policy: choice.policy, revision: registry.revision };
    },
    end: async () => {},
    observe: async request => foldObservations(registry, request, { actor: 'executor', at: new Date(now).toISOString() }),
  };
  // 05:30:28Z: the loop reads claude-a's session notice, holds claude-a until its reset and tells the registry at once.
  await recordObservedExhaustion(config, 'claude-a', { at: new Date(spentAt).toISOString(), resetsAt, reason: notice, role: 'worker', profile: 'builder', work: 'GY-1571' }, spentAt, { registry: client });
  assert.equal(registry.accounts.find(account => account.name === 'claude-a')!.quota.state, 'exhausted', 'the registry holds claude-a before any launch asks');

  // GY-1571 is ready: the next worker launch asks the registry for a session. Usage is not read (claude's would say unknown).
  const selected = await selectAccount(config, 'worker', { name: 'builder', principal: 'graphyard-claude-2' }, { registry: client, quota: false, cacheMs: 0, now: () => now, work: 'GY-1571' });
  assert.equal(selected.account?.name, 'claude-c', 'the launch lands on a healthy login');
  const skipped = Object.fromEntries(selected.skipped.map(skip => [skip.environment, skip]));
  assert.deepEqual(Object.keys(skipped).sort(), ['claude', 'claude-a']);
  assert.match(skipped['claude-a'].reason, /claude-a exhausted its quota mid-session/);
  assert.match(skipped.claude.reason, /^claude quota is exhausted until 2026-10-11T05:00:00\.000Z: it is the same provider login as claude-a/);
  assert.equal(skipped.claude.cause, 'exhausted', 'the twin waits for the reset like any spent account');
  assert.equal(registry.sessions.at(-1)!.account, 'claude-c');
  assert.equal(registry.sessions.at(-1)!.work, 'GY-1571');

  // A role the registry does not define launches from the profile's own environments: the same hold applies there.
  const local = Object.entries(homes).map(([name, home]) => ({ name, kind: 'claude' as const, home }));
  const held = await observedExhaustions(config, now);
  assert.match((await heldTwin(local, held, 'claude'))!.reason, /^claude is the same provider login as claude-a exhausted its quota mid-session/);
  assert.equal(await heldTwin(local, held, 'claude-c'), null);
});
