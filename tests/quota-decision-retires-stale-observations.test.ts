import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, foldObservations, proposedRuntimes, type AgentRegistry } from '../src/model/registry.js';
import { heldOverlay, observedExhaustions, recordObservedExhaustion, registryHoldObservations, releaseOperatorClearedHolds } from '../src/master/environments.js';
import type { MasterConfig } from '../src/master/profiles.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3117: claude-c's 02:08:44Z "Usage limit reached" was charged to opencode-c; each time the master
// set opencode-c available, a probe or an account change replayed that same observation onto it.

test('unit:quota-decision-retires-stale-observations — an exhaustion observed before the master set an account available is never re-applied by a probe, smoke test or account change', async () => {
  const HOST = 'host-a', iso = (at: number) => new Date(at).toISOString(), t0 = Date.parse('2026-11-05T02:08:44Z');
  const runtime = proposedRuntimes.find(entry => entry.name === 'opencode')!;
  const account = { name: 'opencode-c', runtime: runtime.name, model: 'glm', credential: { host: HOST, home: '/home/fixture/opencode-c' } };
  let registry: AgentRegistry = applyRegistryMutation(emptyRegistry(), 'apply', { runtimes: [runtime], models: [{ name: 'glm', id: 'glm-5' }], accounts: [account], roles: [{ name: 'worker', accounts: ['opencode-c'], concurrency: 2 }], reason: 'fixture' }, { actor: 'operator', at: iso(t0 - 3_600_000) }).registry;

  // The host's stored hold: the misattributed notice, reset 13:00Z.
  const root = await temporaryDirectory('quota-decision-stale');
  const credentialFile = join(root, 'coordinator.token');
  await writeFile(credentialFile, 'token', { mode: 0o600 });
  const config = { credentialFile, hostId: HOST } as Pick<MasterConfig, 'credentialFile' | 'hostId'>;
  const hold = await recordObservedExhaustion(config, 'opencode-c', { at: iso(t0), resetsAt: '2026-11-05T13:00:00Z', reason: 'Usage limit reached · limit resets 1pm', role: 'worker', profile: 'builder', work: 'GY-1' }, t0);
  const replayed = heldOverlay({ 'opencode-c': hold }, 'opencode-c', { loggedIn: true, state: 'available', usage: [], resetsAt: null, reason: null });
  assert.equal(replayed.since, hold.at, 'a replayed hold names when it was observed');
  const [reported] = registryHoldObservations(registry, HOST, 'opencode-c', hold)!;
  assert.equal(reported.quota.since, hold.at);

  const fold = (quota: typeof replayed, at: number, smoke?: { result: 'passed'; reason: string }) =>
    foldObservations(registry, { host: HOST, observations: [{ account: 'opencode-c', quota, ...smoke ? { smoke } : {} }] }, { actor: 'master-loop', at: iso(at) });
  const quota = () => registry.accounts.find(entry => entry.name === 'opencode-c')!.quota;
  fold(replayed, t0 + 1_000);
  assert.equal(quota().state, 'exhausted', 'before any decision the hold applies');

  // 02:41Z: the master sets it available.
  const decided = t0 + 32 * 60_000;
  registry = applyRegistryMutation(registry, 'account.quota', { name: 'opencode-c', quota: { loggedIn: true, state: 'available' }, reason: 'misattributed notice' }, { actor: 'master', at: iso(decided) }).registry;
  fold(replayed, decided + 60_000);
  assert.equal(quota().state, 'available', 'a probe carrying the old hold does not re-apply it');
  fold({ ...reported.quota }, decided + 90_000, { result: 'passed', reason: 'smoke ok' });
  assert.equal(quota().state, 'available', 'nor does a smoke test, nor a report of the pending hold');

  // An ordinary probe moves the reading on; the decision still stands against the old observation.
  fold({ loggedIn: true, state: 'available', usage: [], resetsAt: null, reason: null }, decided + 120_000);
  assert.equal(quota().source, 'probe');
  fold(replayed, decided + 150_000);
  assert.equal(quota().state, 'available', 'after a probe replaced the operator reading');

  // 05:28Z: the master changes the account; the next probe still carries the old hold.
  registry = applyRegistryMutation(registry, 'account.set', { account: { ...account, model: 'glm' }, reason: 'reset account' }, { actor: 'master', at: iso(decided + 3 * 3_600_000) }).registry;
  fold(replayed, decided + 3 * 3_600_000 + 60_000);
  assert.equal(quota().state, 'available', 'after an account change');

  // The host releases its hold on the decision, though the registry reading is now a probe's.
  assert.deepEqual(await releaseOperatorClearedHolds(config, { 'opencode-c': hold }, registry, decided + 4 * 3_600_000), {});
  assert.equal((await observedExhaustions(config, decided + 4 * 3_600_000))['opencode-c'], undefined);

  // A notice observed after the decision still holds the account.
  fold({ ...replayed, since: iso(decided + 5 * 3_600_000) }, decided + 5 * 3_600_000 + 1_000);
  assert.equal(quota().state, 'exhausted', 'a fresh observation applies');
});
