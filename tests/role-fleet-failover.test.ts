import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseSession, emptyRegistry, unobservedQuota, type AgentRegistry, type FleetAccount, type FleetRoleName, type FleetSession } from '../src/model/registry.js';
import { runtimeSchema, modelSchema, accountSchema, roleSchema } from '../src/model-boundary/registry.js';

/**
 * Role failover across the fleet (GY-3092): a role whose own accounts are all exhausted, logged out
 * or unsupported runs on another usable registry account, the choice naming why; the role's own
 * accounts lead again the moment one is usable, and every selection rule still holds.
 */
const HOST = 'failover-host';
const now = Date.parse('2026-11-05T06:00:00.000Z');
const iso = (offset: number) => new Date(now + offset).toISOString();
const exhausted = { ...unobservedQuota, loggedIn: true, state: 'exhausted' as const, source: 'operator' as const, reason: 'weekly limit', resetsAt: iso(3_600_000), observedAt: iso(-60_000) };

/** claude (with a tools flag), codex (with none) and pi runtimes; each account on its own provider plan. */
function registry(roles: Partial<Record<FleetRoleName, string[]>>, accounts: Partial<FleetAccount>[] = [], concurrency = 5): AgentRegistry {
  const base = emptyRegistry();
  base.runtimes = [runtimeSchema.parse({ name: 'claude', launch: { kind: 'claude', toolsFlag: '--allowedTools' } }), runtimeSchema.parse({ name: 'codex', launch: { kind: 'codex' } }), runtimeSchema.parse({ name: 'pi', launch: { kind: 'pi', toolsFlag: '--tools' } })];
  base.models = [modelSchema.parse({ name: 'opus', provider: 'anthropic' }), modelSchema.parse({ name: 'gpt', provider: 'openai' }), modelSchema.parse({ name: 'glm', provider: 'zai' })];
  const defaults: Record<string, Partial<FleetAccount>> = {
    'claude-a': { runtime: 'claude', model: 'opus' }, 'claude-b': { runtime: 'claude', model: 'opus' }, 'codex-a': { runtime: 'codex', model: 'gpt' }, 'pi-a': { runtime: 'pi', model: 'glm' },
  };
  base.accounts = Object.entries(defaults).map(([name, entry]) => {
    const { quota, ...rest } = { ...entry, ...accounts.find(account => account.name === name) } as Partial<FleetAccount>;
    return { ...accountSchema.parse({ name, credential: { host: HOST, home: `/home/${name}` }, ...rest }), quota: { ...unobservedQuota, loggedIn: true, ...quota }, smoke: null };
  });
  base.roles = Object.entries(roles).map(([name, list]) => roleSchema.parse({ name, accounts: list, concurrency }));
  return base;
}
const live = (role: FleetRoleName, account: string, work: string): FleetSession => ({ id: `${role}-${account}-${work}`, role, account, runtime: account.split('-')[0], model: 'opus', host: HOST, work, principal: null, selectedAt: iso(-60_000), selectedBy: 'master', reason: 'test', skipped: [], endedAt: null, endReason: null });

