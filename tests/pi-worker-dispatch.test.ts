import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { coordinatorConfinementRefusal } from '../src/master/profiles.js';
import { runtimeSandboxes, verifyWorkerSandbox, WorkerSandboxError } from '../src/worker-sandbox.js';
import { applyRegistryMutation, chooseSession, emptyRegistry, proposedRuntimes, type AgentRegistry } from '../src/model/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1746: Pi is a first-class worker runtime. Its launch is confined as any runtime without a
 * sandbox of its own is, and dispatch tries Pi accounts first only for a low or medium risk item on
 * its first two attempts; a high risk item, a third or later attempt and a role with no eligible Pi
 * account go to the strong runtimes, and an account that fails to start gives way to the next.
 */

const host = 'host-1';
function fleet(): AgentRegistry {
  const home = (name: string) => ({ host, home: `/homes/${name}` });
  return applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude' || runtime.name === 'codex' || runtime.name === 'pi'),
    models: [{ name: 'opus', id: 'claude-opus-5' }, { name: 'gpt', id: 'gpt-5' }, { name: 'glm', id: 'zai/glm-5.3' }],
    accounts: [{ name: 'claude-b', runtime: 'claude', model: 'opus', credential: home('claude-b') }, { name: 'codex-a', runtime: 'codex', model: 'gpt', credential: home('codex-a') },
      { name: 'pi-a', runtime: 'pi', model: 'glm', credential: home('pi-a') }, { name: 'pi-b', runtime: 'pi', model: 'glm', credential: home('pi-b') }],
    // The stored order names the strong accounts first: the preference, not the stored order, puts Pi ahead.
    roles: [{ name: 'worker', accounts: ['claude-b', 'pi-a', 'codex-a', 'pi-b'], concurrency: 4 }],
    reason: 'fixture',
  }, { actor: 'operator', at: new Date().toISOString() }).registry;
}
// Imported when a case runs, so a checkout without the rule fails the case rather than the file.
const { workerPreference } = await import('../src/model/registry-sessions.js').then(module => module as unknown as { workerPreference?: (work: object) => 'fast' | 'strong' }).then(module => ({ workerPreference: module.workerPreference ?? (() => 'fast' as const) }));
const pick = (registry: AgentRegistry, work: object, exclude: string[] = []) =>
  chooseSession(registry, { role: 'worker', host, prefer: workerPreference(work), exclude } as never, Date.now());

test('unit:pi-worker-confined — the pi runtime is known to the worker sandbox and a Pi worker is probed behind the coordinator confinement; a host that cannot confine it refuses the launch', async () => {
  const pi = runtimeSandboxes.pi;
  assert.ok(pi, 'worker-sandbox.ts has an entry for pi');
  assert.equal(pi.mode(['--model', 'zai/glm-5.3']), null, 'pi restricts no writes itself');
  assert.deepEqual(pi.grant(['/worktree']), [], 'pi is granted no sandbox directories');

  // The probe runs inside the confinement words the launch carries, and a refusal names the path.
  const ran: string[][] = [];
  const confinement = ['bwrap', '--unshare-pid', '--'];
  verifyWorkerSandbox({ kind: 'pi', args: [], confinement }, '/worktree', ['/worktree'], (command, args) => { ran.push([command, ...args]); return 'writable\n'; });
  assert.deepEqual(ran[0].slice(0, 3), confinement, 'the Pi worker is probed behind the read-only-mount confinement');
  assert.throws(() => verifyWorkerSandbox({ kind: 'pi', args: [], confinement }, '/worktree', ['/worktree'], () => 'unwritable\t/worktree\tRead-only file system\n'), (error: unknown) => error instanceof WorkerSandboxError && error.runtime === 'pi' && error.path === '/worktree');

  // A host without the means to confine a runtime that has no sandbox of its own never starts it.
  const base = await temporaryDirectory('pi-confined');
  execFileSync('git', ['init', '-q', '-b', 'main', base]);
  const refusal = await coordinatorConfinementRefusal({ kind: 'pi', args: [], coordinatorRoot: base, sessionDirectory: join(base, 'worktree'), platform: 'linux', bwrap: null });
  assert.match(refusal ?? '', /A pi session cannot be launched .* never starts a session unconfined/s);
});

test('unit:pi-first-worker-order — a low or medium risk item on its first two attempts is tried on Pi accounts first; a high risk item, a third or later attempt and a role with no eligible Pi account go to the strong accounts', () => {
  const registry = fleet();
  for (const lane of ['low', 'medium']) for (const reworkRounds of [0, 1]) {
    const choice = pick(registry, { lane, pipeline: { reworkRounds } });
    assert.equal(choice.account?.name, 'pi-a', `${lane} risk, attempt ${reworkRounds + 1} goes to Pi`);
  }
  assert.equal(pick(registry, { lane: 'high', pipeline: { reworkRounds: 0 } }).account?.name, 'claude-b', 'a high risk item goes to the strong accounts');
  assert.equal(pick(registry, { lane: 'low', pipeline: { reworkRounds: 2 } }).account?.name, 'claude-b', 'a third attempt goes to the strong accounts');
  assert.equal(pick(registry, { lane: 'medium', pipeline: { reworkRounds: 4 } }).account?.name, 'claude-b');

  // No eligible Pi account: the strong accounts take a low risk first attempt, and nothing is refused.
  const withoutPi = structuredClone(registry);
  for (const account of withoutPi.accounts.filter(entry => entry.runtime === 'pi')) account.enabled = false;
  const fallback = pick(withoutPi, { lane: 'low', pipeline: { reworkRounds: 0 } });
  assert.equal(fallback.account?.name, 'claude-b');
  assert.match(fallback.skipped.map(entry => entry.account).join(), /pi-a,pi-b/);

  // Pi accounts only wait behind the strong ones for a strong item; with the strong accounts spent they still serve it.
  const strongSpent = structuredClone(registry);
  for (const account of strongSpent.accounts.filter(entry => entry.runtime !== 'pi')) account.enabled = false;
  assert.equal(pick(strongSpent, { lane: 'high', pipeline: { reworkRounds: 0 } }).account?.name, 'pi-a');

  // Other roles keep their stored order whatever is preferred.
  registry.roles.push({ name: 'reviewer', accounts: ['claude-b', 'pi-a'], concurrency: 2 } as AgentRegistry['roles'][number]);
  assert.equal(chooseSession(registry, { role: 'reviewer', host, prefer: 'fast' }, Date.now()).account?.name, 'claude-b');
});

test('unit:pi-launch-failure-falls-back — a Pi account that failed to start under a dispatch is passed over, so the same dispatch tries the next account', async () => {
  const registry = fleet();
  const low = { lane: 'low', pipeline: { reworkRounds: 0 } };
  assert.equal(pick(registry, low).account?.name, 'pi-a');
  const next = pick(registry, low, ['pi-a']);
  assert.equal(next.account?.name, 'pi-b', 'the next Pi account takes the launch');
  assert.match(next.skipped.find(entry => entry.account === 'pi-a')?.reason ?? '', /already failed to start/);
  assert.equal(pick(registry, low, ['pi-a', 'pi-b']).account?.name, 'claude-b', 'with every Pi account failed the strong accounts take it');
});
