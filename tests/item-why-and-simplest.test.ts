import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { priorityServer } from './helpers/priority-server.js';
import { workFixture } from './helpers/work-fixture.js';
import { whyAndSimplestRefusal } from '../src/model-boundary/work.js';
import { itemLeadBrief, itemLeadRule } from '../src/review-prompt.js';
import { masterPrompt } from '../src/master/harness.js';
import { masterGuide } from '../src/master/guide.js';
import { workerPrompt } from '../src/master/dispatch.js';
import { masterConfigSchema } from '../src/master.js';
import { controlPlaneUpgradeItem, stepStallItem, trialHostFaultItem } from '../src/daemon/control-plane.js';
import { gateFiledItem } from '../src/daemon/cycle-batch-gate.js';
import { baseFailureItem } from '../src/model/base-failure.js';
import { onboardingWorkRequest } from '../src/model/onboarding-work.js';
import { postMergeFollowUp } from '../src/model/post-merge-review.js';
import { tasteFollowUp } from '../src/engine/commands/taste.js';
import { relandItemFor } from '../src/merge-writer/serve-revert.js';
import { workCommands } from '../src/cli/work.js';

const fields = { type: 'chore', priority: 2, criteria: [{ id: 'AC-1', text: 'The item shows its lead sentences', proofs: ['e2e:item-why-and-simplest'] }] };
const why = 'Owners see at a glance how an item helps users.';
const simplest = 'Two sentences on create, shown where items already show.';

test('item-why-and-simplest: create refuses a missing field by name, stores both, requirements revise them, and an older item opens without them', async () => {
  const f = await priorityServer();
  try {
    const noWhy = await f.call('work', { ...fields, title: 'No why', simplest });
    assert.equal(noWhy.status, 400);
    assert.match(noWhy.body.error, /needs why \(/); assert.doesNotMatch(noWhy.body.error, /simplest/);
    const noSimplest = await f.call('work', { ...fields, title: 'No simplest', why });
    assert.equal(noSimplest.status, 400);
    assert.match(noSimplest.body.error, /needs simplest \(/); assert.doesNotMatch(noSimplest.body.error, /why \(/);
    const blank = await f.call('work', { ...fields, title: 'Blank', why: '  ', simplest: '' });
    assert.match(blank.body.error, /needs why \(.*\) and simplest \(/);
    assert.equal((await f.store.list()).length, 0, 'nothing refused was created');

    const created = await f.ok('work', { ...fields, title: 'Lead sentences', why, simplest });
    assert.equal(created.why, why); assert.equal(created.simplest, simplest);
    const revised = await f.ok(`work/${created.id}/requirements`, { expectedPolicyRevision: created.policyRevision, reason: 'Sharper why', criteria: fields.criteria, dependencies: [], exclusiveResources: [], why: 'Agents build what users need.' });
    assert.equal(revised.why, 'Agents build what users need.'); assert.equal(revised.simplest, simplest, 'an omitted field keeps its value');
    assert.equal((await f.ok(`work/${created.key}`)).why, 'Agents build what users need.');

    // An item created before the change: the engine stores what the create carried, and it carried neither.
    const older = await f.engine.execute(f.engine.principals.find(p => p.id === 'operator')!, 'create', null, { ...fields, title: 'Older item' }, randomUUID());
    const opened = await f.ok(`work/${older.key}`);
    assert.equal(opened.why, undefined); assert.equal(opened.simplest, undefined); assert.equal(opened.title, 'Older item');
  } finally { await f.close(); }
});

test('item-why-and-simplest: every built-in creator supplies both sentences, and the prompts and create guide ask for them first', () => {
  const delivered = workFixture({ key: 'GY-7', title: 'Delivered', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['e2e:create-work-item'] }] });
  const filed = {
    // The planner was deleted in GY-2875; the master files planned items itself, from its prompt below.
    'batch gate flaky/known-red filer': gateFiledItem({ title: 'Flaky test', description: 'd', key: 'flake:test:tests/a.test.ts' }, 'main', 'cryptob1/graphyard'),
    'control-plane fault (reporter create upstream)': controlPlaneUpgradeItem({ failedStep: 'build', verified: 'a'.repeat(40) } as never),
    'stalled step filing': stepStallItem('dispatch', 'owner/project'),
    'trial host filing': trialHostFaultItem('registry.npmjs.org', 'owner/project'),
    'base failure filing': baseFailureItem({ check: 'test', test: 't', baseSha: 'b'.repeat(40), blocks: [], jobId: null, url: null } as never, 'main'),
    'onboarding filing': onboardingWorkRequest('c'.repeat(40), null, 'first'),
    'post-merge follow-up': postMergeFollowUp(delivered, 'd'.repeat(40), { text: 'A defect', path: null, line: null, paths: [] } as never, 0),
    'taste send-back follow-up': tasteFollowUp(delivered, 'The note is the reason', 'owner', '2026-01-01T00:00:00.000Z'),
    're-land': relandItemFor(delivered, { serve: 'e'.repeat(40), failingCase: 'create-work-item', failingStep: null, failingReason: null, mergeSha: 'f'.repeat(40), baseBranch: 'main' }),
  };
  for (const [creator, body] of Object.entries(filed)) assert.equal(whyAndSimplestRefusal(body), null, `${creator} supplies why and simplest`);
  const carried = relandItemFor({ ...delivered, why, simplest }, { serve: 'e'.repeat(40), failingCase: 'x', failingStep: null, failingReason: null, mergeSha: 'f'.repeat(40), baseBranch: 'main' });
  assert.deepEqual([carried.why, carried.simplest], [why, simplest], 'a re-land keeps the original sentences');

  assert.match(itemLeadRule, /^Before anything else .* why .* simplest .*keep the description short, and cut scope until the second sentence can be written/);
  const config = masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:1', credentialFile: '/c', cliPath: '/cli.mjs', repository: 'owner/project', baseBranch: 'main', hostId: 'h', masterAgentName: 'm', workers: [] });
  const master = masterPrompt(config);
  const asked = master.indexOf(itemLeadBrief.trim());
  assert.ok(asked > 0 && asked < master.indexOf('Never implement'), 'the master prompt asks for both right after its role, before any other instruction');
  assert.ok(masterGuide.split('\n\n')[1].startsWith(itemLeadRule), 'the master guide opens with it');
  const createHelp = workCommands.find(command => command.name === 'create')!.help.join(' ');
  assert.match(createHelp, /"why" and "simplest" first/);
  const worker = workerPrompt({ cliPath: '/cli.mjs' }, { key: 'GY-9', title: 'Item', why, simplest }, { principal: 'w' }, 1);
  assert.ok(worker.startsWith(`Implement GY-9: Item. Read why and simplest first and stay inside them. Why: ${why} Simplest: ${simplest} `), 'the worker reads both before anything else');
  assert.ok(!workerPrompt({ cliPath: '/cli.mjs' }, { key: 'GY-9', title: 'Item' }, { principal: 'w' }, 1).includes('Read why'), 'an older item has no lead line');
});
