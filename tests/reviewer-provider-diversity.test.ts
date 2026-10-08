import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chooseSession, emptyRegistry, runtimeSchema, modelSchema, accountSchema, roleSchema, unobservedQuota, type AgentRegistry, type FleetAccount, type FleetRoleName, type FleetSession } from '../src/model/registry.js';
import type { ReviewDiversity } from '../src/model/review-diversity.js';

/**
 * Reviewer provider diversity (GY-1496): the reviewer of an item runs on a different model provider
 * than its implementer where the fleet allows, waits for a busy different-provider account, and
 * otherwise falls back to the implementer's provider with the fallback recorded.
 */
const HOST = 'review-host';
const now = Date.parse('2026-10-08T01:00:00.000Z');
const iso = (offset: number) => new Date(now + offset).toISOString();

/** claude and codex runtimes; opus names its provider, `codex-default` names none (provider = runtime launch kind). */
function registry(roleAccounts: Partial<Record<FleetRoleName, string[]>>, accounts: Partial<FleetAccount & { maxSessions: number | null }>[] = []): AgentRegistry {
  const base = emptyRegistry();
  base.runtimes = [
    runtimeSchema.parse({ name: 'claude', launch: { kind: 'claude' } }),
    runtimeSchema.parse({ name: 'codex', launch: { kind: 'codex' } }),
  ];
  base.models = [modelSchema.parse({ name: 'opus', provider: 'anthropic' }), modelSchema.parse({ name: 'sonnet', provider: 'anthropic' }), modelSchema.parse({ name: 'codex-default' }), modelSchema.parse({ name: 'gpt', provider: 'openai' })];
  const defaults: Record<string, Partial<FleetAccount>> = {
    'claude-a': { runtime: 'claude', model: 'opus' }, 'claude-b': { runtime: 'claude', model: 'sonnet' },
    'codex-a': { runtime: 'codex', model: 'codex-default' }, 'codex-b': { runtime: 'codex', model: 'gpt' },
  };
  base.accounts = Object.entries(defaults).map(([name, entry]) => {
    const override = accounts.find(account => account.name === name) ?? {};
    const { quota, smoke, ...rest } = { ...entry, ...override } as Partial<FleetAccount>;
    return { ...accountSchema.parse({ name, credential: { host: HOST, home: `/home/${name}` }, ...rest }), quota: { ...unobservedQuota, loggedIn: true, ...quota }, smoke: smoke ?? null };
  });
  base.roles = Object.entries(roleAccounts).map(([name, list]) => roleSchema.parse({ name, accounts: list, concurrency: 5 }));
  return base;
}
const session = (role: FleetRoleName, account: string, work: string | null, selectedAt: string, extra: Partial<FleetSession> = {}): FleetSession => {
  const runtime = account.startsWith('claude') ? 'claude' : 'codex';
  const model = { 'claude-a': 'opus', 'claude-b': 'sonnet', 'codex-a': 'codex-default', 'codex-b': 'gpt' }[account] ?? 'opus';
  return { id: `${account}-${selectedAt}`, role, account, runtime, model, host: HOST, work, principal: null, selectedAt, selectedBy: 'master', reason: 'test', skipped: [], endedAt: null, endReason: null, ...extra };
};
const diversity = (provider: string): ReviewDiversity => ({ work: 'GY-9', provider });
/** Imported per test, so a tree without the module fails each proof as a test case rather than the file at load. */
const diversityModule = () => import('../src/model/review-diversity.js');

