import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterConfigSchema } from '../src/master.js';

/**
 * GY-1264: `mergeQueue.optimistic` and `optimisticExclude` are retired (GY-1233), and GY-1236
 * retires `batchSize`, `parallelTips` and `ciConcurrency` with Graphyard's own merge queue. A
 * master.json that still carries them loads, but parsing drops them, so every writer that re-parses
 * before it saves (master init, profile and environment changes) removes them from the file.
 */
const base = { version: 1, url: 'https://graphyard.example', credentialFile: '/tmp/token', cliPath: '/tmp/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project' };

test('unit:retired-merge-queue-keys — parsing keeps the live merge-queue setting and drops optimistic, optimisticExclude and the queue\'s batchSize, parallelTips and ciConcurrency', () => {
  const parsed = masterConfigSchema.parse({ ...base, mergeQueue: { parallelTips: 4, batchSize: 2, ciConcurrency: 20, rerunFailedChecks: 1, optimistic: true, optimisticExclude: ['**/package.json'] } });
  assert.deepEqual(parsed.mergeQueue, { rerunFailedChecks: 1 }, 'only the setting something reads survives the parse');
  const rewritten = JSON.parse(JSON.stringify(parsed));
  for (const retired of ['optimistic', 'optimisticExclude', 'batchSize', 'parallelTips', 'ciConcurrency'])
    assert.equal(retired in rewritten.mergeQueue, false, `a config written back from the parse no longer names ${retired}`);
  assert.deepEqual(masterConfigSchema.parse(rewritten).mergeQueue, { rerunFailedChecks: 1 }, 'and re-parses unchanged');
});

test('unit:retired-merge-queue-keys — unknown merge-queue keys are still refused', () => {
  assert.throws(() => masterConfigSchema.parse({ ...base, mergeQueue: { parallelTips: 4, optimisticLane: true } }), 'the object stays strict');
});
