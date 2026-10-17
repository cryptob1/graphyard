import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReleaseCandidate, Suite } from '../src/release-candidate.js';

// 2026-10-17: six candidates in a row (18:23Z–23:15Z) passed every suite and still failed UAT with
// "UAT moved from <sha> to no observable commit while the suites ran": the one /healthz read after the
// suites got no answer while UAT was busy. A read that answers nothing is read again; only a different
// commit means UAT moved.

const sha = 'c'.repeat(40), other = 'd'.repeat(40);
const candidate: ReleaseCandidate = { id: '20261017T231531Z', sha, cutAt: new Date(0).toISOString(), trigger: 'manual', since: null, items: [] };
const passing: Suite = { name: 'endpoints', run: async () => ({ name: 'endpoints', passed: true, detail: 'ok' }) };
/** A UAT whose /healthz answers each read from `answers` in turn (null: no answer), then the last one forever. */
const uat = (answers: (string | null)[]) => {
  let reads = 0;
  const fetcher = (async () => {
    const answer = answers[Math.min(reads++, answers.length - 1)];
    if (answer === null) throw new Error('timeout');
    return new Response(JSON.stringify({ ok: true, commit: answer }));
  }) as typeof fetch;
  return { fetcher, reads: () => reads };
};
const options = (fetcher: typeof fetch) => ({ timeoutMs: 1000, fetcher, now: () => new Date(0), sleep: async () => {} });

test('unit:uat-after-read-retry — an unanswered read after the suites is read again, and the candidate passes when UAT still serves it', async () => {
  const { validate } = await import('../src/release-candidate.js');
  const served = uat([sha, null, null, sha]); // before the suites, then two silent reads, then the commit
  const result = await validate(candidate, 'https://uat.example.test', [passing], options(served.fetcher));
  assert.equal(result.result, 'passed', JSON.stringify(result.suites));
  assert.equal(served.reads(), 4);
});

test('unit:uat-after-read-retry — UAT serving a different commit after the suites still fails at once, and one that never answers fails after the retries', async () => {
  const { validate } = await import('../src/release-candidate.js');
  const moved = uat([sha, other]);
  const movedResult = await validate(candidate, 'https://uat.example.test', [passing], options(moved.fetcher));
  assert.equal(movedResult.result, 'failed');
  assert.match(JSON.stringify(movedResult.suites), new RegExp(`moved from ${sha} to ${other}`));
  assert.equal(moved.reads(), 2, 'a different commit is not read again');
  const silent = uat([sha, null]);
  const silentResult = await validate(candidate, 'https://uat.example.test', [passing], options(silent.fetcher));
  assert.equal(silentResult.result, 'failed');
  assert.match(JSON.stringify(silentResult.suites), /no observable commit/);
  assert.equal(silent.reads(), 5, 'one read before the suites, then the first read after them and three retries');
});
