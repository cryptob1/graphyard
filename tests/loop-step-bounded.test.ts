import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { daemonEffects, type DaemonEffects } from '../src/daemon/effects.js';
import { runCycle } from '../src/daemon/cycle.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { masterConfigSchema } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3410: the dispatch step read the agent-registry document twice in a row — once for the worker
// pool, again for the checkout-trust check — each under the 30 s registry bound, so a registry that
// did not answer took the step past its 60 s timeout. It now reads the document once per cycle.
test('unit:loop-step-bounded — an unanswering agent registry costs the dispatch step one bounded read, not two', async () => {
  const root = await temporaryDirectory('gy3410-root-'), outside = await temporaryDirectory('gy3410-cred-');
  execFileSync('git', ['init', '-q', root]);
  const credentialFile = join(outside, 'coordinator.token');
  await writeFile(credentialFile, 't'.repeat(40) + '\n', { mode: 0o600 });
  const config = masterConfigSchema.parse({ version: 1, url: 'https://plane.invalid', credentialFile, cliPath: '/bin/graphyard', repository: 'o/r', baseBranch: 'main', githubAppId: 1,
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
    const production = daemonEffects(root, config, { snapshot: async () => ({ work: [], now: '' }), mutate: async () => ({}), run: (async () => '') as never });
    const effects: DaemonEffects = {
      snapshot: async () => ({ work: [], now: new Date().toISOString() }),
      agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
      dispatch: async () => {}, closeSession: () => {}, persist: async () => {},
      registry: production.registry, checkoutTrust: production.checkoutTrust,
    };
    const lines: string[] = [];
    const started = performance.now();
    await runCycle(config, emptyDaemonState(config), effects, Date.now, undefined, line => lines.push(line));
    const elapsed = performance.now() - started;
    assert.equal(reads, 1, 'the dispatch step reads the registry document once a cycle');
    assert.ok(elapsed < 2 * delayMs, `the cycle waits on one registry bound, not two (${Math.round(elapsed)} ms)`);
    assert.ok(!lines.some(line => line.includes('the dispatch step failed')), lines.join('\n'));
  } finally { globalThis.fetch = original; }
});
