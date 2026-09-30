import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { accountIneligibility, applyRegistryMutation, chooseSession, emptyRegistry, endRegistrySession, proposedRuntimes, roleIneligibility, type AgentRegistry, type FleetAccount, type FleetRoleName } from '../src/model/registry.js';
import { masterConfigSchema, observedExhaustions, recordObservedExhaustion, selectAccount, type MasterConfig } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-961 — the recurring capacity faults (four in 24 hours: GY-487, GY-727, GY-853 waiting on a
 * provider account out of quota, and producer capacity exhausted on every configured account with
 * launches paused until reset). All four share one cause: account selection was first-fit in the
 * profile's or role's fixed order, so every launch piled onto the first account until its quota
 * spent, then the next — each account in turn was driven past its ceiling with sessions at work on
 * it, and the pool drained in lockstep while the others sat idle. These tests reproduce each listed instance against that base policy and show it
 * does not recur against the candidate, where the eligible account used least recently serves.
 *
 * The provider is simulated the way the real ones meter: a rolling 5h window per account, a
 * session spending 20% of it, an account out of quota from 95% up until enough of the window has
 * aged out — the resetsAt the probes read and the holds name. Both paths a launch can take are
 * driven: the control plane's registry choice (`chooseSession`, the choke point every
 * registry-defined role goes through) and the local profile fallback (`selectAccount`). The base
 * policy is the old one, expressed over the same eligibility predicates the code uses; candidate
 * and base differ in nothing but which eligible account serves.
 */

const HOST = 'loop-host';
const MINUTE = 60_000, HOUR = 60 * MINUTE;
const WINDOW = 5 * HOUR, INCREMENT = 20, CEILING = 95;
/** The horizon of the filed instances: 24 hours of launches, one every half hour. */
const STEP = 30 * MINUTE, LAUNCHES = 48;
const START = Date.parse('2026-09-29T08:56:00.672Z');
const ACCOUNTS = ['claude-a', 'codex-a', 'opencode-a'];
/** A session's run: it ends well before the next launch, so the role never holds more than one live session. */
const RUN = 20 * MINUTE;
/**
 * Every instance listed on GY-961, each a role drained to a standstill by the shared cause, with
 * the role it waited in: the three items were worker launches waiting on an account out of quota,
 * and producer capacity was the producer role. A worker session ends the way `settleSessions` and
 * the loop's `endRegistrySession` end it — with a reason and no run outcome; a headless producer
 * run ends with its outcome, `result`.
 */
const INSTANCES: { instance: string; role: FleetRoleName }[] = [
  { instance: 'GY-487', role: 'worker' }, { instance: 'GY-727', role: 'worker' }, { instance: 'GY-853', role: 'worker' }, { instance: 'producer capacity', role: 'producer' },
];

/** The provider, as the probes read it: per account a rolling `WINDOW` of `INCREMENT`s. */
function provider(accounts: string[]) {
  const uses = new Map(accounts.map(name => [name, [] as number[]]));
  const inWindow = (name: string, now: number) => uses.get(name)!.filter(at => at > now - WINDOW);
  return {
    use: (name: string, at: number) => { uses.get(name)!.push(at); },
    /** The account's windowed load in percent. */
    percent: (name: string, now: number) => inWindow(name, now).length * INCREMENT,
    /** The quota observation the executor folds in: spent from the ceiling up, with its reset. */
    quota: (name: string, now: number) => {
      const spent = inWindow(name, now), percent = spent.length * INCREMENT;
      if (percent < CEILING) return { loggedIn: true, state: 'available' as const, usage: [], resetsAt: null, reason: null };
      // The first instant enough of the window has aged out for the account to be spendable again.
      const ordered = [...spent].sort((a, b) => a - b);
      const resetsAt = new Date(ordered[ordered.length - (Math.ceil(CEILING / INCREMENT) - 1) - 1] + WINDOW).toISOString();
      return { loggedIn: true, state: 'exhausted' as const, usage: [{ window: '5h', percent, resetsAt }], resetsAt, reason: null };
    },
  };
}

const fleetFixture = () => applyRegistryMutation(emptyRegistry(), 'apply', {
  runtimes: ['claude', 'codex', 'opencode'].map(name => proposedRuntimes.find(runtime => runtime.name === name)!),
  models: [{ name: 'claude-default', id: null }, { name: 'codex-default', id: null }, { name: 'opencode-default', id: null }],
  accounts: ACCOUNTS.map((name, index) => ({ name, runtime: ['claude', 'codex', 'opencode'][index], model: `${['claude', 'codex', 'opencode'][index]}-default`, credential: { host: HOST, home: null } })),
  roles: [{ name: 'worker', accounts: ACCOUNTS, concurrency: 1 }, { name: 'producer', accounts: ACCOUNTS, concurrency: 1 }],
  reason: 'The fleet the four instances drained',
}, { actor: 'operator', at: new Date(START - HOUR).toISOString() }).registry;

