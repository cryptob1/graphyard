import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decisionActions, decisionInputs, decisionRequestSchema } from '../src/model/approval.js';
import { createSchema, evaluate, type Observation, type Work } from '../src/model.js';

// GY-406 gave the control-plane App a ruleset bypass the main guard still lands its reverts with.
// GY-1234 removed the repair lane built on it: under GitHub delivery GitHub merges on its own
// branch protection, so there is no Graphyard merge path left to repair.

const head = 'a'.repeat(40), base = 'b'.repeat(40);

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sources(join(directory, entry.name)) : /\.(ts|tsx|mjs|js)$/.test(entry.name) ? [join(directory, entry.name)] : []);
}

test('unit:repair-lane-removed — the module is gone and unimported, repair-merge is refused as unknown, and an item stored with "repair": "merge-path" still loads and evaluates', () => {
  assert.equal(existsSync('src/master/repair-lane.ts'), false, 'src/master/repair-lane.ts is deleted');
  const importers = ['src', 'bin', 'web'].filter(existsSync).flatMap(sources).filter(file => /repair-lane(\.js)?['"]/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(importers, [], 'no source file imports the repair lane');

  // The decision action is unknown: not listed, carries no input schema, and the request is refused.
  assert.equal((decisionActions as readonly string[]).includes('repair-merge'), false);
  assert.equal('repair-merge' in decisionInputs, false);
  const request = decisionRequestSchema.safeParse({ action: 'repair-merge', input: { sha: head }, reason: 'The merge path in src/merge-queue.ts stalls' });
  assert.equal(request.success, false, 'a repair-merge decision request is refused');
  assert.deepEqual(request.error!.issues.map(issue => [issue.code, issue.path.join('.')]), [['invalid_value', 'action']], 'refused as an unknown action');
  assert.equal(decisionRequestSchema.safeParse({ action: 'merge', input: { sha: head }, reason: 'still known' }).success, true, 'other actions are unaffected');
  // A new item cannot carry the retired field.
  assert.equal(createSchema.safeParse({ title: 't', criteria: [{ id: 'AC-1', text: 'x', proofs: ['unit:x'] }], repair: 'merge-path' }).success, false);

  // An item stored before the removal — its document as work_items holds it — loads and evaluates.
  const candidate = { sha: head, baseSha: base, pr: 206, branch: 'graphyard/gy-9-1', author: 'worker' };
  const stored = JSON.stringify({ id: 'work-9', key: 'GY-9', title: 'Fix the merge path', description: '', type: 'bug', priority: 0, dependencies: [], criteria: [{ id: 'AC-1', text: 'Merges', proofs: ['unit:merges'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/merge-queue.ts'], repair: 'merge-path', stage: 'build', revision: 9, policyRevision: 1,
    createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z', stageEnteredAt: '2026-09-25T00:00:00.000Z', ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 206 },
    reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: { at: '2026-09-25T00:01:00.000Z', candidate, reviews: [], checks: [], protected: true, mergeable: true, merged: false, prState: 'open', draft: false } as unknown as Observation,
    blocker: null, gates: [], violations: [] });
  const loaded = JSON.parse(stored) as Work;
  assert.equal(loaded.repair, 'merge-path');
  const evaluated = evaluate(loaded, [loaded], new Date('2026-09-25T00:02:00.000Z'), [1]);
  assert.deepEqual(evaluated.gates.map(gate => gate.name).slice(0, 2), ['ready', 'build']);
  assert.equal(evaluated.gates.find(gate => gate.name === 'test')?.passed, false, 'judged by its gates like any other item');
  const plain = JSON.parse(stored) as Work; delete plain.repair;
  assert.deepEqual(evaluated, evaluate(plain, [plain], new Date('2026-09-25T00:02:00.000Z'), [1]), 'the retired field changes nothing');
});
