import type { FleetClient } from '../../src/fleet.js';
import { applyRegistryMutation } from '../../src/model-boundary/registry.js';
import { chooseSession, emptyRegistry, proposedRuntimes, type AgentRegistry, type FleetRoleName, type FleetSession } from '../../src/model/registry.js';

/**
 * An in-memory control-plane registry for tests that launch a session: the registry is the only
 * authority for slots and accounts, so every launch needs one. One account per runtime named, on
 * `host` (login `home`, default none), in every role named.
 */
export function registryFixture(host: string, runtimes: string[], roles: FleetRoleName[] = ['worker'], concurrency = 4, home: string | null = null) {
  const at = new Date().toISOString();
  let registry: AgentRegistry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: proposedRuntimes.filter(runtime => runtimes.includes(runtime.name)), models: [{ name: 'default', id: null }],
    accounts: runtimes.map(runtime => ({ name: `${runtime}-fixture`, runtime, model: 'default', credential: { host, home } })),
    roles: roles.map(name => ({ name, accounts: runtimes.map(runtime => `${runtime}-fixture`), concurrency })), reason: 'fixture',
  }, { actor: 'operator', at }).registry;
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    select: async request => {
      const choice = chooseSession(registry, request, Date.now());
      if (!choice.account) return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision };
      const session: FleetSession = { id: `session-${registry.sessions.length + 1}`, role: request.role, account: choice.account.name, runtime: choice.runtime.name, model: choice.model.name, host: request.host,
        work: request.work, principal: request.principal, group: request.group, selectedAt: at, selectedBy: 'master', reason: choice.reason, skipped: choice.skipped, endedAt: null, endReason: null };
      registry = { ...registry, sessions: [...registry.sessions, session] };
      return { selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, policy: choice.policy, revision: registry.revision };
    },
    end: async (id, reason) => { registry = { ...registry, sessions: registry.sessions.map(session => session.id === id && !session.endedAt ? { ...session, endedAt: new Date().toISOString(), endReason: reason } : session) }; },
    observe: async () => ({ revision: registry.revision }) as never,
  };
  return { client, probe: { registry: client, quota: false, cacheMs: 0 } as const, sessions: () => registry.sessions };
}
