import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterConfigSchema } from '../src/master.js';

/**
 * GY-1264: `mergeQueue.optimistic` and `optimisticExclude` are retired (GY-1233). A master.json
 * that still carries them loads, but parsing drops them, so every writer that re-parses before it
 * saves (master init, profile and environment changes) removes them from the file.
 */
const base = { version: 1, url: 'https://graphyard.example', credentialFile: '/tmp/token', cliPath: '/tmp/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project' };

test('unit:retired-merge-queue-keys — parsing keeps the live merge-queue settings and drops optimistic and optimisticExclude', () => {
  const parsed = masterConfigSchema.parse({ ...base, mergeQueue: { parallelTips: 4, batchSize: 2, optimistic: true, optimisticExclude: ['**/package.json'] } });
  assert.deepEqual(parsed.mergeQueue, { parallelTips: 4, batchSize: 2 }, 'only the settings something reads survive the parse');
  const rewritten = JSON.parse(JSON.stringify(parsed));
  assert.equal('optimistic' in rewritten.mergeQueue, false, 'a config written back from the parse no longer names optimistic');
  assert.equal('optimisticExclude' in rewritten.mergeQueue, false, 'nor optimisticExclude');
  assert.deepEqual(masterConfigSchema.parse(rewritten).mergeQueue, { parallelTips: 4, batchSize: 2 }, 'and re-parses unchanged');
});

test('unit:retired-merge-queue-keys — unknown merge-queue keys are still refused', () => {
  assert.throws(() => masterConfigSchema.parse({ ...base, mergeQueue: { parallelTips: 4, optimisticLane: true } }), 'the object stays strict');
});
