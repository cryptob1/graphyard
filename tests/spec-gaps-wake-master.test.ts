import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterCauses, masterCausePrompt } from '../src/daemon/master-stalled-delivery.js';
import { itemLine } from '../src/cli/master-status.js';
import type { Work } from '../src/model/work.js';

// GY-3163: items sat for hours on an unanswered spec-check gaps verdict because nothing told the master.
const at = '2026-11-06T07:00:00Z', now = Date.parse(at);
const check = (extra: Record<string, unknown> = {}) => ({ at, verdict: 'gaps', gaps: ['AC-1 names no file', 'AC-2 has no proof'], recheck: false, reviewer: 'r', paraphrase: 'p', policyRevision: 2, ...extra });
const item = (extra: Record<string, unknown> = {}) => ({
  id: 'id', key: 'GY-9', title: 'Gapped', type: 'feature', stage: 'ready', ready: true, epoch: 0, revision: 1, policyRevision: 2,
  criteria: [], dependencies: [], evidence: [], gates: [], workspaces: [], lease: null, candidate: null, submission: null, blocker: null,
  createdAt: at, updatedAt: at, specCheck: check(), ...extra,
}) as unknown as Work;

test('unit:spec-gaps-wake-master — a first gaps verdict on the current revision wakes the master with the key, each gap and the requirements command; revision or recheck clears it', () => {
  const causes = masterCauses([item()]);
  assert.equal(causes.length, 1);
  const prompt = masterCausePrompt(causes);
  assert.match(prompt, /^Graphyard needs coordinator action:/);
  for (const text of ['GY-9', 'AC-1 names no file', 'AC-2 has no proof', 'master requirements GY-9 FILE REASON']) assert.ok(prompt.includes(text), text);
  // The same verdict keeps one subject and digest, so the wake path prompts once per verdict.
  assert.deepEqual(masterCauses([item()]), causes);
  assert.deepEqual(masterCauses([item({ policyRevision: 3 })]), [], 'master requirements revised the item');
  assert.deepEqual(masterCauses([item({ specCheck: check({ recheck: true }) })]), [], 'a recheck dispatches');
  assert.deepEqual(masterCauses([item({ specCheck: check({ verdict: 'ready', gaps: [] }) })]), []);
});

test('unit:status-shows-spec-gaps — master status shows a first gaps verdict as waiting on the master with its gaps; a recheck is not waiting', () => {
  const line = itemLine(item(), now);
  assert.equal(line.stage, 'Waiting on the master');
  assert.deepEqual((line as { gaps?: string[] }).gaps, ['AC-1 names no file', 'AC-2 has no proof']);
  const recheck = itemLine(item({ specCheck: check({ recheck: true }) }), now);
  assert.equal(recheck.stage, 'Not started');
  assert.equal('gaps' in recheck, false);
  assert.equal(itemLine(item({ policyRevision: 3 }), now).stage, 'Not started');
});
