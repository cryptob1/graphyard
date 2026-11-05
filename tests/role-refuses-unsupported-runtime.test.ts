import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseSession, emptyRegistry, proposedRuntimes, type AgentRegistry, type FleetRuntime } from '../src/model/registry.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { registryCommand, type RegistryCommandApi } from '../src/cli/master-registry.js';

// GY-3093: the master launch failed on an opencode account the registry had accepted
// ("Master conversation continuity is unsupported for runtime opencode; supported master
// runtimes are claude and codex"), and would have failed on every selection after it. The
// supported-runtimes fact is now a declared capability both role set and selection read:
// role set refuses the account naming the runtime and the supported runtimes, and selection
// passes over one already stored, recording the skip.

const HOST = 'machine-a';
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const proposed = (name: string) => proposedRuntimes.find(runtime => runtime.name === name)!;
const myClaude: FleetRuntime = { name: 'my-claude', description: 'A Claude-compatible CLI', launch: { kind: 'claude', args: [], environment: {}, homeVariable: 'CLAUDE_CONFIG_DIR', modelFlag: '--model', login: 'my-claude login', loginFile: '.credentials.json' } };

function registry(): AgentRegistry {
  return applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [proposed('claude'), proposed('codex'), proposed('opencode'), myClaude],
    models: [{ name: 'glm', id: 'zai/glm-5.3-flash' }],
    accounts: [
      { name: 'opencode-a', runtime: 'opencode', model: 'glm', credential: { host: HOST, home: null } },
      { name: 'claude-a', runtime: 'claude', model: 'glm', credential: { host: HOST, home: null } },
      { name: 'codex-a', runtime: 'codex', model: 'glm', credential: { host: HOST, home: null } },
      { name: 'my-claude-a', runtime: 'my-claude', model: 'glm', credential: { host: HOST, home: null } },
    ],
    roles: [{ name: 'worker', accounts: ['opencode-a', 'claude-a'], concurrency: 2 }],
    reason: 'fixture',
  }, { actor: 'operator', at: iso(clock - 60_000) }).registry;
}
const setRole = (fleet: AgentRegistry, accounts: string[], role = 'master') =>
  applyRegistryMutation(fleet, 'role.set', { role: { name: role, accounts, concurrency: 1 }, reason: 'Name the accounts' }, { actor: 'operator', at: iso(clock) }).registry;

test('unit:role-refuses-unsupported-runtime — role set refuses an account whose runtime the master role cannot run, naming the runtime and the supported runtimes, and changes nothing', () => {
  const fleet = registry();
  const before = structuredClone(fleet);
  assert.throws(() => setRole(fleet, ['opencode-a']), (error: Error) => {
    assert.match(error.message, /opencode-a/);
    assert.match(error.message, /opencode/);
    assert.match(error.message, /claude and codex/);
    return true;
  });
  assert.deepEqual(fleet, before, 'a refused role set changes nothing');
  // A mixed list refuses as a whole, naming every offending account.
  assert.throws(() => setRole(fleet, ['claude-a', 'opencode-a']), (error: Error) => {
    assert.match(error.message, /opencode-a/);
    assert.match(error.message, /claude and codex/);
    return true;
  });
  assert.deepEqual(fleet, before, 'a refused mixed role set changes nothing');
  // Supported runtimes are accepted, including a runtime of a supported kind under another name.
  const stored = setRole(fleet, ['my-claude-a', 'codex-a', 'claude-a']);
  assert.deepEqual(stored.roles.find(role => role.name === 'master')!.accounts, ['my-claude-a', 'codex-a', 'claude-a']);
  // The refusal is the master role's own capability: the worker role runs OpenCode.
  assert.deepEqual(setRole(fleet, ['opencode-a'], 'worker').roles.find(role => role.name === 'worker')!.accounts, ['opencode-a']);
});

test('unit:role-refuses-unsupported-runtime — master registry role set refuses with the naming message, and the control plane stores nothing', async () => {
  const stored = setRole(registry(), ['claude-a']);
  const before = structuredClone(stored);
  // Mirror the control plane: the write applies inside the coordination transaction, and a refusal commits nothing.
  const api: RegistryCommandApi = {
    read: async () => structuredClone(stored),
    write: async (_path, data) => applyRegistryMutation(structuredClone(stored), 'role.set', data, { actor: 'operator', at: iso(clock) }).registry,
  };
  await assert.rejects(registryCommand({ hostId: HOST }, ['role', 'set', 'master', 'opencode-a', '--concurrency', '1', '--reason', 'Swap in the opencode account'], api),
    (error: Error) => { assert.match(error.message, /opencode/); assert.match(error.message, /claude and codex/); return true; });
  assert.deepEqual(stored, before, 'the refused set stores nothing');
});

/** The registry as it stood when the opencode account was stored in the master role, before the refusal existed. */
const storedMasterRole = () => {
  const fleet = setRole(registry(), ['claude-a']);
  fleet.roles.find(role => role.name === 'master')!.accounts.unshift('opencode-a');
  return fleet;
};

test('unit:selection-skips-unsupported-runtime — selection passes over an unsupported account already stored in the master role, records the skip with its reason, and selects the next eligible account', () => {
  const fleet = storedMasterRole();
  const choice = chooseSession(fleet, { role: 'master', host: HOST }, clock);
  assert.ok(choice.account, `selection must not refuse: ${choice.reason}`);
  assert.equal(choice.account!.name, 'claude-a');
  const skip = choice.skipped.find(entry => entry.account === 'opencode-a');
  assert.ok(skip, 'the unsupported account is recorded as skipped');
  assert.match(skip!.reason, /opencode/);
  assert.match(skip!.reason, /claude and codex/);
  assert.match(choice.reason, /passed over/);
});

test('unit:selection-skips-unsupported-runtime — with only an unsupported account stored, the fleet failover (GY-3092) passes it over too and lands on a runtime the role can run', () => {
  const fleet = setRole(registry(), ['claude-a']);
  fleet.roles.find(role => role.name === 'master')!.accounts = ['opencode-a'];
  const choice = chooseSession(fleet, { role: 'master', host: HOST }, clock);
  assert.equal(choice.account?.name, 'claude-a', choice.reason);
  const skip = choice.skipped.find(entry => entry.account === 'opencode-a');
  assert.ok(skip, 'the unsupported account is recorded as skipped');
  assert.match(skip!.reason, /claude and codex/);
});
