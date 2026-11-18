import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Launcher, runCycle } from '../src/daemon/cycle.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { daemonEffects, type DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3397: removing an ended attempt's worktree (its dependency install included) can outlast the
// close step's timeout; the removal runs beside the cycle, so the close step settles at once.

const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });

test('unit:loop-step-bounded — a slow worktree removal runs beside the cycle: the close step settles, the removal is not started twice, and its outcome is recorded when it ends', async () => {
  const now = Date.parse('2030-04-02T12:00:00Z');
  const path = '/repo/.graphyard/worktrees/GY-1-1';
  const work = [{ id: 'GY-1', key: 'GY-1', stage: 'build', lease: null, sessions: [], updatedAt: new Date(now - 60_000).toISOString(),
    workspaces: [{ host: 'machine-a', epoch: 1, path, owner: 'worker', branch: 'graphyard/gy-1-1' }] }] as unknown as Work[];
  let finish!: () => void;
  const removals: string[] = [];
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: new Date(now).toISOString() }),
    agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {}, persist: async () => {}, dispatchTick: async () => {},
    removeWorktree: target => { removals.push(target); return new Promise<boolean>(resolve => { finish = () => resolve(true); }); },
  };
  const state = emptyDaemonState(config), launcher = new Launcher(), lines: string[] = [];
  const cycle = () => Promise.race([runCycle(config, state, effects, () => now, launcher, line => lines.push(line)),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the cycle waited on the worktree removal')), 2_000).unref())]);
  await cycle();
  assert.deepEqual(removals, [path], 'the removal started');
  assert.ok(!lines.some(line => line.includes('the close step failed')), lines.join('\n'));
  await cycle();
  assert.equal(removals.length, 1, 'a removal still running is not started again');
  finish();
  await launcher.idle();
  assert.equal(state.actions['worktree:GY-1:1']?.state, 'done');
  const next = await cycle();
  assert.ok(next.actions.some(action => action.kind === 'reclaim' && action.detail.includes(path)), 'the settled removal is reported with the next cycle');
  assert.equal(removals.length, 1, 'a removed worktree is not removed again');
});

// GY-3410: the dispatch step read the agent-registry document twice in a row — once for the worker
// pool, again for the checkout-trust check — each under the 30 s registry bound, so a registry that
// did not answer took the step past its 60 s timeout. It now reads the document once per cycle.
test('unit:loop-step-bounded — an unanswering agent registry costs the dispatch step one bounded read, not two', async () => {
  const root = await temporaryDirectory('gy3410-root-'), outside = await temporaryDirectory('gy3410-cred-');
  execFileSync('git', ['init', '-q', root]);
  const credentialFile = join(outside, 'coordinator.token');
  await writeFile(credentialFile, 't'.repeat(40) + '\n', { mode: 0o600 });
  const registryConfig = masterConfigSchema.parse({ version: 1, url: 'https://plane.invalid', credentialFile, cliPath: '/bin/graphyard', repository: 'o/r', baseBranch: 'main', githubAppId: 1,
    hostId: 'm', masterAgentName: 'graphyard-master-project', workers: [] });
  const delayMs = 400;
  let reads = 0;
  const original = globalThis.fetch;
  // The registry read that never answers in time: each one waits out its bound (shortened here) and aborts.
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).endsWith('/api/agent-registry/document')) reads++;
    await new Promise(resolve => setTimeout(resolve, delayMs));
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  }) as typeof fetch;
  try {
    const production = daemonEffects(root, registryConfig, { snapshot: async () => ({ work: [], now: '' }), mutate: async () => ({}), run: (async () => '') as never });
    const effects: DaemonEffects = {
      snapshot: async () => ({ work: [], now: new Date().toISOString() }),
      agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
      dispatch: async () => {}, closeSession: () => {}, persist: async () => {},
      registry: production.registry, checkoutTrust: production.checkoutTrust,
    };
    const lines: string[] = [];
    const started = performance.now();
    await runCycle(registryConfig, emptyDaemonState(registryConfig), effects, Date.now, undefined, line => lines.push(line));
    const elapsed = performance.now() - started;
    assert.equal(reads, 1, 'the dispatch step reads the registry document once a cycle');
    assert.ok(elapsed < 2 * delayMs, `the cycle waits on one registry bound, not two (${Math.round(elapsed)} ms)`);
    assert.ok(!lines.some(line => line.includes('the dispatch step failed')), lines.join('\n'));
  } finally { globalThis.fetch = original; }
});
