import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { detectRuntimeExhaustion } from '../src/master/runtime-prompt.js';
import { providerLimit, zaiRateLimitHoldMs } from '../src/model/capacity.js';
import { masterConfigSchema, recordObservedExhaustion, selectAccount, type MasterConfig, type WorkerProfile } from '../src/master.js';
import type { FleetClient } from '../src/fleet.js';
import { applyRegistryMutation, chooseSession, emptyRegistry, foldObservations, proposedRuntimes, type AgentRegistry, type FleetSession } from '../src/model/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2943: a pi worker on Z.AI stopped on `Error: 429: {"code":"1302","message":"Rate limit reached
// for requests"}` and sat idle while its supervisor renewed the lease, because no capacity notice
// was read and no account was held. The notice is its provider saying the account is spent: the
// envelope (never the bare phrase an agent may write about a rate limit) is a limit signal, and —
// the notice naming no reset — the account is held for the default 15 minutes, so the fleet's next
// selection fails over.

/** The pane the incident ended on: the provider's answer, then pi giving up. Herdr read the session idle. */
const limitError = 'Error: 429: {"code":"1302","message":"Rate limit reached for requests"}';
const piPane = `● Reading GY-31 before editing.
  ⎿ Read 40 lines

${limitError}
Retry failed after 3 attempts: 429 …
`;
/** The fixed clock the parsers are handed (GY-1694): 2026-10-24T01:40:00Z as a millisecond epoch. */
const now = Date.parse('2026-10-24T01:40:00Z');

test('unit:zai-rate-limit-is-a-limit-notice — Z.AI\'s 429 "Rate limit reached" envelope is a limit signal held 15 minutes, and the fleet\'s next selection skips the account', async () => {
  const signal = detectRuntimeExhaustion(piPane, 'pi', now);
  assert.ok(signal, 'the 1302 envelope is an exhaustion');
  assert.match(signal.reason, /Rate limit reached for requests/, 'the notice is the reason');
  assert.equal(signal.resetsAt, new Date(now + zaiRateLimitHoldMs).toISOString(), 'the notice names no reset, so the account is held the default 15 minutes');
  assert.ok(Date.parse(signal.resetsAt!) >= now + 15 * 60_000, 'the reset is no earlier than 15 minutes ahead');
  // The headless path's parser carries the same signal for the same text.
  const headless = providerLimit(limitError, now);
  assert.ok(headless, 'the 429 envelope is a limit in a headless error too');
  assert.equal(headless.resetsAt, signal.resetsAt);
  // The bare phrase an agent may write about a rate limit is prose, never the envelope: unknown reset.
  assert.equal(detectRuntimeExhaustion('Rate limit reached for requests', 'codex', now)?.resetsAt, null);
  assert.equal(detectRuntimeExhaustion('I hit the rate limit reached case in the parser tests', 'pi', now), null);
  assert.equal(providerLimit('Error: 429: {"error":"the request id 42913 mentioned the rate limit"}', now)?.resetsAt, null, 'a 429 with no rate-limit envelope keeps its unknown reset');

  // The account the notice spent is held for the fleet's next selection: reported to the control-plane
  // registry with the signal's reset (the registry is the only authority for exhaustion, GY-3030),
  // selection fails over to the healthy account and refuses the held one outright.
  const root = await temporaryDirectory('zai-rate-limit');
  const credentialFile = join(root, 'coordinator.token');
  await writeFile(credentialFile, 't'.repeat(40), { mode: 0o600 });
  const worker = { name: 'builder', principal: 'worker-a', agentName: 'agent-builder', mode: 'launch', kind: 'claude', credentialFile: join(root, 'builder.token') } as unknown as WorkerProfile;
  const config = masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile, cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1, hostId: 'machine-a', masterAgentName: 'gy-master', workers: [worker],
  }) as MasterConfig;
  let clock = now;
  const fleet = zaiRegistry('machine-a', ['pi-a', 'pi-b'], () => clock);
  const probe = (client: FleetClient) => ({ registry: client, quota: false, cacheMs: 0, now: () => clock, work: 'GY-31' });
  await recordObservedExhaustion(config, 'pi-a', { at: new Date(now).toISOString(), resetsAt: signal.resetsAt, reason: signal.reason, role: 'worker', profile: 'builder', work: 'GY-31' }, now, { registry: fleet.client });
  const reported = (await fleet.client.document()).accounts.find(account => account.name === 'pi-a')!.quota;
  assert.equal(reported.state, 'exhausted', 'the registry holds the account the notice spent');
  assert.equal(reported.resetsAt, signal.resetsAt, 'held until the signal\'s 15-minute reset');
  assert.equal((await fleet.client.document()).accounts.find(account => account.name === 'pi-b')!.quota.state, 'unknown');
  const chosen = await selectAccount(config, 'worker', config.workers[0], probe(fleet.client));
  assert.equal(chosen.account?.name, 'pi-b', "the fleet's next selection fails over to the healthy account");
  await chosen.release!('test');
  const solo = zaiRegistry('machine-a', ['pi-a'], () => clock);
  await recordObservedExhaustion(config, 'pi-a', { at: new Date(now).toISOString(), resetsAt: signal.resetsAt, reason: signal.reason, role: 'worker', profile: 'builder', work: 'GY-31' }, now, { registry: solo.client });
  await assert.rejects(selectAccount(config, 'worker', config.workers[0], probe(solo.client)), /No healthy agent account for worker profile builder: .*pi-a/, 'a role with only the held account waits for its reset');
  clock = Date.parse(signal.resetsAt!) + 1;
  assert.equal((await selectAccount(config, 'worker', config.workers[0], probe(solo.client))).account?.name, 'pi-a', 'after the 15-minute reset the account is free again');
});

/** An in-memory registry with one claude account per name, all in the worker role, that folds the observations it is sent as the control plane does. */
function zaiRegistry(host: string, names: string[], clock: () => number) {
  const at = new Date(now).toISOString();
  let registry: AgentRegistry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude'), models: [{ name: 'default', id: null }],
    accounts: names.map(name => ({ name, runtime: 'claude', model: 'default', credential: { host, home: null } })),
    roles: [{ name: 'worker', accounts: names, concurrency: 4 }], reason: 'fixture',
  }, { actor: 'operator', at }).registry;
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    observe: async request => { foldObservations(registry, request, { actor: host, at: new Date(clock()).toISOString() }); return { revision: registry.revision }; },
    select: async request => {
      foldObservations(registry, request, { actor: host, at: new Date(clock()).toISOString() });
      const choice = chooseSession(registry, request, clock());
      if (!choice.account) return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision };
      const session: FleetSession = { id: `session-${registry.sessions.length + 1}`, role: request.role, account: choice.account.name, runtime: choice.runtime.name, model: choice.model.name, host: request.host,
        work: request.work, principal: request.principal, group: request.group, selectedAt: at, selectedBy: 'master', reason: choice.reason, skipped: choice.skipped, endedAt: null, endReason: null };
      registry = { ...registry, sessions: [...registry.sessions, session] };
      return { selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, policy: choice.policy, revision: registry.revision };
    },
    end: async (id, reason) => { registry = { ...registry, sessions: registry.sessions.map(session => session.id === id && !session.endedAt ? { ...session, endedAt: at, endReason: reason } : session) }; },
  };
  return { client };
}

