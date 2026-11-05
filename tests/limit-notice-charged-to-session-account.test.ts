import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { detectExhaustion, providerLimit } from '../src/model/capacity.js';
import { detectRuntimeExhaustion } from '../src/master/runtime-prompt.js';
import { observedExhaustions, recordEnvironmentLog, recordObservedExhaustion, releaseOperatorClearedHolds, releasedSince, selectionKey, type MasterConfig } from '../src/master/environments.js';
import { holdRepeatedLimitAccount, sessionAccount } from '../src/master/launch-account.js';
import type { AgentRegistry } from '../src/model/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3100: a claude-c session's "Usage limit reached" held opencode-c — the profile's latest
// selection — and the same notice held it again after the master set it available; a free
// model's own allowance marked an OpenCode plan spent.

test('unit:limit-notice-charged-to-session-account — a notice holds only its session\'s account, once, and a free-model notice holds no plan', async () => {
  const root = await temporaryDirectory('limit-notice-session-account');
  const credentialFile = join(root, 'coordinator.token');
  await writeFile(credentialFile, 'token', { mode: 0o600 });
  const config = { credentialFile, hostId: 'host-a' } as Pick<MasterConfig, 'credentialFile' | 'hostId'>;
  const now = Date.now(), iso = (at: number) => new Date(at).toISOString();

  // The profile launched GY-1 on claude-c, then GY-2 on opencode-c: GY-1's notice is claude-c's.
  await recordEnvironmentLog(config, [], [], { key: selectionKey('worker', 'builder'), environment: 'claude-c', kind: 'claude', at: iso(now - 60_000), work: 'GY-1' });
  await recordEnvironmentLog(config, [], [], { key: selectionKey('worker', 'builder'), environment: 'opencode-c', kind: 'opencode', at: iso(now - 30_000), work: 'GY-2' });
  assert.equal((await sessionAccount(root, config, 'worker', 'builder', { work: 'GY-1', epoch: 27 }))?.environment, 'claude-c');
  assert.equal(await sessionAccount(root, config, 'worker', 'builder', { work: 'GY-9', epoch: 1 }), null, 'a session with no selection of its own is charged to no other launch\'s account');

  // The hold stands until an operator sets the account available after it; then it is released and never re-applied.
  const hold = await recordObservedExhaustion(config, 'opencode-c', { at: iso(now - 10_000), resetsAt: null, reason: 'Usage limit reached', role: 'worker', profile: 'builder', work: 'GY-2' }, now - 10_000);
  const registry = (state: 'available' | 'exhausted', observedAt: number, source: 'operator' | 'probe' = 'operator') => ({ accounts: [{ name: 'opencode-c', credential: { host: 'host-a', home: null },
    quota: { loggedIn: true, state, usage: [], resetsAt: null, reason: null, observedAt: iso(observedAt), observedBy: 'master', source } }] }) as unknown as Pick<AgentRegistry, 'accounts'>;
  assert.ok((await releaseOperatorClearedHolds(config, { 'opencode-c': hold }, registry('available', now - 20_000), now))['opencode-c'], 'an operator mark older than the hold does not release it');
  assert.ok((await releaseOperatorClearedHolds(config, { 'opencode-c': hold }, registry('available', now, 'probe'), now))['opencode-c'], 'a probe is not an operator release');
  assert.deepEqual(await releaseOperatorClearedHolds(config, { 'opencode-c': hold }, registry('available', now), now), {});
  assert.equal((await observedExhaustions(config, now))['opencode-c'], undefined, 'the released hold is gone from the log');
  assert.equal(await releasedSince(config, 'opencode-c', iso(now - 10_000)), true, 'the notice already applied is not applied again');
  assert.equal(await releasedSince(config, 'opencode-c', iso(now + 1_000)), false, 'a notice printed after the release holds the account');

  // The repeated-limit hold reads the same notices again: after the release it places nothing.
  const exhaustion = (epoch: number, at: number) => ({ at: iso(at), role: 'worker' as const, epoch, account: 'opencode-c', profile: 'builder', reason: 'Usage limit reached', resetsAt: null,
    recordedBy: 'loop', owner: null, runtime: 'opencode', partialWork: { state: 'not-applicable' as const, detail: 'n/a' } });
  const work = { key: 'GY-2', epoch: 2, capacity: { spent: [], exhaustions: [exhaustion(1, now - 20_000), exhaustion(2, now - 10_000)] } };
  assert.equal(await holdRepeatedLimitAccount(config, work as any, now), null);
  assert.equal((await observedExhaustions(config, now))['opencode-c'], undefined);
  const later = { ...work, epoch: 3, capacity: { spent: [], exhaustions: [...work.capacity.exhaustions, exhaustion(3, now + 5_000)] } };
  assert.ok(await holdRepeatedLimitAccount(config, later as any, now + 6_000), 'a fresh notice after the release holds it again');

  // A free model's own allowance is not the account's plan.
  const free = 'Free usage limit reached. Upgrade or subscribe to OpenCode Go to keep using this model.';
  assert.equal(detectRuntimeExhaustion(`working...\n${free}\n`, 'opencode', now), null);
  assert.equal(detectExhaustion(`${free}\n`, now), null);
  assert.equal(providerLimit(free, now), null);
  assert.ok(detectRuntimeExhaustion('Usage limit reached · limit resets 1pm\n', 'claude', now), 'a plan notice still holds');
});
