import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  holdRepeatedLimitAccount, masterConfigSchema, recordEnvironmentLog,
  repeatedLimitAccount, selectAccount, selectionKey, sessionAccount, type MasterConfig,
} from '../src/master.js';
import type { FleetClient } from '../src/fleet.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { chooseSession, emptyRegistry, foldObservations, proposedRuntimes, type AgentRegistry, type FleetRoleName, type FleetSession } from '../src/model/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-3030: the control-plane registry is the only authority for exhaustion. An in-memory registry
 * on a fixed clock that folds an executor's observations as the control plane does, so a reported
 * hold is what the next selection reads.
 */
function memoryRegistry(host: string, at: number, accounts: { name: string; runtime: string; home: string }[], role: FleetRoleName) {
  const context = { actor: 'master', at: new Date(at).toISOString() };
  const registry: AgentRegistry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: proposedRuntimes.filter(runtime => accounts.some(account => account.runtime === runtime.name)), models: [{ name: 'default', id: null }],
    accounts: accounts.map(account => ({ name: account.name, runtime: account.runtime, model: 'default', credential: { host, home: account.home } })),
    roles: [{ name: role, accounts: accounts.map(account => account.name), concurrency: 4 }], reason: 'fixture',
  }, context).registry;
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    observe: async request => { foldObservations(registry, request, context); return { revision: registry.revision }; },
    select: async request => {
      foldObservations(registry, request, context);
      const choice = chooseSession(registry, request, at);
      if (!choice.account) return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision };
      const session: FleetSession = { id: `session-${registry.sessions.length + 1}`, role: request.role, account: choice.account.name, runtime: choice.runtime.name, model: choice.model.name, host: request.host,
        work: request.work, principal: request.principal, group: request.group, selectedAt: context.at, selectedBy: 'master', reason: choice.reason, skipped: choice.skipped, endedAt: null, endReason: null };
      registry.sessions.push(session);
      return { selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, policy: choice.policy, revision: registry.revision };
    },
    end: async () => {},
  };
  return client;
}

test('unit:hold-charged-to-selected-account — sessionAccount and repeatedLimit read the launch/selection account, never a nominal profile', async () => {
  const root = await temporaryDirectory('hold-charged');
  const credentialFile = join(root, 'coordinator.token');
  await writeFile(credentialFile, 'token', { mode: 0o600 });
  const config = { credentialFile } as Pick<MasterConfig, 'credentialFile'>;
  await recordEnvironmentLog(config, [], [], { key: selectionKey('reviewer', 'reviewer-a'), environment: 'claude-c', kind: 'claude', at: new Date().toISOString(), work: 'GY-1701' });
  await recordEnvironmentLog(config, [], [], { key: selectionKey('producer', 'producer'), environment: 'zai-a', kind: 'pi', at: new Date().toISOString(), work: null });
  assert.equal((await sessionAccount(root, config, 'reviewer', 'reviewer-a', { work: 'GY-1701' }))?.environment, 'claude-c');
  assert.equal((await sessionAccount(root, config, 'producer', 'producer'))?.environment, 'zai-a');
  const base = Date.now();
  const exhaustion = (requestId: string, offsetMs: number) => ({
    at: new Date(base + offsetMs).toISOString(), role: 'reviewer' as const, account: 'claude-c', profile: 'reviewer-a', reason: 'silent', resetsAt: null, requestId,
    recordedBy: 'loop', owner: null, runtime: 'claude', partialWork: { state: 'not-applicable' as const, detail: 'n/a' },
  });
  // Distinct sessions share one request id across failover relaunches — they still count.
  const work = { key: 'GY-1', epoch: 2, capacity: { spent: [], exhaustions: [exhaustion('same-decision', 0), exhaustion('same-decision', 60_000)] } };
  assert.equal(repeatedLimitAccount(work, base + 60_000, 'reviewer')?.account, 'claude-c');
  const duplicateReport = { key: 'GY-1', epoch: 2, capacity: { spent: [], exhaustions: [exhaustion('req-1', 0), exhaustion('req-1', 0)] } };
  assert.equal(repeatedLimitAccount(duplicateReport, base, 'reviewer'), null, 'the same instant reported twice is one session');
});

test('integration:no-repeat-launch-into-silent-account — holdRepeatedLimitAccount before selectAccount keeps a repeatedly spent pane account out of selection', async () => {
  const dir = await temporaryDirectory('pane-repeat-hold');
  const credentialFile = join(dir, 'coordinator.token');
  await writeFile(credentialFile, 'token', { mode: 0o600 });
  await mkdir(join(dir, 'env-a'), { recursive: true }); await mkdir(join(dir, 'env-b'), { recursive: true });
  await writeFile(join(dir, 'env-a/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'x' } }));
  await writeFile(join(dir, 'env-b/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'x' } }));
  const config = masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile, cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1, hostId: 'machine-a', masterAgentName: 'gy-master', autoMerge: true, mergeMethod: 'merge', workers: [],
    environments: [{ name: 'env-a', kind: 'claude', home: join(dir, 'env-a') }, { name: 'env-b', kind: 'claude', home: join(dir, 'env-b') }],
    reviewers: [{ name: 'reviewer-a', agentName: 'agent-reviewer-a', kind: 'claude', agentArgs: [], approvals: 'auto', environment: {}, accounts: ['env-a', 'env-b'] }],
  }) as MasterConfig;
  const base = Date.now();
  const exhaustion = (role: 'reviewer', offsetMs: number) => ({
    at: new Date(base + offsetMs).toISOString(), role, account: 'env-a', profile: 'reviewer-a', reason: 'quota', resetsAt: null,
    requestId: 'shared-request', recordedBy: 'loop', owner: null, runtime: 'claude', partialWork: { state: 'not-applicable' as const, detail: 'n/a' },
  });
  // Two spent reviewer sessions sharing one request id hold before selectAccount (the launchReview path).
  const reviewWork = { key: 'GY-1701', epoch: 2, capacity: { spent: [], exhaustions: [exhaustion('reviewer', 0), exhaustion('reviewer', 90_000)] } };
  assert.equal(repeatedLimitAccount(reviewWork, base + 90_000, 'reviewer')?.account, 'env-a');
  const at = base + 90_000;
  const registry = memoryRegistry('machine-a', at, ['env-a', 'env-b'].map(name => ({ name, runtime: 'claude', home: join(dir, name) })), 'reviewer');
  // holdRepeatedLimitAccount reads current holds through observedExhaustions, which only asks the
  // control plane over HTTP; with no URL it reads none and reports the hold to the injected registry.
  const reviewHold = await holdRepeatedLimitAccount({ ...config, url: undefined }, reviewWork, at, { registry }, 'reviewer');
  assert.equal(reviewHold?.account, 'env-a');
  assert.equal((await registry.document()).accounts.find(account => account.name === 'env-a')!.quota.state, 'exhausted', 'the hold is reported to the registry');
  const reviewProfile = config.reviewers[0]!;
  const reviewChosen = await selectAccount(config, 'reviewer', reviewProfile, { quota: false, cacheMs: 0, now: () => at, work: reviewWork.key, registry });
  assert.equal(reviewChosen.account?.name, 'env-b', 'launchReview\'s selectAccount path skips the repeatedly held reviewer account');
});
