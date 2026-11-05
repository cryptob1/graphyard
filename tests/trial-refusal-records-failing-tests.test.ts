import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trialFailureReason } from '../src/merge-writer/executor.js';
import { trialFailureTests } from '../src/cli/complete.js';
import { trialFailureRework } from '../src/daemon/cycle-merge-writer.js';
import { reworkBriefSection } from '../src/master/rework-brief.js';
import { failureSignature } from '../src/daemon/repeated-failure.js';
import type { Work } from '../src/model/work.js';

// GY-3150: a refused trial step names the failing tests its output reports and a bounded, masked
// log tail on the item's merge ledger refusal, which the worker's rework brief and master status read.
const playwright = [
  'Running 65 tests using 4 workers',
  ...Array.from({ length: 120 }, (_, index) => `  ✓  ${index + 1} [chromium] › browser-tests/dashboard.spec.ts:${index + 3}:5 › passes ${index} (1.2s)`),
  '  ✘  7 [chromium] › browser-tests/item-details.spec.ts:41:3 › item details › shows the merge ledger (31.0s)',
  'Error: connect to https://bot:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com failed; GH_TOKEN=supersecretvalue',
  '  1) [chromium] › browser-tests/item-details.spec.ts:41:3 › item details › shows the merge ledger ──────',
  '  1 failed',
].join('\n');
const nodeTap = ['not ok 3 - fold keeps the refusal', '  ---', '  error: \'expected 1\'', '  ...', 'not ok 4 - tests/merge-ledger.test.ts', 'token=hunter2'].join('\n');

test('unit:trial-refusal-records-failing-tests a failed browser step records the failing spec, its test name and a masked bounded log tail', () => {
  const reason = trialFailureReason({ run: { build: 'pass', tests: { passed: 64, failed: ['browser-tests/'], files: 65 }, logTail: playwright } })!;
  assert.ok(reason.length <= 2000, `the ledger refusal stays within its 2,000 characters (${reason.length})`);
  const [first, ...rest] = reason.split('\n');
  assert.equal(first, 'trial failed: tests browser-tests/', 'the reason itself still leads');
  assert.match(rest.join('\n'), /^failing tests: browser-tests\/item-details\.spec\.ts › item details › shows the merge ledger$/m);
  assert.match(reason, /\nlog tail:\n[\s\S]*  1 failed$/, 'the tail ends where the step output ended');
  assert.doesNotMatch(reason, /ghp_abcdefghijklmnopqrstuvwxyz0123|supersecretvalue/, 'credentials are masked');
  assert.match(reason, /\[redacted\]/);
});

test('unit:trial-refusal-records-failing-tests node test failures name their cases, and complete reruns only the files the first line names', () => {
  const reason = trialFailureReason({ run: { build: 'pass', tests: { passed: 1, failed: ['tests/merge-ledger.test.ts'], files: 2 }, logTail: `${nodeTap}\n, tests/elsewhere.test.ts: noise` } })!;
  assert.match(reason, /^trial failed: tests tests\/merge-ledger\.test\.ts\nfailing tests: fold keeps the refusal\nlog tail:\n/);
  assert.doesNotMatch(reason, /hunter2/);
  const refusal = { kind: 'merge', reason };
  // Two runs of the same failure whose tails differ by run noise still read as the same failure.
  const again = trialFailureReason({ run: { build: 'pass', tests: { passed: 1, failed: ['tests/merge-ledger.test.ts'], files: 2 }, logTail: `${nodeTap}\n/var/tmp/graphyard-trial-QwErTy/x` } })!;
  assert.equal(failureSignature('trial', again), failureSignature('trial', reason));
  assert.deepEqual(trialFailureTests(refusal), ['tests/merge-ledger.test.ts'], 'a test path printed in the log tail is no failing file');
  // A case the reason already names is not repeated.
  const named = trialFailureReason({ run: { build: 'pass', tests: { passed: 1, failed: ['tests/merge-ledger.test.ts'], files: 2 }, failingCase: 'fold keeps the refusal', logTail: nodeTap } })!;
  assert.doesNotMatch(named, /failing tests:/);
  // A failed build step's tail is masked too.
  assert.doesNotMatch(trialFailureReason({ run: { build: 'fail', tests: { passed: 0, failed: [], files: 0 }, logTail: 'npm ERR! password=letmein' } })!, /letmein/);
});

test('unit:trial-refusal-records-failing-tests the worker rework brief shows the failing tests and log tail within the rework bound', () => {
  const reason = trialFailureReason({ run: { build: 'pass', tests: { passed: 64, failed: ['browser-tests/'], files: 65 }, logTail: playwright } })!;
  const head = 'a'.repeat(40);
  const work = { key: 'GY-1', candidate: { sha: head }, submission: { pr: 7 } } as unknown as Work;
  const rework = trialFailureRework(work, head, reason);
  assert.ok(rework.reason.length <= 2000, `the engine takes the rework reason (${rework.reason.length})`);
  assert.match(rework.reason, /failing tests: browser-tests\/item-details\.spec\.ts › item details › shows the merge ledger\nlog tail:\n/);
  assert.match(rework.reason, /1 failed\. Nothing but a new head can pass the trial/);
  const brief = reworkBriefSection(work, { reason: rework.reason, at: '2026-11-05T21:00:00.000Z' } as never);
  assert.match(brief, /item details › shows the merge ledger/);
  assert.match(brief, /log tail:/);
});
