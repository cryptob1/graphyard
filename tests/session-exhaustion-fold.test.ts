import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldObservation, type ObservedExhaustion } from '../src/master/environments.js';
import { accountIneligibility, applyRegistryMutation, emptyRegistry, foldObservations, proposedRuntimes, type AgentRegistry, type QuotaObservation } from '../src/model/registry.js';

/**
 * GY-1581: a session that ran out mid-work reports its account exhausted until the reset it named
 * (GY-1573). That report is folded like a probe's, so the next ordinary probe, which reads quota
 * unknown on a spent Claude login, used to replace it and lift the hold on the account and on its
 * shared-login twin before the reset. The report now stands until that reset.
 */

const HOST = 'vishrog';
const spentAt = Date.parse('2026-10-09T05:30:28Z');
const resetsAt = new Date(Date.UTC(2026, 9, 11, 5)).toISOString();
const shared = 'claude:' + 'a'.repeat(32);
const held: ObservedExhaustion = { at: new Date(spentAt).toISOString(), until: resetsAt, resetsAt, reason: `You've hit your weekly limit`, role: 'worker', profile: 'worker', work: 'GY-1571', identity: shared };
const probe: QuotaObservation = { loggedIn: true, state: 'unknown', usage: [], resetsAt: null, reason: null, identity: shared };

function registryOf(names: string[], plan?: string): AgentRegistry {
  return applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [proposedRuntimes.find(runtime => runtime.name === 'claude')!], models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: names.map(name => ({ name, runtime: 'claude', model: 'opus', ...plan ? { plan } : {}, credential: { host: HOST, home: `/home/operator/.coding_agents/${name}` } })),
    roles: [{ name: 'worker', accounts: names, concurrency: 4 }], reason: 'fixture',
  }, { actor: 'operator', at: new Date(spentAt - 3_600_000).toISOString() }).registry;
}
const fold = (registry: AgentRegistry, observations: { account: string; quota: QuotaObservation }[], at: number) =>
  foldObservations(registry, { host: HOST, observations }, { actor: 'executor', at: new Date(at).toISOString() });
const ineligible = (registry: AgentRegistry, name: string, at: number) => accountIneligibility(registry, registry.accounts.find(account => account.name === name)!, at, HOST);

test('unit:session-exhaustion-survives-later-probe — a session-reported exhausted mark stands against a later ordinary probe until the reset that session named, holding its shared-login twin too; a probe after the reset replaces it', () => {
  const registry = registryOf(['claude-a', 'claude']);
  fold(registry, [{ account: 'claude-a', quota: heldObservation('claude-a', held) }, { account: 'claude', quota: probe }], spentAt);
  const before = Date.parse(resetsAt) - 60_000;
  assert.match(ineligible(registry, 'claude-a', spentAt + 60_000) ?? '', /exhausted/);

  // A later ordinary probe, even one reading the account available on a new login, does not replace the report before its reset.
  assert.equal(fold(registry, [{ account: 'claude-a', quota: probe }, { account: 'claude', quota: probe }], spentAt + 120_000), false, 'a probe restating the login changes nothing');
  fold(registry, [{ account: 'claude-a', quota: { ...probe, state: 'available', identity: 'claude:' + 'c'.repeat(32) } }], before);
  const spent = registry.accounts.find(account => account.name === 'claude-a')!.quota;
  assert.equal(spent.state, 'exhausted');
  assert.equal(spent.resetsAt, resetsAt);
  assert.equal(spent.identity, shared, 'the hold keeps the login it was reported on');
  assert.match(ineligible(registry, 'claude-a', before) ?? '', /claude-a quota is exhausted/);
  assert.equal(ineligible(registry, 'claude', before), `claude quota is exhausted until ${resetsAt}: it is the same provider login as claude-a, whose quota is exhausted (${spent.reason})`);

  // A probe after the named reset replaces it, and the twin is free.
  const after = Date.parse(resetsAt) + 60_000;
  assert.equal(fold(registry, [{ account: 'claude-a', quota: { ...probe, state: 'available' } }], after), true);
  const read = registry.accounts.find(account => account.name === 'claude-a')!.quota;
  assert.equal(read.state, 'available');
  assert.equal(read.session, undefined, 'the probe holds nothing after the reset');
  assert.equal(ineligible(registry, 'claude-a', after), null);
  assert.equal(ineligible(registry, 'claude', after), null);
});

test('a probe-read exhaustion is still replaced by a later probe before its reset, and a newer session report replaces an older one', () => {
  const registry = registryOf(['claude-a']);
  fold(registry, [{ account: 'claude-a', quota: { ...probe, state: 'exhausted', resetsAt } }], spentAt);
  fold(registry, [{ account: 'claude-a', quota: { ...probe, state: 'available' } }], spentAt + 60_000);
  assert.equal(registry.accounts[0]!.quota.state, 'available');

  const later = new Date(Date.parse(resetsAt) + 86_400_000).toISOString();
  fold(registry, [{ account: 'claude-a', quota: heldObservation('claude-a', held) }], spentAt + 120_000);
  fold(registry, [{ account: 'claude-a', quota: heldObservation('claude-a', { ...held, until: later, resetsAt: later }) }], spentAt + 180_000);
  assert.equal(registry.accounts[0]!.quota.resetsAt, later);
});