/** The base policy: the first eligible account of the role, in the role's own order, nothing else. */
const firstFit = (registry: AgentRegistry, role: FleetRoleName, now: number): FleetAccount | null => {
  for (const name of registry.roles.find(entry => entry.name === role)!.accounts) {
    const account = registry.accounts.find(entry => entry.name === name)!;
    if (accountIneligibility(registry, account, now, HOST) ?? roleIneligibility(account, role, now)) continue;
    return account;
  }
  return null;
};

/** `midSession` counts sessions that ran their account past the ceiling while at work — the capacity fault each instance filed. */
interface Outcome { counts: Record<string, number>; midSession: number; refusals: number; longestPause: number; exhaustedReadings: number; peak: number }

/**
 * One instance run over the registry path: every launch folds fresh quota in, then asks for a
 * session, and every session has ended — as the role's sessions end in production — before the
 * next launch asks, so the rotation reads only ended sessions.
 */
function simulate(policy: 'base' | 'candidate', { instance, role }: { instance: string; role: FleetRoleName }): Outcome {
  const registry = fleetFixture(), spent = provider(ACCOUNTS);
  const counts = Object.fromEntries(ACCOUNTS.map(name => [name, 0]));
  let midSession = 0, refusals = 0, pause = 0, longestPause = 0, exhaustedReadings = 0, peak = 0;
  for (let launch = 0; launch < LAUNCHES; launch++) {
    const now = START + launch * STEP;
    for (const account of registry.accounts) account.quota = { ...spent.quota(account.name, now), observedAt: new Date(now).toISOString(), observedBy: 'master', source: 'probe' };
    exhaustedReadings += registry.accounts.filter(account => account.quota.state === 'exhausted').length;
    peak = Math.max(peak, ...registry.accounts.map(account => spent.percent(account.name, now)));
    for (const session of registry.sessions) {
      if (session.endedAt || Date.parse(session.selectedAt) + RUN > now) continue;
      const at = new Date(Date.parse(session.selectedAt) + RUN).toISOString();
      if (role === 'worker') endRegistrySession(registry, session, 'the lease is no longer held', undefined, at);
      else endRegistrySession(registry, session, 'the run exited', 'result', at);
    }
    const account = policy === 'candidate' ? chooseSession(registry, { role, host: HOST }, now).account : firstFit(registry, role, now);
    if (!account) { refusals++; pause++; longestPause = Math.max(longestPause, pause); continue; }
    pause = 0;
    spent.use(account.name, now);
    if (spent.percent(account.name, now) >= CEILING) midSession++;
    counts[account.name]++;
    // The choice recorded, as the control plane appends it — the rotation's memory of the role.
    registry.sessions.push({ id: randomUUID(), role, account: account.name, runtime: account.runtime, model: account.model, host: HOST, work: instance, principal: 'proof-runner', selectedAt: new Date(now).toISOString(), selectedBy: 'coordinator', reason: 'simulated', skipped: [], endedAt: null, endReason: null });
  }
  return { counts, midSession, refusals, longestPause, exhaustedReadings, peak };
}

test('unit:capacity-fault-class-spread — each GY-961 instance recurs against the base first-fit policy and not against the candidate: the registry spreads a role across its eligible accounts so none drains first (GY-961)', () => {
  for (const entry of INSTANCES) {
    const { instance } = entry, base = simulate('base', entry);
    assert.ok(base.midSession > 0, `${instance}: against the base sessions run their account out of quota mid-work (${base.midSession} of ${LAUNCHES})`);
    assert.ok(base.exhaustedReadings > 0, `${instance}: against the base accounts read out of quota at launch instants (${base.exhaustedReadings})`);
    const spread = Math.max(...Object.values(base.counts)) - Math.min(...Object.values(base.counts));
    assert.ok(spread > 4, `${instance}: against the base the load is first-fit, not spread (${JSON.stringify(base.counts)})`);

    const candidate = simulate('candidate', entry);
    assert.deepEqual(candidate.midSession, 0, `${instance}: against the candidate no session runs its account out of quota`);
    assert.deepEqual(candidate.refusals, 0, `${instance}: against the candidate every launch is selected`);
    assert.deepEqual(candidate.longestPause, 0, `${instance}: against the candidate the role never pauses`);
    assert.deepEqual(candidate.exhaustedReadings, 0, `${instance}: against the candidate no account ever reads out of quota`);
    assert.ok(candidate.peak < CEILING, `${instance}: the busiest account stays under the ceiling (${candidate.peak}%)`);
    assert.ok(Math.max(...Object.values(candidate.counts)) - Math.min(...Object.values(candidate.counts)) <= 1, `${instance}: the candidate spreads the same demand evenly (${JSON.stringify(candidate.counts)})`);
  }
});

/** A launch selection against the local profiles, with the registry answered 503 so the fallback path runs. */
const refused = (async () => new Response('unavailable', { status: 503 })) as unknown as typeof fetch;

