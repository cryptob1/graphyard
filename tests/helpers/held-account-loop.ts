import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema, type MasterConfig } from '../../src/master.js';
import { type DaemonEffects, daemonEffects, emptyDaemonState, runCycle } from '../../src/master-daemon.js';
import { applyRegistryMutation, chooseSession, emptyRegistry, foldObservations, proposedRuntimes, type AgentRegistry, type FleetSession } from '../../src/model/registry.js';

/**
 * GY-1574: the loop as it reports account holds. `runCycle` drives the effects the loop runs on,
 * whose snapshot is `daemonEffects`' own, so every cycle resends a hold the agent registry has not
 * heard of exactly as production does (src/daemon/effects.ts), against a control plane held in memory
 * that can be taken down, made to hang, or brought back. The planner, acceptance, doctor and
 * diagnostician select their accounts through the same control plane.
 */

export const HOST = 'vishrog';
const launcher = fileURLToPath(new URL('../../bin/graphyard.mjs', import.meta.url));
const token = `${'t'.repeat(40)}\n`;

/** Claude login homes as Claude Code writes them: `claude-a` and `claude` on one subscription, `claude-c` on another. */
export async function claudeHomes(root: string, expiresAt: number) {
  const login = async (name: string, id: string) => {
    const home = join(root, name);
    await mkdir(home, { recursive: true });
    await writeFile(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `access-${name}`, refreshToken: `refresh-${name}`, expiresAt } }));
    await writeFile(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: id, organizationUuid: `org-${id}` } }));
    return home;
  };
  return { 'claude-a': await login('claude-a', 'account-1'), claude: await login('claude', 'account-1'), 'claude-c': await login('claude-c', 'account-2') };
}

export async function loopConfig(root: string): Promise<MasterConfig> {
  const credentialFile = join(root, 'coordinator.token');
  await writeFile(credentialFile, token, { mode: 0o600 });
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: HOST,
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], operatorAgent: { id: 'graphyard-operator', credentialFile }, approver: { id: 'graphyard-approver', credentialFile } });
}

export function registryOf(accounts: { name: string; home: string; host?: string }[], roles: { name: string; accounts: string[] }[], at: string): AgentRegistry {
  return applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [proposedRuntimes.find(runtime => runtime.name === 'claude')!], models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: accounts.map(account => ({ name: account.name, runtime: 'claude', model: 'opus', credential: { host: account.host ?? HOST, home: account.home } })),
    roles: roles.map(role => ({ ...role, concurrency: 4 })), reason: 'fixture',
  }, { actor: 'operator', at }).registry;
}

export type ControlPlaneMode = 'up' | 'down' | 'hanging';
/**
 * The agent registry's routes, in memory. `mode` decides how an observe is answered: `down` answers
 * 503, `hanging` never answers (the caller's own timeout ends it), `up` folds it into the registry.
 * Every observe is counted with the accounts it named and whether it was delivered.
 */
export function controlPlane(registry: { current: AgentRegistry }) {
  const plane = { mode: 'up' as ControlPlaneMode, observes: [] as { accounts: string[]; delivered: boolean; bounded: boolean }[] };
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname, body = init?.body ? JSON.parse(String(init.body)) : undefined, at = { actor: 'executor', at: new Date().toISOString() };
    if (path === '/api/agent-registry/observe') {
      const seen = { accounts: (body.observations as { account: string }[]).map(entry => entry.account), delivered: plane.mode === 'up', bounded: !!init?.signal };
      plane.observes.push(seen);
      if (plane.mode === 'hanging') return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)));
      if (plane.mode === 'down') return new Response('{"error":"unavailable"}', { status: 503 });
      foldObservations(registry.current, body, at);
      return json(registry.current);
    }
    if (path === '/api/agent-registry/document') return json(registry.current);
    if (path.startsWith('/api/agent-registry/sessions/')) {
      const id = path.split('/')[4];
      registry.current = { ...registry.current, sessions: registry.current.sessions.map(session => session.id === id ? { ...session, endedAt: at.at, endReason: body.reason } : session) };
      return json({});
    }
    if (path === '/api/agent-registry/select') {
      foldObservations(registry.current, body, at);
      const choice = chooseSession(registry.current, body, Date.now());
      if (!choice.account) return json({ selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.current.revision });
      const session: FleetSession = { id: crypto.randomUUID(), role: body.role, account: choice.account.name, runtime: choice.runtime.name, model: choice.model.name, host: HOST, work: body.work, principal: body.principal, group: body.group,
        selectedAt: at.at, selectedBy: 'coordinator', reason: choice.reason, skipped: choice.skipped, endedAt: null, endReason: null };
      registry.current = { ...registry.current, sessions: [...registry.current.sessions, session], revision: registry.current.revision + 1 };
      return json({ selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, policy: choice.policy, revision: registry.current.revision });
    }
    // Anything else (a provider usage read) is not served here.
    return new Response('{"error":"not here"}', { status: 404 });
  }) as typeof fetch;
  return Object.assign(plane, { fetcher });
}

/**
 * The real loop over no work: each `cycle()` is one `runCycle` whose snapshot is the one
 * `daemonEffects` builds for `config`, so the pending-hold report runs where production runs it.
 */
export function heldAccountLoop(config: MasterConfig, root: string, fetcher: typeof fetch) {
  const real = daemonEffects(root, config, { snapshot: async () => ({ work: [], now: new Date().toISOString() }), mutate: async () => ({}), fetcher });
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: real.snapshot,
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
  } as unknown as DaemonEffects;
  const state = emptyDaemonState(config);
  return { state, cycle: () => runCycle(config, state, effects, Date.now) };
}
