import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Dependency-free protected workflow script.
import { validateReport, publishReport } from '../scripts/publish-acceptance.mjs';
// @ts-expect-error Dependency-free protected workflow script.
import { mergeAuthorizationCases, requiredCases } from '../scripts/acceptance-contract.mjs';
const expected = { repository: 'owner/repo', workId: '00000000-0000-4000-8000-000000000001', pr: 1, policyRevision: 1, runId: '123', runAttempt: '1', harnessCommit: 'c'.repeat(40) };
const report = () => ({ ...expected, schema: 1, proof: 'integration:claim-safety', result: 'pass', sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), testedTree: 'd'.repeat(40), cases: requiredCases.map((id: string) => ({ id, result: 'pass' })), executed: 5, skipped: 0 });
test('trusted reporter rejects empty, skipped, duplicate, incomplete and wrong-run reports', () => {
  for (const override of [{ executed: 0 }, { skipped: 1 }, { cases: [] }, { cases: Array(5).fill({ id: requiredCases[0], result: 'pass' }) }, { runId: 'another-run' }, { harnessCommit: 'e'.repeat(40) }]) {
    assert.throws(() => validateReport({ ...report(), ...override }, expected));
  }
  assert.doesNotThrow(() => validateReport(report(), expected));
});
test('trusted reporter validates each proof against its own case inventory', () => {
  const pinned = { ...expected, proof: 'integration:merge-authorization' };
  const merge = () => ({ ...report(), ...pinned, cases: mergeAuthorizationCases.map((id: string) => ({ id, result: 'pass' })), executed: mergeAuthorizationCases.length });
  assert.doesNotThrow(() => validateReport(merge(), pinned));
  // A claim-safety inventory cannot be relabelled as the merge-authorization proof, and a proof
  // this harness cannot produce is never publishable whatever inventory it carries.
  assert.throws(() => validateReport({ ...merge(), cases: requiredCases.map((id: string) => ({ id, result: 'pass' })), executed: requiredCases.length }, pinned));
  assert.throws(() => validateReport(report(), pinned), /does not match this trusted run/);
  assert.throws(() => validateReport({ ...merge(), proof: 'integration:ci-inventory' }, { ...pinned, proof: 'integration:ci-inventory' }), /Incomplete acceptance report/);
});
test('reporter binds evidence to the observed candidate and forwards failures instead of retaining a stale pass', async () => {
  const current = { id: expected.workId, stage: 'acceptance', policyRevision: 1, candidate: { pr: 1, sha: 'a'.repeat(40), baseSha: 'b'.repeat(40) } };
  const sent: any[] = [];
  const fetcher = async (url: string, init: any) => {
    if (url.endsWith('/status')) return new Response(JSON.stringify({ actor: { role: 'producer', proofs: ['integration:claim-safety'] } }));
    if (url.endsWith('/work')) return new Response(JSON.stringify([current]));
    sent.push(JSON.parse(init.body)); return new Response('{}');
  };
  const config = { expected, url: 'https://example.com', token: 'test-only' };
  await publishReport(report(), config, fetcher); assert.equal(sent[0].result, 'pass');
  await publishReport({ ...report(), result: 'fail', executed: 0, cases: requiredCases.map((id: string) => ({ id, result: 'fail' })) }, config, fetcher); assert.equal(sent[1].result, 'fail');
  current.candidate.sha = 'f'.repeat(40);
  await assert.rejects(publishReport(report(), config, fetcher), /Candidate changed/); assert.equal(sent.length, 2);
});