test('unit:implementer-provider-resolved — account, retained session, ledger session, last assignment, unknown', async () => {
  const { accountProvider, implementerProvider } = await diversityModule();
  const fleet = registry({ reviewer: ['claude-a'] });
  const account = (name: string) => fleet.accounts.find(entry => entry.name === name)!;
  // An account's provider is its model's provider, else its runtime's launch kind.
  assert.equal(accountProvider(fleet, account('claude-a')), 'anthropic');
  assert.equal(accountProvider(fleet, account('codex-b')), 'openai');
  assert.equal(accountProvider(fleet, account('codex-a')), 'codex', 'a model naming no provider falls back to the runtime launch kind');

  // The newest retained worker session for the item wins over older ones, other roles and other items.
  fleet.sessions = [
    session('worker', 'claude-a', 'GY-9', iso(-3_600_000), { endedAt: iso(-1_800_000), endReason: 'lease ended' }),
    session('worker', 'codex-b', 'GY-9', iso(-600_000)),
    session('reviewer', 'claude-b', 'GY-9', iso(-60_000)),
    session('worker', 'claude-b', 'GY-10', iso(-30_000)),
  ];
  const ledger = [session('worker', 'codex-a', 'GY-9', iso(-60_000))];
  assert.equal(implementerProvider(fleet, 'GY-9', ledger, { runtime: 'claude' }), 'openai', 'retained sessions are read before the ledger and the last assignment');

  // With no retained worker session, the newest ledger `agent-registry.selected` worker session decides.
  fleet.sessions = [];
  assert.equal(implementerProvider(fleet, 'GY-9', [session('worker', 'claude-a', 'GY-9', iso(-9_000_000)), session('worker', 'codex-a', 'GY-9', iso(-60_000))], { runtime: 'claude' }), 'codex');
  // A ledger session whose account was since removed still names its provider by its recorded model or runtime.
  assert.equal(implementerProvider(fleet, 'GY-9', [session('worker', 'gone', 'GY-9', iso(-60_000), { runtime: 'codex', model: 'retired' })]), 'codex');

  // Else the item's last assignment's runtime (a registered runtime's launch kind, or the name itself).
  assert.equal(implementerProvider(fleet, 'GY-9', [], { runtime: 'claude' }), 'claude');
  assert.equal(implementerProvider(fleet, 'GY-9', [], { runtime: 'opencode' }), 'opencode');
  // Else unknown.
  assert.equal(implementerProvider(fleet, 'GY-9', [], { }), null);
  assert.equal(implementerProvider(fleet, 'GY-9'), null);
});

