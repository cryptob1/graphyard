import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { detectExhaustion, providerLimit } from '../src/model/capacity.js';
import { detectRuntimeExhaustion } from '../src/master/runtime-prompt.js';
import { observedExhaustions, recordEnvironmentLog, recordObservedExhaustion, selectionKey } from '../src/master/environments.js';
import type { MasterConfig } from '../src/master/profiles.js';
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
  // Imported here so the file loads on a tree without it, failing as this test case.
  const { releasedSince } = await import('../src/master/environments.js') as unknown as Record<string, (...args: any[]) => Promise<any>>;

  // The profile launched GY-1 on claude-c, then GY-2 on opencode-c: GY-1's notice is claude-c's.
  await recordEnvironmentLog(config, [], [], { key: selectionKey('worker', 'builder'), environment: 'claude-c', kind: 'claude', at: iso(now - 60_000), work: 'GY-1' });
  await recordEnvironmentLog(config, [], [], { key: selectionKey('worker', 'builder'), environment: 'opencode-c', kind: 'opencode', at: iso(now - 30_000), work: 'GY-2' });
  assert.equal((await sessionAccount(root, config, 'worker', 'builder', { work: 'GY-1', epoch: 27 }))?.environment, 'claude-c');
  assert.equal(await sessionAccount(root, config, 'worker', 'builder', { work: 'GY-9', epoch: 1 }), null, 'a session with no selection of its own is charged to no other launch\'s account');

  // The hold stands until an operator sets the account available after it in the registry; a notice printed before that is never re-applied.
  const registry = (state: 'available' | 'exhausted', observedAt: number, source: 'operator' | 'probe' = 'operator') => ({ runtimes: [], accounts: [{ name: 'opencode-c', credential: { host: 'host-a', home: null },
    quota: { loggedIn: true, state, usage: [], resetsAt: null, reason: null, observedAt: iso(observedAt), observedBy: 'master', source } }] }) as unknown as AgentRegistry;
  const observed: unknown[] = [];
  const client = (document: AgentRegistry) => ({ document: async () => document, observe: async (request: unknown) => { observed.push(request); return document; } }) as never;
  const hold = await recordObservedExhaustion(config, 'opencode-c', { at: iso(now - 10_000), resetsAt: null, reason: 'Usage limit reached', role: 'worker', profile: 'builder', work: 'GY-2' }, now - 10_000, { registry: client(registry('exhausted', now - 10_000, 'probe')) });
  assert.equal(observed.length, 1, 'the notice is reported to the registry');
  assert.equal(await releasedSince(config, 'opencode-c', hold.at, client(registry('available', now - 20_000))), false, 'an operator mark older than the hold does not release it');
  assert.equal(await releasedSince(config, 'opencode-c', hold.at, client(registry('available', now, 'probe'))), false, 'a probe is not an operator release');
  const released = client(registry('available', now));
  assert.equal(await releasedSince(config, 'opencode-c', hold.at, released), true, 'the notice already applied is not applied again');
  assert.equal((await observedExhaustions(config, now, released))['opencode-c'], undefined, 'the registry no longer holds it');
  assert.equal(await releasedSince(config, 'opencode-c', iso(now + 1_000), released), false, 'a notice printed after the release holds the account');

  // The repeated-limit hold reads the same notices again: after the release it places nothing.
  const exhaustion = (epoch: number, at: number) => ({ at: iso(at), role: 'worker' as const, epoch, account: 'opencode-c', profile: 'builder', reason: 'Usage limit reached', resetsAt: null,
    recordedBy: 'loop', owner: null, runtime: 'opencode', partialWork: { state: 'not-applicable' as const, detail: 'n/a' } });
  const work = { key: 'GY-2', epoch: 2, capacity: { spent: [], exhaustions: [exhaustion(1, now - 20_000), exhaustion(2, now - 10_000)] } };
  observed.length = 0;
  assert.equal(await holdRepeatedLimitAccount(config, work as any, now, { registry: released }), null);
  assert.equal(observed.length, 0, 'nothing is reported');
  const later = { ...work, epoch: 3, capacity: { spent: [], exhaustions: [...work.capacity.exhaustions, exhaustion(3, now + 5_000)] } };
  assert.ok(await holdRepeatedLimitAccount(config, later as any, now + 6_000, { registry: released }), 'a fresh notice after the release holds it again');
  assert.equal(observed.length, 1);

  // A free model's own allowance is not the account's plan.
  const free = 'Free usage limit reached. Upgrade or subscribe to OpenCode Go to keep using this model.';
  assert.equal(detectRuntimeExhaustion(`working...\n${free}\n`, 'opencode', now), null);
  assert.equal(detectExhaustion(`${free}\n`, now), null);
  assert.equal(providerLimit(free, now), null);
  assert.ok(detectRuntimeExhaustion('Usage limit reached · limit resets 1pm\n', 'claude', now), 'a plan notice still holds');
});
