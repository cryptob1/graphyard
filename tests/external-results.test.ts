import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CaseOutcome, CaseVerdict, FlakyAcceptance } from '../src/e2e/runner.js';

// GY-1842: an external test system hands a whole run in through one documented format
// (`graphyard-external-run-v1`, docs/validation.md). The import keeps every verdict as the
// producer gave it — `blocked` (a precondition or environment was missing) is its own verdict
// with its reason, never dropped and never read as failed — and the run blocks exactly as the
// runner's own result would: a required failed, blocked or unrun case blocks, flaky follows the
// existing flaky rule, optional cases never block.

/**
 * The modules under test, imported inside each test so that run against a tree without the import
 * (graphyard verify's exercise) each case fails on its own assertion instead of the file failing to load.
 */
const load = async () => {
  const [report, evidence, runner] = await Promise.all([import('../src/runner-report.js'), import('../src/model/evidence.js'), import('../src/e2e/runner.js')]);
  const { importExternalRun } = report;
  /** The hand-in with every case required, or the named cases; `over` replaces run-level fields. */
  const allRequired = (cases: readonly Record<string, unknown>[] = handIn.cases, over: Record<string, unknown> = {}) =>
    importExternalRun({ ...handIn, ...over, cases: cases.map(entry => ({ ...entry, required: true })) });
  return { importExternalRun, importedEvidenceArtifacts: evidence.importedEvidenceArtifacts, importedRunVerdict: runner.importedRunVerdict, releaseVerdict: runner.releaseVerdict, allRequired };
};

const sha = 'a'.repeat(40), digest = `sha256:${'b'.repeat(64)}`;
const reason = 'the payment sandbox was unreachable, so the case precondition never held';
const handIn = {
  format: 'graphyard-external-run-v1',
  producer: 'huck-engineer',
  sha,
  cases: [
    { id: 'checkout-guest', verdict: 'passed', attempts: 1, durationMs: 4310 },
    { id: 'search-facet', verdict: 'failed', attempts: 2, durationMs: 9180 },
    { id: 'win-tic-tac-toe', verdict: 'flaky', attempts: 2, durationMs: 12200 },
    { id: 'checkout-card', verdict: 'blocked', attempts: 0, durationMs: 0, reason },
    { id: 'profile-avatar', verdict: 'unrun', attempts: 0, durationMs: 0 },
  ],
};

test('unit:external-results-imported — an imported run keeps every verdict as the producer gave it, blocked with its reason, and names the head or digest it tested', async () => {
  const { importExternalRun } = await load();
  const imported = importExternalRun({ ...handIn, digest, environment: 'uat', runId: 'he-run-7', cases: handIn.cases.map(entry => ({ ...entry, required: true, evidence: ['https://artifacts.example.test/trace.zip'] })) });
  assert.deepEqual(imported.cases.map(entry => [entry.id, entry.verdict]),
    [['checkout-guest', 'passed'], ['search-facet', 'failed'], ['win-tic-tac-toe', 'flaky'], ['checkout-card', 'blocked'], ['profile-avatar', 'unrun']], 'every verdict is preserved as given');
  assert.equal(imported.cases.find(entry => entry.verdict === 'blocked')!.reason, reason, 'a blocked case keeps its reason');
  assert.equal(imported.producer, 'huck-engineer');
  assert.equal(imported.runId, 'he-run-7', 'an explicit run id is kept');
  assert.equal(imported.environment, 'uat');
  assert.equal(imported.sha, sha);
  assert.equal(imported.digest, digest);
  assert.deepEqual(imported.cases.find(entry => entry.verdict === 'failed'), { id: 'search-facet', verdict: 'failed', attempts: 2, durationMs: 9180, required: true, evidence: ['https://artifacts.example.test/trace.zip'] });
  // A run that tested a deployment names the digest instead of a head, and both are kept when given.
  const digestOnly = importExternalRun({ ...handIn, sha: undefined, digest });
  assert.equal(digestOnly.digest, digest);
  assert.equal(digestOnly.sha, undefined);
  // Defaults: a case without the required flag is optional, and evidence links default to none.
  const plain = importExternalRun(handIn);
  assert.ok(plain.cases.every(entry => !entry.required && entry.evidence.length === 0 && entry.id !== undefined));
  // A run without its own id takes one derived from the document, so the same hand-in keeps one
  // id and a changed hand-in does not: the flaky acceptance binds to case, run id and exact head.
  assert.equal(importExternalRun(handIn).runId, importExternalRun(handIn).runId);
  assert.notEqual(importExternalRun(handIn).runId, importExternalRun({ ...handIn, cases: [handIn.cases[0]] }).runId);
});

