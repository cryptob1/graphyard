import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Dependency-free protected workflow script.
import { validateReport, validateArtifactProvenance, publishReport } from '../scripts/publish-acceptance.mjs';
// @ts-expect-error Dependency-free protected workflow script.
import { requiredCases } from '../scripts/acceptance-contract.mjs';
const expected = { repository: 'owner/repo', workId: '00000000-0000-4000-8000-000000000001', pr: 1, policyRevision: 1, runId: '123', runAttempt: '1', harnessCommit: 'c'.repeat(40) };
const report = () => ({ ...expected, schema: 1, proof: 'integration:claim-safety', result: 'pass', sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), testedTree: 'd'.repeat(40), cases: requiredCases.map((id: string) => ({ id, result: 'pass' })), executed: 5, skipped: 0 });
const provenance = { provider: 'github-actions', repository: expected.repository, workflowCommit: expected.harnessCommit, runId: expected.runId, runAttempt: 1, artifact: { id: 45, name: 'graphyard-acceptance', digest: `sha256:${'d'.repeat(64)}`, url: 'https://api.github.com/repos/owner/repo/actions/artifacts/45/zip', createdAt: '2026-09-16T12:00:00Z' } };
test('trusted reporter rejects empty, inconsistent, duplicate, incomplete and wrong-run reports', () => {
  for (const override of [{ executed: 0 }, { skipped: 1 }, { cases: [] }, { cases: Array(5).fill({ id: requiredCases[0], result: 'pass' }) }, { runId: 'another-run' }, { harnessCommit: 'e'.repeat(40) }]) {
    assert.throws(() => validateReport({ ...report(), ...override }, expected));
  }
  assert.doesNotThrow(() => validateReport(report(), { ...expected, artifactName: 'graphyard-acceptance' }));
});
test('trusted reporter derives complete artifact provenance from provider facts', () => {
  const run = { id: 123, run_attempt: 1, repository: { full_name: expected.repository }, head_sha: expected.harnessCommit, status: 'completed', conclusion: 'success', event: 'workflow_dispatch' };
  const artifact = { id: 45, name: 'graphyard-acceptance', size_in_bytes: 100, digest: `sha256:${'d'.repeat(64)}`, archive_download_url: provenance.artifact.url, created_at: provenance.artifact.createdAt, expired: false };
  assert.deepEqual(validateArtifactProvenance(run, [artifact], { ...expected, artifactName: artifact.name }), provenance);
  for (const bad of [{ ...artifact, expired: true }, { ...artifact, size_in_bytes: 0 }, { ...artifact, digest: null }]) {
    assert.throws(() => validateArtifactProvenance(run, [bad], { ...expected, artifactName: artifact.name }));
  }
  assert.throws(() => validateArtifactProvenance({ ...run, head_sha: 'f'.repeat(40) }, [artifact], { ...expected, artifactName: artifact.name }));
  assert.throws(() => validateArtifactProvenance(run, [artifact, artifact], { ...expected, artifactName: artifact.name }));
});
test('reporter binds evidence to the observed candidate and forwards failures instead of retaining a stale pass', async () => {
  const current = { id: expected.workId, stage: 'acceptance', policyRevision: 1, candidate: { pr: 1, sha: 'a'.repeat(40), baseSha: 'b'.repeat(40) } };
  const sent: any[] = [];
  const fetcher = async (url: string, init: any) => {
    if (url.endsWith('/status')) return new Response(JSON.stringify({ actor: { role: 'producer', proofs: ['integration:claim-safety'] } }));
    if (url.endsWith('/work')) return new Response(JSON.stringify([current]));
    sent.push(JSON.parse(init.body)); return new Response('{}');
  };
  const config = { expected, url: 'https://example.com', token: 'test-only', provenance };
  await publishReport(report(), config, fetcher); assert.equal(sent[0].result, 'pass');
  assert.deepEqual(sent[0].provenance, provenance);
  await publishReport({ ...report(), result: 'fail', executed: 0, skipped: requiredCases.length, cases: requiredCases.map((id: string) => ({ id, result: 'skipped' })) }, config, fetcher); assert.equal(sent[1].result, 'fail');
  assert.equal(sent[1].skipped, requiredCases.length);
  current.candidate.sha = 'f'.repeat(40);
  await assert.rejects(publishReport(report(), config, fetcher), /Candidate changed/); assert.equal(sent.length, 2);
});
