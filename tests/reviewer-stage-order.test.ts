import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewPrompt, reviewStandard } from '../src/reviewer.js';
import { mergeOne, mergeQueue, type MergePorts, type MergeTrialRun } from '../src/merge-writer/executor.js';
import type { Work } from '../src/model.js';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
// GY-3044 was held for results of these cases before the approval that starts their trial.
const cases = ['create-work-item', 'board', 'work-item-detail'];
const criteria = cases.map((name, i) => ({
  id: `AC-${i + 1}`, text: `Bind e2e/cases/${name}.json to the implemented user flow.`, proofs: [`e2e:${name}`],
}));
const binding = { key: 'GY-3044', pr: 1, sha: head, baseSha: base, policyRevision: 1 };

test('integration:reviewer-stage-order — GY-3044 briefs allow approval before trusted trial results while judging bound case implementation', () => {
  const prompts = [
    reviewPrompt({ repository: 'owner/project' }, binding, undefined, undefined, criteria),
    reviewPrompt({ repository: 'owner/project' }, binding, undefined, undefined, criteria,
      undefined, undefined, undefined, undefined, undefined, { head, baseTip: base }),
    reviewStandard({ key: binding.key, head, base }, criteria),
  ];
  for (const prompt of prompts) {
    for (const criterion of criteria) assert.ok(prompt.includes(`[${criterion.id}] ${criterion.text}`));
    assert.match(prompt, /from code and test coverage, including bound E2E cases/);
    assert.match(prompt, /missing later trusted results do not block review/);
    assert.match(prompt, /missing or inadequate test implementation can/);
    assert.match(prompt, /merge writer must pass every required exact-head test\/E2E proof before updating main/);
    assert.match(prompt, /Never waive gates or ask workers for trusted evidence/);
    assert.match(prompt, /Post APPROVE or REQUEST_CHANGES before the automated merge trial/);
    assert.doesNotMatch(prompt, /checks one case|check one case/);
  }
});

test('integration:reviewer-stage-order — approval starts the GY-3044 trial without evidence, and each failed or missing E2E case still prevents a push', async () => {
  const work = {
    id: 'work-3044', key: binding.key, title: 'Create and inspect work', type: 'feature', risk: 'sensitive',
    criteria, stage: 'build', createdAt: new Date(0).toISOString(), stageEnteredAt: new Date(0).toISOString(),
    submission: { epoch: 1, pr: 1 }, candidate: { sha: head, baseSha: base },
    observation: { source: 'control-plane', merged: false, candidate: { sha: head }, files: ['src/store/schema.ts'] }, evidence: [],
    gates: [{ name: 'build', passed: true }, { name: 'review', passed: false }, { name: 'test', passed: false }],
  } as unknown as Work;
  assert.equal(mergeQueue([work], {}, 0).next, null, 'the review approval is needed first');
  work.gates.find(gate => gate.name === 'review')!.passed = true;
  assert.equal(mergeQueue([work], {}, 0).next, work, 'approval starts the trial with no trusted results yet');

  for (const badCase of [null, ...cases]) for (const missing of badCase ? [false, true] : [false]) {
    const order: string[] = [];
    const run: MergeTrialRun = {
      build: 'pass', tests: { passed: 1, failed: [], files: 1 }, files: ['tests/flows.test.ts'],
      proofs: Object.fromEntries(cases.map(name => [`e2e:${name}`, { executed: missing && name === badCase ? 0 : 1, failed: name === badCase ? 1 : 0 }])), durationMs: 1, logTail: '',
      e2e: cases.map(name => ({ proof: `e2e:${name}`, case: name,
        executed: missing && name === badCase ? 0 : 1, failed: name === badCase ? 1 : 0,
        ...(name === badCase ? missing ? { missing: true } : { failingStep: 'step 1 failed' } : {}),
      })),
    };
    const ports: MergePorts = {
      baseBranch: 'main', now: () => 0, fetch: async () => base,
      merge: async trialHead => { assert.equal(trialHead, head); return { mergeSha: head, files: run.files }; },
      trial: async (sha, _files, item) => {
        assert.equal(sha, head); assert.deepEqual(item.criteria, criteria); order.push('trial'); return run;
      },
      push: async sha => { assert.equal(sha, head); order.push('push'); return 'pushed'; },
      holds: async () => false, record: async () => {},
    };
    const result = await mergeOne(ports, work);
    assert.equal(result.outcome, badCase ? 'refused' : 'merged');
    assert.deepEqual(order, badCase ? ['trial'] : ['trial', 'push']);
    if (result.outcome === 'refused') assert.ok(result.reason.includes(badCase!));
  }
});
