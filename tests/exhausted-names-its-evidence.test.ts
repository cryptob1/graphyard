import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountIneligibility, chooseSession, emptyRegistry, fleetView, foldObservations, proposedRuntimes, type AgentRegistry, type QuotaObservation } from '../src/model/registry.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';

/**
 * GY-3094: the registry reported claude-a exhausted with no usage, no reset and no hold, and a master
 * took that at face value. An account reads exhausted only on evidence that still holds — its own
 * refused live request or an operator's mark (GY-3555) — and the report
 * names it with its reset; anything else reads unknown and stays selectable.
 */

const HOST = 'vishrog';
const now = Date.parse('2026-11-05T02:00:00Z');
const iso = (offset: number) => new Date(now + offset).toISOString();
const hour = 3_600_000;

function registryOf(names: string[]): AgentRegistry {
  return applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [proposedRuntimes.find(runtime => runtime.name === 'claude')!], models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: names.map(name => ({ name, runtime: 'claude', model: 'opus', plan: name, credential: { host: HOST, home: `/home/operator/.coding_agents/${name}` } })),
    roles: [{ name: 'master', accounts: names, concurrency: 1 }], reason: 'fixture',
  }, { actor: 'operator', at: iso(-2 * hour) }).registry;
}
const fold = (registry: AgentRegistry, account: string, quota: QuotaObservation, at = now) =>
  foldObservations(registry, { host: HOST, observations: [{ account, quota }] }, { actor: 'executor', at: new Date(at).toISOString() });
const view = (registry: AgentRegistry, name: string, at = now) => fleetView(registry, at, HOST).accounts.find(account => account.name === name)!;
const find = (registry: AgentRegistry, name: string) => registry.accounts.find(account => account.name === name)!;

test('unit:exhausted-names-its-evidence — the registry reports an account exhausted only with evidence, naming it and its reset; one with none reads unknown and stays selectable', () => {
  const registry = registryOf(['claude-a', 'claude-b', 'claude-c', 'claude-d']);
  const resetsAt = iso(5 * hour);
  // The account's own live request, refused by its provider (GY-3555: a usage window at the ceiling is no hold).
  fold(registry, 'claude-b', { loggedIn: true, state: 'exhausted', usage: [{ window: '7d', percent: 100, resetsAt }], resetsAt, reason: `You've hit your weekly limit`, since: iso(0), session: 'named' });
  assert.equal(view(registry, 'claude-b').quota, 'exhausted');
  assert.equal(view(registry, 'claude-b').evidence, `You've hit your weekly limit; resets ${resetsAt}`);
  // An operator's mark.
  const marked = applyRegistryMutation(registry, 'account.quota', { name: 'claude-c', quota: { state: 'exhausted', resetsAt }, reason: 'plan cut off' }, { actor: 'operator', at: iso(0) }).registry;
  assert.equal(view(marked, 'claude-c').evidence, `marked exhausted by an operator: plan cut off; resets ${resetsAt}`);

  // The incident: exhausted recorded with no usage, no reset and no hold reads unknown and is selectable.
  find(registry, 'claude-a').quota = { ...find(registry, 'claude-a').quota, loggedIn: true, state: 'exhausted', usage: [], resetsAt: null, reason: null, source: 'probe', observedAt: iso(-hour) };
  const a = view(registry, 'claude-a');
  assert.equal(a.quota, 'unknown');
  assert.equal(a.evidence, null);
  assert.equal(a.eligible, true, a.ineligible ?? '');
  const choice = chooseSession(registry, { role: 'master', host: HOST }, now);
  assert.equal(choice.account?.name, 'claude-a', choice.reason);
});

test('unit:empty-quota-read-is-unknown — a provider read that fails or returns no windows does not make an account with no hold exhausted, and a hold whose reset has passed clears at the next reading', () => {
  const registry = registryOf(['claude-a']);
  // A failed read, and an exhausted read naming no window, reset or hold: both unknown, both selectable.
  fold(registry, 'claude-a', { loggedIn: true, state: 'unknown', usage: [], resetsAt: null, reason: null });
  assert.equal(find(registry, 'claude-a').quota.state, 'unknown');
  fold(registry, 'claude-a', { loggedIn: true, state: 'exhausted', usage: [], resetsAt: null, reason: 'quota exceeded' });
  assert.equal(find(registry, 'claude-a').quota.state, 'unknown');
  assert.equal(accountIneligibility(registry, find(registry, 'claude-a'), now, HOST), null);

  // A refused live request stands through any reading that made no request; the next passing live request clears it (GY-3555).
  const resetsAt = iso(hour);
  fold(registry, 'claude-a', { loggedIn: true, state: 'exhausted', usage: [], resetsAt, reason: 'weekly limit', since: iso(0), session: 'named' });
  fold(registry, 'claude-a', { loggedIn: true, state: 'unknown', usage: [], resetsAt: null, reason: null }, now + 60_000);
  assert.equal(find(registry, 'claude-a').quota.state, 'exhausted');
  const after = Date.parse(resetsAt) + 60_000;
  fold(registry, 'claude-a', { loggedIn: true, state: 'available', usage: [], resetsAt: null, reason: null, since: new Date(after).toISOString() }, after);
  assert.equal(find(registry, 'claude-a').quota.state, 'available');
  assert.equal(accountIneligibility(registry, find(registry, 'claude-a'), after, HOST), null);

  // An operator's mark whose reset has passed holds nothing, and a newer live request replaces it.
  const marked = applyRegistryMutation(registry, 'account.quota', { name: 'claude-a', quota: { state: 'exhausted', resetsAt }, reason: 'plan cut off' }, { actor: 'operator', at: iso(0) }).registry;
  assert.equal(accountIneligibility(marked, find(marked, 'claude-a'), after, HOST), null);
  foldObservations(marked, { host: HOST, observations: [{ account: 'claude-a', quota: { loggedIn: true, state: 'available', usage: [], resetsAt: null, reason: null, since: new Date(after).toISOString() } }] }, { actor: 'executor', at: new Date(after).toISOString() });
  assert.equal(find(marked, 'claude-a').quota.state, 'available');
  assert.equal(find(marked, 'claude-a').quota.source, 'probe');
});
