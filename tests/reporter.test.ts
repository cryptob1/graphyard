import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Dependency-free protected workflow script.
import { validateReport, publishReport } from '../scripts/publish-acceptance.mjs';
// @ts-expect-error Dependency-free protected workflow script.
import { requiredCases } from '../scripts/acceptance-contract.mjs';
// @ts-expect-error Dependency-free protected workflow script.
import { requiredCases as recoveryCases } from '../scripts/herdr-recovery-contract.mjs';
const expected = { repository: 'owner/repo', workId: '00000000-0000-4000-8000-000000000001', pr: 1, policyRevision: 1, runId: '123', runAttempt: '1', harnessCommit: 'c'.repeat(40) };
const report = () => ({ ...expected, schema: 1, proof: 'integration:claim-safety', result: 'pass', sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), testedTree: 'd'.repeat(40), cases: requiredCases.map((id: string) => ({ id, result: 'pass' })), executed: 5, skipped: 0 });
test('trusted reporter rejects empty, skipped, duplicate, incomplete and wrong-run reports', () => {
  for (const override of [{ executed: 0 }, { skipped: 1 }, { cases: [] }, { cases: Array(5).fill({ id: requiredCases[0], result: 'pass' }) }, { runId: 'another-run' }, { harnessCommit: 'e'.repeat(40) }]) {
    assert.throws(() => validateReport({ ...report(), ...override }, expected));
  }
  assert.doesNotThrow(() => validateReport(report(), expected));
});
test('each proof is validated against its own protected inventory', () => {
  const recovery = { ...report(), proof: 'integration:herdr-recovery' };
  // Both inventories hold five cases, so only the case names bind a report to its contract.
  assert.equal(recoveryCases.length, requiredCases.length);
  assert.throws(() => validateReport(recovery, expected), /inventory is incomplete/);
  assert.throws(() => validateReport({ ...report(), proof: 'integration:invented' }, expected), /Unknown trusted acceptance proof/);
  assert.doesNotThrow(() => validateReport({ ...recovery, cases: recoveryCases.map((id: string) => ({ id, result: 'pass' })) }, expected));
  assert.throws(() => validateReport({ ...recovery, cases: recoveryCases.map((id: string) => ({ id, result: 'pass' })) }, { ...expected, proof: 'integration:claim-safety' }), /Report proof does not match/);
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
