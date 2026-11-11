import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterPrompt } from '../src/master/harness.js';
import { guideTopics } from '../src/guide.js';
import { masterConfigSchema } from '../src/master.js';

// GY-3249: a red trial caused by the trial host (its network, disk, or a tool its image lacks) is a
// Graphyard fault; the master is told so, and told never to change the managed repository around it.

const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/game', baseBranch: 'main', hostId: 'machine-a', masterAgentName: 'graphyard-master-game', workers: [] });

test('unit:tests/master-upstream-rule.test.ts — the master prompt names trial-host faults (network, disk, missing trial-image tool) as upstream faults and forbids changing the managed repository around them', () => {
  const prompt = masterPrompt(config);
  assert.match(prompt, /A Graphyard fault \([^)]*trial-host failure: network, disk, missing trial-image tool\) goes to master\.json's upstream or master status/);
  assert.match(prompt, /never file it in owner\/game or change owner\/game to work around it\./);
});

test('unit:tests/master-upstream-rule.test.ts — guide master names trial-host faults and forbids changing the managed repository around them', () => {
  assert.match(guideTopics.master, /trial-host fault: the trial host's network, disk or a tool missing from the trial image\) on an install for another repository belongs to Graphyard/);
  assert.match(guideTopics.master, /never file it as work in the managed repository or change that repository to work around it\./);
});