test('unit:external-results-imported — the import refuses what it does not understand: unknown verdict, blocked without its reason, neither head nor digest, unknown fields, bad links', async () => {
  const { importExternalRun } = await load();
  // The format literal is refused, not sniffed; unknown fields are refused.
  assert.throws(() => importExternalRun({ ...handIn, format: 'graphyard-playwright-v1' }));
  assert.throws(() => importExternalRun({ ...handIn, extra: true }));
  // A run naming neither a head nor a digest is refused.
  assert.throws(() => importExternalRun({ ...handIn, sha: undefined }));
  assert.throws(() => importExternalRun({ ...handIn, producer: '' }));
  // An unknown verdict is refused, never read as failed or dropped.
  assert.throws(() => importExternalRun({ ...handIn, cases: [{ id: 'c', verdict: 'skipped', attempts: 1, durationMs: 1 }] }));
  // A blocked case without its reason is refused.
  assert.throws(() => importExternalRun({ ...handIn, cases: [{ id: 'c', verdict: 'blocked', attempts: 0, durationMs: 0 }] }));
  assert.throws(() => importExternalRun({ ...handIn, cases: [{ id: 'c', verdict: 'passed', attempts: -1, durationMs: 1 }] }));
  assert.throws(() => importExternalRun({ ...handIn, cases: [{ id: 'c', verdict: 'passed', attempts: 1, durationMs: -1 }] }));
  assert.throws(() => importExternalRun({ ...handIn, cases: [{ id: 'c', verdict: 'passed', attempts: 1, durationMs: 1, evidence: ['not a url'] }] }));
  // Evidence links meet the artifact boundary: no other scheme and no credentials, while plain HTTP(S) links stay.
  for (const link of ['file:///etc/passwd', 'ftp://artifacts.example.test/trace.zip', 'javascript:alert(1)', 'https://user:password@example.com/report', 'https://user@example.com/report'])
    assert.throws(() => importExternalRun({ ...handIn, cases: [{ id: 'c', verdict: 'passed', attempts: 1, durationMs: 1, evidence: [link] }] }), link);
  assert.deepEqual(importExternalRun({ ...handIn, cases: [{ id: 'c', verdict: 'passed', attempts: 1, durationMs: 1, evidence: ['http://ci.example.test/log', 'https://artifacts.example.test/trace.zip'] }] }).cases[0].evidence, ['http://ci.example.test/log', 'https://artifacts.example.test/trace.zip']);
  assert.throws(() => importExternalRun({ ...handIn, cases: [{ id: 'c', verdict: 'passed', attempts: 1, durationMs: 1, extra: 1 }] }));
});

