import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routineDecision } from '../src/master-daemon.js';
import { Engine, type Command } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';
import type { Store } from '../src/store.js';

// GY-1391 names this file for its proof: manual:intervention-pattern-rework-merge. Between
// 2026-09-30 and 2026-10-07 the intervention report counted 280 rework decisions at the merge
// stage. Read from the ledger rows each instance names, 268 of them had one cause: the guarded
// merge recorded a `rework` merge refusal (`mergerefused`, GY-831) for a green candidate, and the
// loop then asked for a rework decision on the ground `HEAD:merge-refused` (or a master asked by
// hand, citing the standing refusal). The refusal named the guarded merge's own state, never the
// change: "does not have a current all-gates-passing merge authorization" (most of them, to
// 2026-10-03), "Merge authorization is no longer current: GitHub observation missing or older
// than two minutes" (43, 2026-10-04 to 2026-10-05) and "The operation was aborted due to timeout".
// GitHub has merged on every passing gate since GY-1235 and GY-1236 removed the guarded merge, so
// no refusal was recorded after them, but the command that recorded one and the decision that
// turned it into a rework stayed. Both are gone now. The other 12 instances were real conflicts
// with the base: a worker has to resolve those, and each is bound to the head and base tip it
// was found on.
//
// Each class is replayed below from the decision the loop requested, with the same head, base and
// refusal. The file imports nothing the base lacks, so against the base each subtest loads and
// fails on its own assertion: the instance reproduces.

const instances = [
  { key: 'GY-471', at: '2026-10-02T04:52:05.710Z', sha: 'b7fa1538005af231f4c3780e7070106c77282f0d', baseSha: 'a4e741f0774a083aac7af9ea3a90dd8cd85f95a2', pr: 267,
    since: '2026-10-02T04:02:14.876Z', reason: 'GY-471 does not have a current all-gates-passing merge authorization' },
  { key: 'GY-1176', at: '2026-10-04T07:03:40.241Z', sha: 'f5095823ab0425f88123c3c9b8ed4d92cc4b479c', baseSha: '3850352f94b1c6d86dd3b81f73a30c0d5d7c2c26', pr: 658,
    since: '2026-10-04T05:21:17.537Z', reason: 'The operation was aborted due to timeout' },
  { key: 'GY-1199', at: '2026-10-05T03:42:58.790Z', sha: 'f96ead43d2a224128769473950e486f08ee59e9e', baseSha: 'a7f6da24bba0ff8212e17c100c211513fbfc3de7', pr: 689,
    since: '2026-10-05T00:31:12.151Z', reason: 'Merge authorization is no longer current: GitHub observation missing or older than two minutes' },
] as const;

/** A green candidate at the merge stage carrying the refusal the guarded merge recorded for it, its worker stopped. */
function refused(instance: typeof instances[number]): Work {
  const candidate = { sha: instance.sha, baseSha: instance.baseSha, pr: instance.pr, branch: `graphyard/${instance.key.toLowerCase()}-1`, author: 'worker' };
  return {
    id: `work-${instance.key}`, key: instance.key, title: instance.key, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [],
    policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: ['src/'], stage: 'merge', revision: 9, policyRevision: 2,
    createdAt: instance.since, updatedAt: instance.at, stageEnteredAt: instance.since, ready: true, epoch: 1, lease: null, workspaces: [], candidate,
    submission: { epoch: 1, pr: instance.pr }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [],
    gates: ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: true, reasons: [] })),
    observation: { candidate, checks: [], reviews: [{ state: 'APPROVED', reviewer: 'graphyard-reviewer[bot]', sha: instance.sha, submittedAt: instance.since }], merged: false, mergeSha: null, mergeable: true,
      protected: true, files: ['src/a.ts'], scopeFiles: [], at: instance.at, prState: 'open', draft: false, baseTip: instance.baseSha, baseTree: instance.baseSha, baseTipContained: true,
      conversations: { required: true, unresolved: [] } },
    mergeRefusal: { sha: instance.sha, baseSha: instance.baseSha, policyRevision: 2, reason: instance.reason, since: instance.since, at: instance.since, by: 'graphyard-master-graphyard-operator', action: 'rework', carry: null },
  } as unknown as Work;
}

for (const instance of instances) {
  test(`manual:intervention-pattern-rework-merge — ${instance.key} at ${instance.at} ("${instance.reason.slice(0, 60)}"): a merge refusal the item still carries asks for no rework decision`, () => {
    const decision = routineDecision(refused(instance), { autoMerge: true }, Date.parse(instance.at));
    assert.notEqual(decision?.binding, `${instance.sha}:merge-refused`, 'the refusal named the guarded merge\'s state, not the change, so no worker is asked to change it');
    assert.notEqual(decision?.action, 'rework');
  });
}

test('manual:intervention-pattern-rework-merge — nothing can record a merge refusal: the control plane refuses the retired mergerefused command as unknown', async () => {
  const engine = new Engine({} as Store);
  const admin = { id: 'graphyard-master-graphyard-operator', role: 'coordinator' } as Principal;
  const [instance] = instances;
  await assert.rejects(engine.execute(admin, 'mergerefused' as Command, `work-${instance.key}`, { sha: instance.sha, baseSha: instance.baseSha, policyRevision: 2, reason: instance.reason, since: instance.since }, 'gy-1391-replay'),
    (error: Error & { status?: number }) => /Unknown command/.test(error.message) && error.status === 404);
});
