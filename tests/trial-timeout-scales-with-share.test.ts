import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { mergeWriterReads, trialShareAllowance } from '../src/daemon/cycle-merge-writer.js';
import { masterConfigSchema } from '../src/master.js';
import { trialTimeoutMinutes } from '../src/master/merge-writer-settings.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';

// GY-3183: three trials sharing a 24-core host each ran on 8 cores under the 20-minute deadline a
// trial alone has on all 24, and timed out during tests. A trial given 1/share of the cores now
// gets share times the deadline; a trial alone keeps the default.

const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy' } } });
const item = { key: 'GY-1', criteria: [], type: 'bug' as const };
const defaultMs = trialTimeoutMinutes * 60_000;

test('unit:trial-timeout-scales-with-share — a trial sharing the host with share 3 gets 3x the deadline and a third of the cores; alone it keeps the default', async () => {
  const launched: { timeoutMs: number; cores?: number }[] = [];
  const reads = mergeWriterReads(config, '/repo/checkout', async () => '', { base: '/managed', record: async () => ({}),
    trial: async (input): Promise<MergeTrialRun> => { launched.push({ timeoutMs: input.timeoutMs, ...(input.cores === undefined ? {} : { cores: input.cores }) }); return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {} }; } });

  await reads.trial('a'.repeat(40), [], item, undefined, undefined, undefined, undefined, 3);
  await reads.trial('b'.repeat(40), [], item);
  await reads.trial('c'.repeat(40), [], item, undefined, undefined, undefined, undefined, 1);
  assert.deepEqual(launched, [
    { timeoutMs: 3 * defaultMs, cores: Math.max(1, Math.floor(availableParallelism() / 3)) },
    { timeoutMs: defaultMs },
    { timeoutMs: defaultMs },
  ]);
  assert.deepEqual(trialShareAllowance(3, 1000), { timeoutMs: 3000, cores: Math.max(1, Math.floor(availableParallelism() / 3)) }, 'an explicit deadline scales by the share too');
  assert.deepEqual(trialShareAllowance(undefined), { timeoutMs: defaultMs });
});