async function localFixture(directory: string): Promise<MasterConfig> {
  const homes = join(directory, 'agents');
  await mkdir(join(homes, 'claude-a'), { recursive: true });
  await writeFile(join(homes, 'claude-a', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } }));
  await mkdir(join(homes, 'codex-a'), { recursive: true });
  await writeFile(join(homes, 'codex-a', 'auth.json'), JSON.stringify({ tokens: { access_token: 't' } }));
  await mkdir(join(homes, 'opencode-a', 'opencode'), { recursive: true });
  await writeFile(join(homes, 'opencode-a', 'opencode', 'auth.json'), JSON.stringify({ zai: {} }));
  return masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile: join(directory, 'coordinator.token'), cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main', githubAppId: 1,
    hostId: HOST, masterAgentName: 'graphyard-master-spread', autoMerge: true, mergeMethod: 'merge',
    environments: [
      { name: 'claude-a', kind: 'claude', home: join(homes, 'claude-a') },
      { name: 'codex-a', kind: 'codex', home: join(homes, 'codex-a') },
      { name: 'opencode-a', kind: 'opencode', home: join(homes, 'opencode-a') },
    ],
    producers: [{ name: 'produce-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'claude', credentialFile: join(directory, 'producers', 'proof-runner.token'), approvals: 'auto', environment: {}, accounts: ACCOUNTS }],
  });
}

/** One instance over the local profile path: a session that spends its account reports the limit (GY-89), and the account is held until it resets. */
async function simulateLocal(policy: 'base' | 'candidate', instance: string): Promise<Outcome> {
  const directory = await temporaryDirectory('capacity-spread');
  {
    const config = await localFixture(directory), spent = provider(ACCOUNTS);
    const counts = Object.fromEntries(ACCOUNTS.map(name => [name, 0]));
    let midSession = 0, refusals = 0, pause = 0, longestPause = 0, exhaustedReadings = 0, peak = 0;
    for (let launch = 0; launch < LAUNCHES; launch++) {
      const now = START + launch * STEP, at = new Date(now).toISOString();
      exhaustedReadings += Object.values(await observedExhaustions(config, now)).length;
      peak = Math.max(peak, ...ACCOUNTS.map(account => spent.percent(account, now)));
      const report = async (name: string) => {
        const after = spent.quota(name, now);
        if (after.state === 'exhausted') await recordObservedExhaustion(config, name, { at, resetsAt: after.resetsAt, reason: 'the session printed its provider limit', role: 'producer', profile: 'produce-a', work: instance }, now);
      };
      if (policy === 'base') {
        // The base policy: the first account of the profile that no hold bars — all logins read healthy here.
        const held = await observedExhaustions(config, now), name = ACCOUNTS.find(name => !held[name]);
        if (!name) { refusals++; pause++; longestPause = Math.max(longestPause, pause); continue; }
        spent.use(name, now);
        if (spent.percent(name, now) >= CEILING) midSession++;
        counts[name]++;
        await report(name);
        continue;
      }
      const selected = await selectAccount(config, 'producer', config.producers[0], { quota: false, now: () => now, cacheMs: 0, fetch: refused });
      const name = selected.account!.name;
      spent.use(name, now);
      if (spent.percent(name, now) >= CEILING) midSession++;
      counts[name]++;
      await report(name);
      pause = 0;
    }
    return { counts, midSession, refusals, longestPause, exhaustedReadings, peak };
  }
}

test('unit:capacity-fault-class-spread — the local profile path spreads the same way: each instance recurs against the base first-fit profile order and not against the candidate (GY-961)', async () => {
  for (const { instance } of INSTANCES) {
    const base = await simulateLocal('base', instance);
    assert.ok(base.midSession > 0, `${instance}: against the base sessions run their account out of quota mid-work (${base.midSession} of ${LAUNCHES})`);
    assert.ok(base.exhaustedReadings > 0, `${instance}: against the base accounts are held out of quota at launch instants (${base.exhaustedReadings})`);
    const spread = Math.max(...Object.values(base.counts)) - Math.min(...Object.values(base.counts));
    assert.ok(spread > 4, `${instance}: against the base the load is first-fit, not spread (${JSON.stringify(base.counts)})`);

    const candidate = await simulateLocal('candidate', instance);
    assert.deepEqual(candidate.midSession, 0, `${instance}: against the candidate no session runs its account out of quota`);
    assert.deepEqual(candidate.refusals, 0, `${instance}: against the candidate every launch is selected`);
    assert.deepEqual(candidate.exhaustedReadings, 0, `${instance}: against the candidate no account is ever held out of quota`);
    assert.ok(candidate.peak < CEILING, `${instance}: the busiest account stays under the ceiling (${candidate.peak}%)`);
    assert.ok(Math.max(...Object.values(candidate.counts)) - Math.min(...Object.values(candidate.counts)) <= 1, `${instance}: the candidate spreads the same demand evenly (${JSON.stringify(candidate.counts)})`);
  }
});