test('unit:external-results-imported — a required failed, blocked or unrun case blocks exactly as the runner\'s own result would, and flaky follows the existing flaky rule', async () => {
  const { importExternalRun, importedRunVerdict, releaseVerdict, allRequired } = await load();
  const imported = allRequired();
  const verdict = importedRunVerdict(imported);
  assert.equal(verdict.passed, false);
  assert.deepEqual(verdict.blocking.map(entry => [entry.id, entry.verdict]),
    [['search-facet', 'failed'], ['win-tic-tac-toe', 'flaky'], ['checkout-card', 'blocked'], ['profile-avatar', 'unrun']],
    'required failed, blocked and unrun cases block; the flaky one blocks unaccepted');
  assert.deepEqual(verdict.blocking.find(entry => entry.verdict === 'blocked')!.reason, reason);
  // The shared verdicts block exactly as the runner's own result does for the same run.
  const ownCases = (verdicts: Record<string, CaseVerdict>): CaseOutcome[] => Object.entries(verdicts).map(([id, caseVerdict]) => ({ id, title: id, file: 'e2e/cases/fixture.json', outcome: caseVerdict === 'passed' ? 'pass' : caseVerdict === 'unrun' ? null : 'fail', verdict: caseVerdict, required: true, durationMs: 10, attempts: 1, attemptResults: [], executed: 0, failingStep: null }));
  const own = { runId: 'own-run', sha, cases: ownCases({ 'checkout-guest': 'passed', 'search-facet': 'failed', 'win-tic-tac-toe': 'flaky' }) };
  assert.deepEqual(releaseVerdict(own).blocking.map(entry => entry.id), ['search-facet', 'win-tic-tac-toe']);
  const shared = allRequired([handIn.cases[0], handIn.cases[1], handIn.cases[2]]);
  assert.deepEqual(importedRunVerdict(shared).blocking.map(entry => entry.id), ['search-facet', 'win-tic-tac-toe'], 'the import blocks the same cases the runner\'s own verdict blocks');
  // Flaky follows the existing flaky rule: an evidence decision bound to the case, run id and
  // exact head accepts it; a decision naming any other case, run or head accepts nothing.
  const acceptance: FlakyAcceptance = { case: 'win-tic-tac-toe', runId: imported.runId, sha, decision: 'd1' };
  assert.deepEqual(importedRunVerdict(imported, [acceptance]).blocking.map(entry => entry.id), ['search-facet', 'checkout-card', 'profile-avatar']);
  for (const broken of [{ case: 'other-case', runId: imported.runId, sha, decision: 'd1' }, { case: 'win-tic-tac-toe', runId: 'other-run', sha, decision: 'd1' }, { case: 'win-tic-tac-toe', runId: imported.runId, sha: 'f'.repeat(40), decision: 'd1' }])
    assert.ok(importedRunVerdict(imported, [broken]).blocking.some(entry => entry.id === 'win-tic-tac-toe'), 'a decision off this case, run or head accepts nothing');
  // A digest-only run binds no acceptance, the same rule as the runner's own report naming no served SHA.
  const digestOnly = allRequired(handIn.cases, { sha: undefined, digest });
  assert.ok(importedRunVerdict(digestOnly, [acceptance]).blocking.some(entry => entry.id === 'win-tic-tac-toe'));
  // A case bound to a still-pending outcome (GY-1802) is listed apart and never blocks, as in releaseVerdict.
  const spared = importedRunVerdict(imported, [], ['checkout-card', 'search-facet']);
  assert.deepEqual(spared.blocking.map(entry => entry.id), ['win-tic-tac-toe', 'profile-avatar']);
  assert.deepEqual(spared.pending.map(entry => [entry.id, entry.verdict]), [['search-facet', 'failed'], ['checkout-card', 'blocked']]);
  assert.deepEqual(releaseVerdict(own, [], ['search-facet']).blocking.map(entry => entry.id), importedRunVerdict(shared, [], ['search-facet']).blocking.map(entry => entry.id));
  // Optional cases never block, and a required pass blocks nothing.
  assert.deepEqual(importedRunVerdict(importExternalRun(handIn)), { passed: true, blocking: [], pending: [] });
  assert.equal(importedRunVerdict(importExternalRun({ ...handIn, cases: [{ id: 'checkout-guest', verdict: 'passed', attempts: 1, durationMs: 1, required: true }] })).passed, true);
});

test('unit:external-results-imported — a blocking case carries its evidence links as external artifacts, which are never trusted proof', async () => {
  const { importedEvidenceArtifacts, importedRunVerdict, allRequired } = await load();
  const imported = allRequired([{ id: 'search-facet', verdict: 'failed', attempts: 1, durationMs: 5, evidence: ['https://artifacts.example.test/search-facet/trace.zip', 'https://logs.example.test/search-facet'] }]);
  const verdict = importedRunVerdict(imported);
  assert.deepEqual(verdict.blocking, [{
    id: 'search-facet', verdict: 'failed', evidence: [
      { kind: 'report', label: 'imported case evidence', availability: 'external', url: 'https://artifacts.example.test/search-facet/trace.zip' },
      { kind: 'report', label: 'imported case evidence', availability: 'external', url: 'https://logs.example.test/search-facet' },
    ],
  }], 'each link is an external artifact beside the block it explains');
  assert.deepEqual(importedEvidenceArtifacts([]), []);
});