test('unit:role-fleet-failover-selection — every own account exhausted, logged out or unsupported: another usable registry account serves, and the failover names the role, the account and why', () => {
  // Exhausted and logged out: the worker fails over to the first usable account the registry holds beyond its own.
  const spent = registry({ worker: ['claude-a', 'claude-b'] }, [{ name: 'claude-a', quota: exhausted }, { name: 'claude-b', quota: { ...unobservedQuota, loggedIn: false } }]);
  const choice = chooseSession(spent, { role: 'worker', host: HOST }, now);
  assert.equal(choice.account?.name, 'codex-a');
  assert.ok(choice.account && 'failover' in choice);
  assert.deepEqual({ role: choice.failover!.role, account: choice.failover!.account }, { role: 'worker', account: 'codex-a' });
  assert.match(choice.failover!.reason, /claude-a quota is exhausted .*weekly limit.*; claude-b is not logged in/);
  assert.match(choice.reason, /codex-a is the first eligible account for worker \(failing over: none of the role's own 2 accounts can serve it/);

  // Over the quota ceiling, a fleet account is passed over too; a logged-out one as well.
  const ceiling = registry({ worker: ['claude-a'] }, [{ name: 'claude-a', quota: exhausted }, { name: 'claude-b', quota: { ...exhausted, reason: 'over the 90% ceiling' } }, { name: 'codex-a', quota: { ...unobservedQuota, loggedIn: false } }]);
  const climbed = chooseSession(ceiling, { role: 'worker', host: HOST }, now);
  assert.equal(climbed.account?.name, 'pi-a');
  assert.deepEqual(climbed.skipped.map(entry => entry.account), ['claude-a', 'claude-b', 'codex-a']);
  assert.equal(climbed.account && climbed.failover!.reason.includes('claude-b'), false, 'the failover reason is why the role\'s own accounts were passed over');

  // Unsupported: a role with a tool allowlist cannot run on a runtime without a tools flag, its own account or the fleet's.
  const tools = registry({ approver: ['codex-a'] }, [{ name: 'claude-a', quota: exhausted }]);
  tools.roles[0].policy = { ...tools.roles[0].policy!, tools: ['Read'] };
  const supported = chooseSession(tools, { role: 'approver', host: HOST }, now);
  assert.equal(supported.account?.name, 'claude-b');
  assert.match(supported.account ? supported.failover!.reason : '', /codex-a runs codex, which names no tools flag for role approver's tool allowlist/);

  // A role's own usable account always leads: no failover, nothing recorded.
  const own = chooseSession(registry({ worker: ['claude-a', 'claude-b'] }, [{ name: 'claude-a', quota: exhausted }]), { role: 'worker', host: HOST }, now);
  assert.equal(own.account?.name, 'claude-b'); assert.equal(own.account && own.failover, null);
});

test('unit:role-fleet-failover-keeps-rules — reviewer provider diversity, role concurrency and the quota ceiling hold during failover; a role is refused only when nothing in the registry can serve it', () => {
  // Provider diversity: the implementer ran on anthropic, so the failover takes the other-provider fleet account, not the same-provider one.
  const review = registry({ reviewer: ['claude-a'] }, [{ name: 'claude-a', quota: exhausted }]);
  const diverse = chooseSession(review, { role: 'reviewer', host: HOST }, now, { work: 'GY-9', provider: 'anthropic' });
  assert.equal(diverse.account?.name, 'codex-a');
  assert.match(diverse.reason, /on provider openai, not the implementer's anthropic/);

  // Role concurrency: a role at its limit is refused before any failover is considered.
  const full = registry({ worker: ['claude-a'] }, [{ name: 'claude-a', quota: exhausted }], 1);
  full.sessions = [live('worker', 'codex-a', 'GY-1')];
  const refused = chooseSession(full, { role: 'worker', host: HOST }, now);
  assert.equal(refused.account, null); assert.match(refused.reason, /role worker is at its concurrency limit \(1 of 1 live: codex-a on GY-1\)/);

  // The quota ceiling: an account held over it never serves a failover, however far down the fleet.
  const held = registry({ worker: ['claude-a'] }, ['claude-a', 'claude-b', 'codex-a'].map(name => ({ name, quota: exhausted })));
  assert.equal(chooseSession(held, { role: 'worker', host: HOST }, now).account?.name, 'pi-a');
  // A strong worker preference still never fails over to Pi (GY-1746).
  const strong = chooseSession(held, { role: 'worker', host: HOST, prefer: 'strong' }, now);
  assert.equal(strong.account, null);

  // Refused only when no registry account can serve: the reason names every account passed over, the role's own first.
  const none = registry({ worker: ['claude-a'] }, ['claude-a', 'claude-b', 'codex-a', 'pi-a'].map(name => ({ name, quota: exhausted })));
  const nothing = chooseSession(none, { role: 'worker', host: HOST }, now);
  assert.equal(nothing.account, null);
  assert.deepEqual(nothing.skipped.map(entry => entry.account), ['claude-a', 'claude-b', 'codex-a', 'pi-a']);
  assert.match(nothing.reason, /^no eligible account for worker: claude-a quota is exhausted/);
});
