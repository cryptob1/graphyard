import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Dependency-free protected workflow script.
import { validateReport, validateArtifactProvenance, observeArtifactProvenance, publishReport } from '../scripts/publish-acceptance.mjs';
// @ts-expect-error Dependency-free protected workflow script.
import { createInventory, mergeAuthorizationCases, requiredCases } from '../scripts/acceptance-contract.mjs';
const expected = { repository: 'owner/repo', workId: '00000000-0000-4000-8000-000000000001', pr: 1, policyRevision: 1, runId: '123', runAttempt: '2', harnessCommit: 'c'.repeat(40) };
const report = () => ({ ...expected, schema: 1, proof: 'integration:claim-safety', result: 'pass', sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), testedTree: 'd'.repeat(40), cases: requiredCases.map((id: string) => ({ id, result: 'pass' })), executed: 5, skipped: 0 });
const provenance = { provider: 'github-actions', repository: expected.repository, workflowCommit: expected.harnessCommit, runId: expected.runId, runAttempt: 2, artifact: { id: 45, name: 'graphyard-acceptance', digest: `sha256:${'d'.repeat(64)}`, url: 'https://api.github.com/repos/owner/repo/actions/artifacts/45/zip', createdAt: '2026-09-16T12:00:00Z' } };
const attempt = { id: 123, run_attempt: 2, repository: { full_name: expected.repository }, head_sha: expected.harnessCommit, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', run_started_at: '2026-09-16T11:00:00Z' };
const current = { id: 45, name: 'graphyard-acceptance', size_in_bytes: 100, digest: `sha256:${'d'.repeat(64)}`, archive_download_url: provenance.artifact.url, created_at: provenance.artifact.createdAt, expired: false };
// Uploaded by the superseded first attempt, so it is still listed for this run.
const superseded = { ...current, id: 44, digest: `sha256:${'e'.repeat(64)}`, archive_download_url: 'https://api.github.com/repos/owner/repo/actions/artifacts/44/zip', created_at: '2026-09-16T10:30:00Z' };
const named = { ...expected, artifactName: 'graphyard-acceptance' };
test('trusted reporter rejects empty, inconsistent, duplicate, incomplete and wrong-run reports', () => {
  for (const override of [{ executed: 0 }, { skipped: 1 }, { cases: [] }, { cases: Array(5).fill({ id: requiredCases[0], result: 'pass' }) }, { runId: 'another-run' }, { harnessCommit: 'e'.repeat(40) }]) {
    assert.throws(() => validateReport({ ...report(), ...override }, expected));
  }
  assert.doesNotThrow(() => validateReport(report(), named));
});
test('trusted reporter derives complete artifact provenance from provider facts', () => {
  assert.deepEqual(validateArtifactProvenance(attempt, [current], named), provenance);
  for (const bad of [{ ...current, expired: true }, { ...current, size_in_bytes: 0 }, { ...current, digest: null }]) {
    assert.throws(() => validateArtifactProvenance(attempt, [bad], named));
  }
  assert.throws(() => validateArtifactProvenance({ ...attempt, head_sha: 'f'.repeat(40) }, [current], named));
  assert.throws(() => validateArtifactProvenance({ ...attempt, run_attempt: 1 }, [current], named));
  assert.throws(() => validateArtifactProvenance(attempt, [current, current], named));
});
test('trusted reporter binds the artifact to this run attempt, never a superseded one', () => {
  // The run-scoped listing keeps every attempt's uploads; only this attempt's counts.
  assert.deepEqual(validateArtifactProvenance(attempt, [superseded, current], named), provenance);
  assert.throws(() => validateArtifactProvenance(attempt, [superseded], named), /run attempt 2/);
  assert.throws(() => validateArtifactProvenance({ ...attempt, run_started_at: undefined }, [current], named), /when it started/);
  // A first attempt may only consume what it uploaded itself.
  const first = { ...attempt, run_attempt: 1, run_started_at: '2026-09-16T10:00:00Z' };
  assert.equal(validateArtifactProvenance(first, [superseded], { ...named, runAttempt: '1' }).artifact.id, 44);
  assert.throws(() => validateArtifactProvenance(first, [superseded, current], { ...named, runAttempt: '1' }), /run attempt 1/);
});
test('artifact provenance is observed from the attempt-scoped run and a complete listing', async () => {
  const requested: string[] = [];
  const fetcher = async (url: string) => {
    requested.push(url);
    return new Response(JSON.stringify(url.includes('/attempts/') ? attempt : { total_count: 2, artifacts: [superseded, current] }));
  };
  assert.deepEqual(await observeArtifactProvenance(named, 'token-only', fetcher), provenance);
  assert.ok(requested.some(url => url.endsWith('/actions/runs/123/attempts/2')));
  await assert.rejects(observeArtifactProvenance(named, '', fetcher), /token is required/);
  await assert.rejects(observeArtifactProvenance({ ...named, runAttempt: 'latest' }, 'token-only', fetcher), /Invalid run identity/);
  await assert.rejects(observeArtifactProvenance({ ...named, repository: 'owner/repo/../other' }, 'token-only', fetcher), /Invalid repository/);
  await assert.rejects(observeArtifactProvenance({ ...named, artifactName: '../etc/passwd' }, 'token-only', fetcher), /Invalid artifact name/);
  const truncated = async (url: string) => new Response(JSON.stringify(url.includes('/attempts/') ? attempt : { total_count: 9, artifacts: [current] }));
  await assert.rejects(observeArtifactProvenance(named, 'token-only', truncated), /Complete GitHub artifact inventory/);
});
// GitHub keeps every attempt's uploads for a run, so a retried run's inventory outgrows one page.
const filler = (count: number, start = 1000) => Array.from({ length: count }, (_, i) => ({ ...current, id: start + i, name: `graphyard-unrelated-${start + i}` }));
const paged = (pages: any[][], totals?: number[]) => async (url: string) => {
  if (url.includes('/attempts/')) return new Response(JSON.stringify(attempt));
  const page = Number(new URL(url).searchParams.get('page'));
  return new Response(JSON.stringify({ total_count: totals ? totals[page - 1] : pages.flat().length, artifacts: pages[page - 1] ?? [] }));
};
test('artifact provenance follows the run inventory past the first page', async () => {
  const requested: string[] = [];
  const record = (fetcher: any) => async (url: string, init: any) => { requested.push(url); return fetcher(url, init); };
  // This attempt's only upload is on page two; a first-page-only read would refuse it.
  assert.deepEqual(await observeArtifactProvenance(named, 'token-only', record(paged([filler(100), [superseded, current]]))), provenance);
  assert.ok(requested.some(url => url.includes('/actions/runs/123/artifacts?per_page=100&page=2')));
  // A second current-attempt upload on a later page is ambiguous and must refuse.
  await assert.rejects(observeArtifactProvenance(named, 'token-only', paged([[...filler(99), current], [{ ...current, id: 46 }]])), /run attempt 2/);
});
test('an incomplete or shifting run inventory refuses instead of resolving', async () => {
  // The total changes between pages, so the pages no longer describe one inventory.
  await assert.rejects(observeArtifactProvenance(named, 'token-only', paged([filler(100), [current]], [150, 101])), /changed while it was read/);
  // An upload arriving mid-walk shifts the listing and repeats an artifact across pages.
  const shifted = filler(100);
  await assert.rejects(observeArtifactProvenance(named, 'token-only', paged([shifted, [shifted[99], current]], [101, 101])), /changed while it was read/);
  // A page short of the reported total is a truncated inventory, not a complete one.
  await assert.rejects(observeArtifactProvenance(named, 'token-only', paged([[superseded, current]], [4])), /Complete GitHub artifact inventory/);
  await assert.rejects(observeArtifactProvenance(named, 'token-only', paged([[{ ...current, id: null }, superseded]], [2])), /Complete GitHub artifact inventory/);
  // An inventory that never completes stops at the bounded page count rather than paging forever.
  let issued = 0;
  const endless = async (url: string) => url.includes('/attempts/') ? new Response(JSON.stringify(attempt))
    : new Response(JSON.stringify({ total_count: 100_000, artifacts: filler(100, 1000 + 100 * issued++) }));
  await assert.rejects(observeArtifactProvenance(named, 'token-only', endless), /pagination safety limit/);
});
test('acceptance inventory keeps completed, failing and unexecuted cases when a case fails', () => {
  const inventory = createInventory();
  assert.deepEqual(inventory.cases, requiredCases.map((id: string) => ({ id, result: 'skipped' })));
  assert.equal(inventory.complete, false);
  inventory.begin(requiredCases[0]); inventory.pass(requiredCases[0]);
  inventory.begin(requiredCases[1]); // interrupted here: the in-flight case stays failing
  assert.deepEqual(inventory.cases, [{ id: requiredCases[0], result: 'pass' }, { id: requiredCases[1], result: 'fail' },
    ...requiredCases.slice(2).map((id: string) => ({ id, result: 'skipped' }))]);
  assert.equal(inventory.executed, 2); assert.equal(inventory.skipped, requiredCases.length - 2); assert.equal(inventory.complete, false);
  assert.throws(() => inventory.begin(requiredCases[2]), /did not finish/);
  inventory.pass(requiredCases[1]);
  for (const id of requiredCases.slice(2)) { inventory.begin(id); inventory.pass(id); }
  assert.equal(inventory.complete, true); assert.equal(inventory.skipped, 0);
  assert.throws(() => inventory.begin(requiredCases[0]), /ran twice/);
});
test('a partially executed inventory publishes only as failing evidence', () => {
  const cases = [{ id: requiredCases[0], result: 'pass' }, { id: requiredCases[1], result: 'fail' },
    ...requiredCases.slice(2).map((id: string) => ({ id, result: 'skipped' }))];
  const partial = { ...report(), result: 'fail', cases, executed: 2, skipped: requiredCases.length - 2 };
  assert.doesNotThrow(() => validateReport(partial, named));
  assert.throws(() => validateReport({ ...partial, result: 'pass' }, named));
  assert.throws(() => validateReport({ ...partial, executed: requiredCases.length, skipped: 0 }, named));
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
  const work = { id: expected.workId, stage: 'acceptance', policyRevision: 1, candidate: { pr: 1, sha: 'a'.repeat(40), baseSha: 'b'.repeat(40) } };
  const sent: any[] = [];
  const fetcher = async (url: string, init: any) => {
    if (url.endsWith('/status')) return new Response(JSON.stringify({ actor: { role: 'producer', proofs: ['integration:claim-safety'] } }));
    if (url.endsWith('/work')) return new Response(JSON.stringify([work]));
    sent.push(JSON.parse(init.body)); return new Response('{}');
  };
  const config = { expected, url: 'https://example.com', token: 'test-only', provenance };
  await publishReport(report(), config, fetcher); assert.equal(sent[0].result, 'pass');
  assert.deepEqual(sent[0].provenance, provenance);
  await publishReport({ ...report(), result: 'fail', executed: 0, skipped: requiredCases.length, cases: requiredCases.map((id: string) => ({ id, result: 'skipped' })) }, config, fetcher); assert.equal(sent[1].result, 'fail');
  assert.equal(sent[1].skipped, requiredCases.length);
  await assert.rejects(publishReport(report(), { ...config, provenance: { ...provenance, runAttempt: 1 } }, fetcher), /provenance does not match/);
  work.candidate.sha = 'f'.repeat(40);
  await assert.rejects(publishReport(report(), config, fetcher), /Candidate changed/); assert.equal(sent.length, 2);
});
