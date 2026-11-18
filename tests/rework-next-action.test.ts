import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trialFailureReason } from '../src/merge-writer/executor.js';
import { trialFailureRework } from '../src/daemon/cycle-merge-writer.js';
import { reworkReasonMax } from '../src/daemon/rework.js';
import type { Work } from '../src/model/work.js';

const head = 'a'.repeat(40);
const work = { key: 'GY-7', candidate: { sha: head }, submission: { pr: 7 } } as unknown as Work;
const noisy = Array.from({ length: 400 }, (_, i) => `not ok ${i} - noisy line ${i}`).join('\n');

test('e2e:rework-next-action a conflict trial failure tells the worker to sync, resolve and complete', () => {
  const reason = trialFailureReason({ conflict: ['src/a.ts', 'src/b.ts'] } as never)!;
  const { reason: brief } = trialFailureRework(work, head, reason);
  assert.match(brief, /run sync GY-7/);
  assert.match(brief, /complete GY-7 EPOCH --head NEWSHA\.$/);
  assert.doesNotMatch(brief, /returns to a worker/);
  assert.ok(brief.length <= reworkReasonMax);
});

test('e2e:rework-next-action a failing-test trial failure names run-tests.ts and complete within the bound', () => {
  for (const run of [
    { build: 'pass', tests: { passed: 1, failed: ['tests/merge-ledger.test.ts'], files: 2 }, logTail: noisy },
    { build: 'pass', tests: { passed: 1, failed: [], files: 2 }, e2e: [{ proof: 'e2e:board', case: 'board', failingStep: 'step 1' }], logTail: noisy },
  ]) {
    const reason = trialFailureReason({ run } as never)!;
    const { reason: brief } = trialFailureRework(work, head, reason);
    assert.match(brief, /node --import tsx tests\/helpers\/run-tests\.ts/);
    assert.match(brief, /complete GY-7 EPOCH --head NEWSHA\.$/);
    assert.doesNotMatch(brief, /returns to a worker/);
    assert.ok(brief.length <= reworkReasonMax, `${brief.length}`);
  }
});

test('e2e:rework-next-action the old closing phrases appear nowhere in the rework sources', () => {
  for (const file of ['src/daemon/cycle-merge-writer.ts', 'src/daemon/rework.ts']) {
    const source = readFileSync(file, 'utf8');
    for (const old of ['Nothing but a new head can pass the trial, so the item returns to a worker', 'so the candidate returns to a worker']) assert.ok(!source.includes(old), `${file} still says ${old}`);
    if (file.endsWith('rework.ts')) assert.equal(source.match(/The base moved: run sync \$\{work\.key\}, resolve, then complete \$\{work\.key\} EPOCH --head NEWSHA\./g)?.length, 2);
  }
});
