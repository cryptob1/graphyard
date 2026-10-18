import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type MasterConfig, type WorkerProfile, atomicPrivateWrite, dispatchWork, inspectProfileAccounts, loadMasterConfig, preservePartialWork, recordObservedExhaustion, sessionAccount, setupMaster } from '../../src/master.js';
import { readProfileLaunchRecords } from '../../src/master/dispatch.js';
import { runCycle, type DaemonEffects, type DaemonState } from '../../src/master-daemon.js';
import type { Work } from '../../src/model.js';
import { FailoverWorld, launcher } from './soak-plane.js';
import { temporaryDirectory } from './temp-dirs.js';

/**
 * The repeated-limit loop (GY-1582): `runCycle` as `master run` wires it, on a real master root,
 * dispatching through the production `dispatchWork` and its production account choice, with Herdr
 * the failover day's world (tests/helpers/soak-plane.ts). Each account is a Claude home of its own
 * login; a session the test spends draws Claude's usage-limit menu and the loop's failover charges
 * the account its launch record names. The replay in tests/exhaustion-launch-account.test.ts and the
 * day in tests/soak-repeated-limit.test.ts both run on it.
 */

/**
 * Claude's usage-limit menu, as the 2026-10-09 sessions drew it; `reset` is as Claude prints it
 * ("Oct 12, 3pm"), or null for a notice that names none, which is held for the assumed hour.
 */
export const limitMenu = (reset: string | null) => `● Reading the item before editing.
  ⎿  You've hit your weekly limit${reset ? ` · resets ${reset} (America/Los_Angeles)` : ''}

   What do you want to do?

   ❯ 1. Stop and wait for limit to reset
     2. ${reset ? `Wait here, then continue automatically at ${reset}` : 'Wait here, then continue automatically'}
     3. Add funds to continue with usage credits

   Enter to confirm · Esc to cancel
`;
/** An instant as Claude's menu names it: the month, day and hour in America/Los_Angeles. */
export const losAngeles = (instant: Date) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', hour12: true }).formatToParts(instant).map(part => [part.type, part.value]));
  return `${parts.month} ${parts.day}, ${parts.hour}${parts.dayPeriod.toLowerCase()}`;
};

export interface LimitPlane {
  url: string;
  coordinatorToken: string;
  /** The control plane's API as a principal: `as` names the worker principal, else the coordinator calls. */
  api: (as: 'coordinator' | string, method: 'GET' | 'POST', path: string, body?: unknown) => Promise<any>;
}
/** A worker launch profile on the host: its principal must be a worker the plane knows, with `token`. */
export interface LimitProfile { name: string; principal: string; token: string; accounts: string[] }

/**
 * A master root whose accounts are Claude homes, each on the login `logins` names; an account in
 * `loggedOut` has a home and no credentials until `login` writes them.
 */
export async function limitHost(plane: LimitPlane, profiles: LimitProfile[], logins: Record<string, string>, loggedOut: string[] = []) {
  const root = await temporaryDirectory('limit-loop-master'), credentials = await temporaryDirectory('limit-loop-credentials'), homes = await temporaryDirectory('limit-loop-homes');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const status = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
  await setupMaster(root, { url: plane.url, token: plane.coordinatorToken, cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'w1', hostId: 'limit-host' }, status as typeof fetch);
  const login = async (account: string) => {
    await writeFile(join(homes, account, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'not-a-real-token', refreshToken: 'not-a-real-token' } }), { mode: 0o600 });
    await writeFile(join(homes, account, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: `${logins[account]}-account`, organizationUuid: `${logins[account]}-org` } }));
  };
  for (const account of Object.keys(logins)) { await mkdir(join(homes, account), { recursive: true }); if (!loggedOut.includes(account)) await login(account); }
  const workers: WorkerProfile[] = [];
  for (const profile of profiles) {
    const credentialFile = join(credentials, `${profile.name}.token`);
    await writeFile(credentialFile, profile.token, { mode: 0o600 });
    workers.push({ name: profile.name, principal: profile.principal, agentName: `graphyard-${profile.name}`, mode: 'launch', kind: 'claude', credentialFile, agentArgs: [], approvals: 'auto', environment: {}, accounts: profile.accounts } as WorkerProfile);
  }
  const base = await loadMasterConfig(root);
  await atomicPrivateWrite(join(root, '.graphyard/master.json'), { ...base, environments: Object.keys(logins).map(name => ({ name, kind: 'claude', home: join(homes, name) })), workers });
  return { root, config: await loadMasterConfig(root), login };
}

/** One real dispatch the loop made: the attempt and the account its launch record names. */
export interface LimitLaunch { key: string; epoch: number; account: string | null; pane: string; profile: string; at: number }
const settlementToken = 'e'.repeat(64);

/**
 * The loop over `host`: the dispatch is the production `dispatchWork` (claiming and registering the
 * attempt's workspace through the plane, as the launcher's preparer does), and a session the test
 * spends with `spend` blocks on Claude's limit menu for the loop to fail over.
 */