test('unit:reviewer-provider-differs — a reviewer skips same-provider accounts; other roles and unknown providers choose as before', () => {
  const fleet = registry({ reviewer: ['claude-a', 'claude-b', 'codex-b', 'codex-a'], worker: ['claude-a', 'codex-b'], producer: ['claude-a', 'codex-b'] });
  const choice = chooseSession(fleet, { role: 'reviewer', host: HOST }, now, diversity('anthropic'));
  assert.equal(choice.account?.name, 'codex-b', 'the first eligible account in role order whose provider differs');
  assert.deepEqual(choice.skipped, [
    { account: 'claude-a', reason: "claude-a shares the implementer's provider anthropic on GY-9" },
    { account: 'claude-b', reason: "claude-b shares the implementer's provider anthropic on GY-9" },
  ]);
  assert.match(choice.reason, /^codex-b is the first eligible account for reviewer \(preference 3 of 4; .*\) on provider openai, not the implementer's anthropic — passed over claude-a shares/);

  // An ineligible different-provider account is passed over as before; the next different one serves.
  const quota = registry({ reviewer: ['claude-a', 'codex-b', 'codex-a'] }, [{ name: 'codex-b', enabled: false }]);
  const next = chooseSession(quota, { role: 'reviewer', host: HOST }, now, diversity('anthropic'));
  assert.equal(next.account?.name, 'codex-a');
  assert.deepEqual(next.skipped.map(entry => entry.account), ['claude-a', 'codex-b']);

  // Every other role, and a reviewer whose implementer provider is unknown, chooses exactly as before.
  for (const role of ['worker', 'producer'] as const) {
    const before = chooseSession(fleet, { role, host: HOST }, now);
    assert.deepEqual(chooseSession(fleet, { role, host: HOST }, now, diversity('anthropic')), before);
    assert.equal(before.account?.name, 'claude-a');
  }
  const unknown = chooseSession(fleet, { role: 'reviewer', host: HOST }, now, null);
  assert.equal(unknown.account?.name, 'claude-a');
  assert.deepEqual(unknown.skipped, []);
  assert.equal(unknown.reason, 'claude-a is the first eligible account for reviewer (preference 1 of 4; 1 of 5 concurrent)');
});

test('unit:reviewer-provider-fallback-recorded — busy different provider waits; none serving falls back with reasons', () => {
  // A configured different-provider account whose only ineligibility is its own session limit: refused, naming it, as at role capacity.
  const busy = registry({ reviewer: ['claude-a', 'codex-b'] }, [{ name: 'codex-b', maxSessions: 1 }]);
  busy.sessions = [session('producer', 'codex-b', 'GY-3', iso(-60_000))];
  const wait = chooseSession(busy, { role: 'reviewer', host: HOST }, now, diversity('anthropic'));
  assert.equal(wait.account, null);
  assert.match(wait.reason, /^role reviewer is at its concurrency limit\b/, 'worded so the launch retries as at role capacity (src/fleet.ts roleAtCapacity)');
  assert.match(wait.reason, /codex-b is at its session limit \(1 of 1 live\)/);
  assert.match(wait.reason, /GY-9 waits for it rather than a review on anthropic/);

  // A different-provider account at its session limit AND otherwise ineligible is not waited for.
  const held = registry({ reviewer: ['claude-a', 'codex-b'] }, [{ name: 'codex-b', maxSessions: 1, quota: { ...unobservedQuota, state: 'exhausted', loggedIn: true } }]);
  held.sessions = [session('producer', 'codex-b', 'GY-3', iso(-60_000))];
  assert.equal(chooseSession(held, { role: 'reviewer', host: HOST }, now, diversity('anthropic')).account?.name, 'claude-a');

  // None configured: the first eligible same-provider account serves, its reason recording the fallback.
  const sole = registry({ reviewer: ['claude-a', 'claude-b'] }, [{ name: 'claude-a', enabled: false }]);
  const only = chooseSession(sole, { role: 'reviewer', host: HOST }, now, diversity('anthropic'));
  assert.equal(only.account?.name, 'claude-b');
  assert.deepEqual(only.skipped, [{ account: 'claude-a', reason: 'claude-a is disabled' }]);
  assert.match(only.reason, /no reviewer account outside provider anthropic can serve GY-9: none is configured for the role/);

  // Each different-provider account disabled, logged out, quota-exhausted, smoke-failed or placed on another host.
  for (const [label, override] of [
    ['disabled', { enabled: false }],
    ['not logged in', { quota: { ...unobservedQuota, loggedIn: false } }],
    ['quota is exhausted', { quota: { ...unobservedQuota, loggedIn: true, state: 'exhausted' } }],
    ['failed its smoke test', { smoke: { result: 'fail', reason: 'no reply', at: iso(-60_000), by: 'executor' } }],
    ['placed on elsewhere', { credential: { host: 'elsewhere', home: '/home/codex-b' } }],
  ] as const) {
    const fleet = registry({ reviewer: ['codex-b', 'claude-a', 'claude-b'] }, [{ name: 'codex-b', ...override } as Partial<FleetAccount>]);
    const fallback = chooseSession(fleet, { role: 'reviewer', host: HOST }, now, diversity('anthropic'));
    assert.equal(fallback.account?.name, 'claude-a', label);
    assert.deepEqual(fallback.skipped.map(entry => entry.account), ['codex-b'], `${label}: the chosen fallback is not recorded as skipped`);
    assert.match(fallback.reason, new RegExp(`no reviewer account outside provider anthropic can serve GY-9: codex-b (is )?.*${label}`), label);
  }
  // With nothing eligible at all, the refusal is as before.
  const none = registry({ reviewer: ['claude-a', 'codex-b'] }, [{ name: 'claude-a', enabled: false }, { name: 'codex-b', enabled: false }]);
  assert.equal(chooseSession(none, { role: 'reviewer', host: HOST }, now, diversity('anthropic')).reason, 'no eligible account for reviewer: claude-a is disabled; codex-b is disabled');

  const lines = readFileSync(new URL('../src/model/registry-sessions.ts', import.meta.url), 'utf8').trimEnd().split('\n').length;
  assert.ok(lines <= 320, `src/model/registry-sessions.ts stays within its 320-line budget (${lines})`);
});
