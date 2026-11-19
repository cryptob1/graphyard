import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mergeOne, type MergePorts, type MergeRecordEvent, type MergeTrialRun } from '../src/merge-writer/executor.js';
import { trialFailurePrefix } from '../src/model/rework-ground.js';
import type { Work } from '../src/model/work.js';

// GY-3545: a merge trial whose only failures are tests with an open "Flaky check on main" item, or
// tests that fail on the base tip too, is not the candidate's fault: the failures are noted (on the
// flaky item, or on the candidate as a known red) and the candidate lands. Any other failure is
// refused as before.

const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const tip = sha('tip'), head = sha('head');
const at = Date.parse('2030-06-01T00:00:00Z');
const candidate = {
  id: 'w1', key: 'GY-1', title: 'A change', type: 'chore', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
  candidate: { sha: head, baseSha: tip, pr: 1, branch: 'graphyard/gy-1-1', author: 'worker' }, submission: { epoch: 1, pr: 1 },
  observation: { source: 'control-plane', candidate: { sha: head, baseSha: tip }, files: ['src/app.ts'] }, mergeLedger: null,
} as unknown as Work;
const flakyItem = { id: 'w9', key: 'GY-9' };

function world(failed: string[], base?: MergeTrialRun['base']) {
  const events: MergeRecordEvent[] = [], notes: { key: string; text: string }[] = [];
  const run: MergeTrialRun = { build: 'pass', tests: { passed: 1, failed, files: 3 }, durationMs: 1, logTail: '', files: ['tests/works.test.ts', ...failed], proofs: { 'unit:works': { executed: 1, failed: 0 } }, ...(base ? { base } : {}) };
  const ports: MergePorts = {
    baseBranch: 'main', now: () => at,
    fetch: async () => tip, holds: async () => false,
    merge: async () => ({ mergeSha: sha('merge'), files: ['src/app.ts'] }),
    trial: async () => run,
    push: async () => 'pushed',
    record: async (_item, event) => { events.push(event); },
    flaky: async check => check === 'test:tests/flaky.test.ts' ? flakyItem : null,
    note: async (item, text) => { notes.push({ key: item.key, text }); },
  };
  return { ports, events, notes };
}

test('integration:trial-known-flaky — a trial failing only on tests with an open flaky item, or tests red on the base tip too, lands and notes them; any other failure is refused as before', async () => {
  // Only a test with an open flaky-check item fails: the candidate lands and the flaky item gains a note.
  const flaky = world(['tests/flaky.test.ts']);
  assert.equal((await mergeOne(flaky.ports, candidate)).outcome, 'merged');
  assert.deepEqual(flaky.events.map(event => event.kind), ['intent', 'trial', 'pushed', 'reconciled'], 'no refusal, so no rework');
  assert.deepEqual(flaky.notes.map(note => note.key), ['GY-9']);
  assert.match(flaky.notes[0]!.text, /tests\/flaky\.test\.ts failed in GY-1's merge trial/);

  // Only tests that fail on the base tip too, case for case: a known red, noted on the candidate, which lands.
  const red = world(['tests/red.test.ts'], { tip, files: ['tests/red.test.ts'], tests: ['red case'], cases: ['red case'] });
  assert.equal((await mergeOne(red.ports, candidate)).outcome, 'merged');
  assert.ok(!red.events.some(event => event.kind === 'refused'));
  assert.deepEqual(red.notes.map(note => note.key), ['GY-1']);
  assert.match(red.notes[0]!.text, /tests\/red\.test\.ts also fail on main/);

  // A flaky failure beside one of the candidate's own is refused naming the tests, as today.
  const mixed = world(['tests/flaky.test.ts', 'tests/mine.test.ts']);
  const refused = await mergeOne(mixed.ports, candidate);
  assert.equal(refused.outcome, 'refused');
  assert.deepEqual(mixed.events.at(-1), { kind: 'refused', head, reason: `${trialFailurePrefix}: tests tests/flaky.test.ts, tests/mine.test.ts` });
  assert.deepEqual(mixed.notes, []);
});