test('unit:session-exhaustion-survives-later-probe — on an explicitly shared plan, a later probe of another account reading available does not outrank the session-reported mark: the spent account and its plan stay held until the named reset', () => {
  const registry = registryOf(['claude-a', 'claude-b'], 'team-max');
  const other = 'claude:' + 'b'.repeat(32);
  fold(registry, [{ account: 'claude-a', quota: heldObservation('claude-a', held) }, { account: 'claude-b', quota: { ...probe, identity: other } }], spentAt);
  const before = Date.parse(resetsAt) - 60_000;
  // The plan's newest probe reads claude-b available, after the session's report.
  fold(registry, [{ account: 'claude-b', quota: { ...probe, state: 'available', identity: other } }], before - 60_000);
  fold(registry, [{ account: 'claude-a', quota: probe }], before - 30_000);
  assert.equal(registry.accounts.find(account => account.name === 'claude-a')!.quota.state, 'exhausted');
  assert.match(ineligible(registry, 'claude-a', before) ?? '', new RegExp(`^claude-a quota is exhausted until ${resetsAt}`));
  assert.match(ineligible(registry, 'claude-b', before) ?? '', /^claude-b quota is exhausted on plan .*\(claude-a quota is exhausted until/);

  const after = Date.parse(resetsAt) + 60_000;
  assert.equal(ineligible(registry, 'claude-a', after), null, 'the mark lapses at its reset even before a probe replaces it');
  assert.equal(ineligible(registry, 'claude-b', after), null);
});

test('unit:session-exhaustion-survives-later-probe — a session report whose reset was guessed holds only its own account: on an explicitly shared plan a later available probe of another account frees that account, while the spent one stays held until the guessed hour ends', () => {
  const registry = registryOf(['claude-a', 'claude-b'], 'team-max');
  const other = 'claude:' + 'b'.repeat(32);
  const guessedUntil = new Date(spentAt + 3_600_000).toISOString();
  fold(registry, [{ account: 'claude-a', quota: heldObservation('claude-a', { ...held, until: guessedUntil, resetsAt: null }) }], spentAt);
  const spent = registry.accounts.find(account => account.name === 'claude-a')!.quota;
  assert.equal(spent.session, 'guessed');
  assert.equal(spent.identity, null, 'a guessed hour names no login');
  fold(registry, [{ account: 'claude-b', quota: { ...probe, state: 'available', identity: other } }], spentAt + 60_000);
  fold(registry, [{ account: 'claude-a', quota: probe }], spentAt + 120_000);
  assert.equal(ineligible(registry, 'claude-b', spentAt + 180_000), null, 'the guessed hour holds no other account on the plan');
  assert.match(ineligible(registry, 'claude-a', spentAt + 180_000) ?? '', new RegExp(`^claude-a quota is exhausted until ${guessedUntil}`));
  assert.equal(ineligible(registry, 'claude-a', spentAt + 3_660_000), null);
});

test('unit:session-exhaustion-survives-later-probe — account set on the same login lifts a session report, so the first probe after the change replaces it and a fresh login frees the account and its former twin', () => {
  const registry = registryOf(['claude-a', 'claude']);
  fold(registry, [{ account: 'claude-a', quota: heldObservation('claude-a', held) }, { account: 'claude', quota: probe }], spentAt);
  const before = Date.parse(resetsAt) - 60_000;
  const account = registry.accounts.find(entry => entry.name === 'claude-a')!;
  const { quota: _quota, smoke: _smoke, unjudged: _unjudged, ...input } = account as typeof account & { smoke?: unknown; unjudged?: unknown };
  const changed = applyRegistryMutation(registry, 'account.set', { account: input, reason: 'logged the home in to another subscription' }, { actor: 'operator', at: new Date(spentAt + 60_000).toISOString() }).registry;
  assert.equal(changed.accounts.find(entry => entry.name === 'claude-a')!.quota.session, undefined, 'account set clears the session provenance');
  const fresh = 'claude:' + 'd'.repeat(32);
  assert.equal(fold(changed, [{ account: 'claude-a', quota: { ...probe, state: 'available', identity: fresh } }], spentAt + 120_000), true);
  const read = changed.accounts.find(entry => entry.name === 'claude-a')!.quota;
  assert.equal(read.state, 'available');
  assert.equal(read.identity, fresh);
  assert.equal(ineligible(changed, 'claude-a', before), null);
  assert.equal(ineligible(changed, 'claude', before), null);
});