export function limitLoop(plane: LimitPlane, host: Awaited<ReturnType<typeof limitHost>>) {
  const world = new FailoverWorld(new Set());
  const output = new Map<string, string>(), launches: LimitLaunch[] = [], refused: { key: string; error: string }[] = [], stopped: string[] = [];
  const principalOf = (profile: WorkerProfile) => profile.principal;
  const dispatch: DaemonEffects['dispatch'] = async (work, profile, free, snapshot) => {
    let epoch = 0;
    const result = await dispatchWork(host.root, work, profile, free, world.run, snapshot.work,
      async () => {
        const claimed = await plane.api(principalOf(profile), 'POST', `work/${work.id}/claim`, {}) as Work;
        epoch = claimed.epoch!;
        const path = await temporaryDirectory(`limit-loop-${work.key}-${epoch}`);
        execFileSync('git', ['-C', path, 'init', '-q', '-b', `graphyard/${work.key.toLowerCase()}-${epoch}`]);
        await writeFile(join(path, 'README.md'), 'base\n');
        execFileSync('git', ['-C', path, 'add', '-A']);
        execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base']);
        await plane.api(principalOf(profile), 'POST', `work/${work.id}/workspace`, { epoch, host: 'limit-host', path, branch: `graphyard/${work.key.toLowerCase()}-${epoch}` });
        return { epoch, path, base: execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
      },
      async (_root, _key, claimedEpoch) => { await plane.api(principalOf(profile), 'POST', `work/${work.id}/release`, { epoch: claimedEpoch }); },
      5_000, snapshot.now, { start: world.bounds(), agents: () => world.herdr.list(), supervisor: () => false, stopSupervisor: () => true, readMergeWriter: world.readMergeWriter, credential: world.mint, probe: { quota: false, cacheMs: 0 } })
      .catch((error: unknown) => { refused.push({ key: work.key, error: error instanceof Error ? error.message : String(error) }); throw error; });
    // The attempt's supervisor records its containment scope, as `graphyard watch` does once it runs.
    await plane.api(principalOf(profile), 'POST', `work/${work.id}/quarantine`, { epoch, settlementHash: createHash('sha256').update(settlementToken).digest('hex'), scope: { unit: `graphyard-watch-4242-${randomUUID()}.scope`, pid: 4242 } });
    world.herdr.status(result.pane!, 'working');
    const record = (await readProfileLaunchRecords(host.root, [profile]))[profile.name];
    launches.push({ key: work.key, epoch, account: record?.key === work.key && record.epoch === epoch ? record.account : null, pane: result.pane!, profile: profile.name, at: Date.now() });
    return { key: work.key, epoch, pane: result.pane!, agentName: profile.agentName };
  };
  const effects: DaemonEffects = {
    agents: () => world.herdr.list(),
    herdr: () => ({ agents: world.herdr.list(), available: true }),
    credentials: () => inspectProfileAccounts(host.config, 'worker', host.config.workers, Object.fromEntries(host.config.workers.map(profile => [profile.name, { available: true, reason: null as string | null }])), { quota: false, cacheMs: 0 }),
    snapshot: async () => { const snapshot = await plane.api('coordinator', 'GET', 'work-snapshot'); return { work: snapshot.work as Work[], now: snapshot.now }; },
    closeSession: pane => { if (world.herdr.agents.has(pane)) world.herdr.close(pane); },
    dispatch,
    requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'no deployment endpoint in this test', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
    sessionOutput: agent => output.get(agent.pane_id ?? '') ?? `● Working as ${agent.name}…\n`,
    answerSession: () => { throw new Error('the loop never answers the limit menu'); },
    reportCapacity: (work, event) => plane.api('coordinator', 'POST', `work/${work.id}/capacity`, event) as Promise<Work>,
    // The production failover wiring (daemonEffects): the account from the attempt's own launch record.
    selectedAccount: (role, profile, launch) => sessionAccount(host.root, host.config, role, profile, launch),
    holdAccount: (account, observed) => recordObservedExhaustion(host.config, account, observed),
    preserveWork: async (work, epoch) => preservePartialWork(work.workspaces.find(entry => entry.epoch === epoch)!.path, `${work.key} attempt ${epoch} interrupted by provider quota exhaustion`),
    stopSupervisor: async orphan => {
      stopped.push(`${orphan.key}:${orphan.epoch}`);
      for (const agent of world.herdr.list().filter(entry => entry.name === orphan.agentName)) world.herdr.close(agent.pane_id!);
      await plane.api(principalOf(host.config.workers.find(profile => profile.agentName === orphan.agentName)!), 'POST', `work/${orphan.id}/settle`, { epoch: orphan.epoch, settlementToken });
    },
  };
  /** The launch's session stops on Claude's limit menu naming `reset` (or none), for the next cycle to read. */
  const spend = (launch: LimitLaunch, reset: string | null) => { world.herdr.status(launch.pane, 'blocked'); output.set(launch.pane, limitMenu(reset)); };
  /** The launch's attempt ends with no limit notice: its supervisor settles, the worker releases the item, and the session exits. */
  const end = async (launch: LimitLaunch) => {
    const work = ((await plane.api('coordinator', 'GET', 'work-snapshot')).work as Work[]).find(entry => entry.key === launch.key)!;
    const principal = principalOf(host.config.workers.find(profile => profile.name === launch.profile)!);
    await plane.api(principal, 'POST', `work/${work.id}/settle`, { epoch: launch.epoch, settlementToken });
    await plane.api(principal, 'POST', `work/${work.id}/release`, { epoch: launch.epoch });
    stopped.push(`${launch.key}:${launch.epoch}`);
    if (world.herdr.agents.has(launch.pane)) world.herdr.close(launch.pane);
  };
  return { world, launches, refused, stopped, effects, dispatch, spend, end, cycle: (state: DaemonState) => runCycle(host.config, state, effects) };
}
