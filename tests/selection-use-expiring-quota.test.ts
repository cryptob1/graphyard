import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { chooseSession, emptyRegistry, proposedRuntimes, type AgentRegistry } from '../src/model/registry.js';

const at = '2026-11-08T12:00:00.000Z', now = Date.parse(at), minute = 60_000, HOST = 'build-host-1';
const runtime = proposedRuntimes.find(entry => entry.name === 'claude')!;

/** Two eligible accounts for worker, `first` preferred; the second carries the 5-hour window given, if any. */
function fleet(window: { percent: number; resetsIn: number } | null): AgentRegistry {
  let registry = emptyRegistry();
  const change = (kind: Parameters<typeof applyRegistryMutation>[1], input: unknown) => { registry = applyRegistryMutation(registry, kind, input, { actor: 'operator', at }).registry; };
  change('apply', { runtimes: [runtime], models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: ['first', 'second'].map(name => ({ name, runtime: 'claude', model: 'opus', credential: { host: HOST, home: `/agents/${name}` } })),
    roles: [{ name: 'worker', accounts: ['first', 'second'], concurrency: 4 }], reason: 'fixture' });
  for (const account of registry.accounts) account.quota = { ...account.quota, loggedIn: true, state: 'available' };
  if (window) {
    const resetsAt = new Date(now + window.resetsIn).toISOString();
    registry.accounts[1].quota.usage = [{ window: '5h', percent: window.percent, resetsAt }, { window: '7d', percent: 20, resetsAt: new Date(now + 3 * 86_400_000).toISOString() }];
  }
  return registry;
}
const pick = (registry: AgentRegistry) => chooseSession(registry, { role: 'worker', host: HOST }, now);

test('unit:tests/selection-use-expiring-quota.test.ts — a window resetting within the hour with at least 30% unused is spent first, and the reason names its reset', () => {
  const resetsAt = new Date(now + 30 * minute).toISOString();
  const choice = pick(fleet({ percent: 40, resetsIn: 30 * minute }));
  assert.equal(choice.account?.name, 'second');
  assert.match(choice.reason, new RegExp(`second is the first eligible account for worker \\(preference 2 of 2.*chosen first: its 5h window resets at ${resetsAt} with 60% unused`));

  for (const [label, window] of [['80% used', { percent: 80, resetsIn: 30 * minute }], ['resetting in 3 hours', { percent: 40, resetsIn: 180 * minute }], ['no readings', null]] as const) {
    const today = pick(fleet(window));
    assert.equal(today.account?.name, 'first', `${label}: the role's first account serves as today`);
    assert.doesNotMatch(today.reason, /chosen first/);
  }
});
