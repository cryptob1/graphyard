import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { requiredCases } from './acceptance-contract.mjs';

// GitHub's maximum page size, and a bound on how many pages one run's inventory may take.
const PAGE_SIZE = 100, PAGE_LIMIT = 100;
export function validateReport(report, expected) {
  if (report.schema !== 1 || !['pass', 'fail'].includes(report.result) || report.proof !== 'integration:claim-safety' || !Number.isSafeInteger(report.executed) || report.executed < 0 || report.executed > requiredCases.length || !Number.isSafeInteger(report.skipped) || report.skipped < 0 || report.skipped > requiredCases.length) throw new Error('Incomplete acceptance report');
  if (!Array.isArray(report.cases) || report.cases.length !== requiredCases.length || requiredCases.some(id => report.cases.filter(c => c.id === id && ['pass', 'fail', 'skipped'].includes(c.result)).length !== 1)) throw new Error('Required acceptance case inventory is incomplete');
  const executed = report.cases.filter(c => c.result !== 'skipped').length, skipped = report.cases.filter(c => c.result === 'skipped').length;
  if (report.executed !== executed || report.skipped !== skipped) throw new Error('Acceptance counts do not match the case inventory');
  if ((report.result === 'pass') !== report.cases.every(c => c.result === 'pass')) throw new Error('Acceptance result does not match the case inventory');
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'artifactName') continue;
    if (value === undefined || value === '' || String(report[key]) !== String(value)) throw new Error(`Report ${key} does not match this trusted run`);
  }
  for (const key of ['sha', 'baseSha', 'testedTree', 'harnessCommit']) if (!/^[a-f0-9]{40}$/.test(report[key] ?? '')) throw new Error(`Invalid ${key}`);
  if (!Number.isSafeInteger(report.policyRevision) || report.policyRevision < 1) throw new Error('Invalid policy revision');
  return report;
}
export function validateArtifactProvenance(run, artifacts, expected) {
  if (String(run.id) !== String(expected.runId) || run.run_attempt !== Number(expected.runAttempt) || run.repository?.full_name !== expected.repository || run.head_sha !== expected.harnessCommit) throw new Error('GitHub run does not match this trusted reporter invocation');
  // Publication is the final job in this same run, so provider status is normally
  // in_progress here. A later retry may observe the completed run.
  if (!['in_progress', 'completed'].includes(run.status) || run.status === 'completed' && !['success', 'failure'].includes(run.conclusion) || run.event !== 'workflow_dispatch') throw new Error('GitHub run is not the protected acceptance invocation');
  // Artifacts are listed for the whole run, not per attempt, and a superseded attempt's
  // upload survives. Only an upload created after this attempt started belongs to it.
  const startedAt = Date.parse(run.run_started_at ?? '');
  if (!Number.isFinite(startedAt)) throw new Error('GitHub run attempt does not report when it started');
  const matches = artifacts.filter(artifact => artifact.name === expected.artifactName && Date.parse(artifact.created_at ?? '') >= startedAt);
  if (matches.length !== 1) throw new Error(`Expected exactly one acceptance artifact from run attempt ${expected.runAttempt}`);
  const artifact = matches[0];
  if (artifact.expired || !Number.isSafeInteger(artifact.id) || artifact.id < 1 || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1 || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '') || !artifact.archive_download_url || !artifact.created_at) throw new Error('Acceptance artifact provenance is incomplete or expired');
  return { provider: 'github-actions', repository: expected.repository, workflowCommit: expected.harnessCommit, runId: String(run.id), runAttempt: run.run_attempt,
    artifact: { id: artifact.id, name: artifact.name, digest: artifact.digest, url: artifact.archive_download_url, createdAt: artifact.created_at } };
}
export async function observeArtifactProvenance(expected, token, fetcher = fetch) {
  if (!token) throw new Error('GitHub token is required to verify artifact provenance');
  if (!/^[\w.-]+\/[\w.-]+$/.test(expected.repository ?? '')) throw new Error('Invalid repository for artifact provenance');
  if (!/^[1-9]\d*$/.test(String(expected.runId ?? '')) || !/^[1-9]\d*$/.test(String(expected.runAttempt ?? ''))) throw new Error('Invalid run identity for artifact provenance');
  if (!/^[\w.-]{1,200}$/.test(expected.artifactName ?? '')) throw new Error('Invalid artifact name for artifact provenance');
  const get = async path => {
    const response = await fetcher(`https://api.github.com/repos/${expected.repository}/actions/${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Cannot verify GitHub artifact provenance (${response.status})`);
    return response.json();
  };
  // GitHub pages a run's artifacts and keeps every attempt's uploads, so this attempt's
  // report legitimately sits beyond the first page once a run has been retried enough.
  // Walk the whole inventory under a bounded page count, and refuse a listing that moves
  // while it is read: a changing total or a repeated artifact means the pages no longer
  // describe one inventory, and a short page before the total is a truncated one.
  const inventory = async () => {
    const artifacts = [], seen = new Set();
    let total = null;
    for (let page = 1; page <= PAGE_LIMIT; page++) {
      const listing = await get(`runs/${expected.runId}/artifacts?per_page=${PAGE_SIZE}&page=${page}`);
      if (!Array.isArray(listing.artifacts) || !Number.isSafeInteger(listing.total_count) || listing.total_count < 0) throw new Error('Complete GitHub artifact inventory is unavailable');
      if (total === null) total = listing.total_count;
      else if (listing.total_count !== total) throw new Error('GitHub artifact inventory changed while it was read');
      for (const artifact of listing.artifacts) {
        if (!Number.isSafeInteger(artifact?.id)) throw new Error('Complete GitHub artifact inventory is unavailable');
        if (seen.has(artifact.id)) throw new Error('GitHub artifact inventory changed while it was read');
        seen.add(artifact.id); artifacts.push(artifact);
      }
      if (artifacts.length > total) throw new Error('GitHub artifact inventory changed while it was read');
      if (artifacts.length === total) return artifacts;
      if (listing.artifacts.length < PAGE_SIZE) throw new Error('Complete GitHub artifact inventory is unavailable');
    }
    throw new Error('GitHub artifact inventory exceeded the pagination safety limit');
  };
  // The attempt-scoped run pins head, status and start time to this invocation even
  // once a later attempt exists; the unscoped run would report that newer attempt.
  const [run, artifacts] = await Promise.all([get(`runs/${expected.runId}/attempts/${expected.runAttempt}`), inventory()]);
  return validateArtifactProvenance(run, artifacts, expected);
}
export async function publishReport(report, configuration, fetcher = fetch) {
  validateReport(report, configuration.expected);
  const provenance = configuration.provenance;
  if (!provenance) throw new Error('Independently observed artifact provenance is required');
  if (provenance.repository !== report.repository || provenance.workflowCommit !== report.harnessCommit || provenance.runId !== String(report.runId) || provenance.runAttempt !== Number(report.runAttempt)) throw new Error('Artifact provenance does not match the report');
  const url = new URL(configuration.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Reporter requires a credential-free HTTPS origin');
  const request = async (path, data) => {
    const response = await fetcher(`${url.origin}/api/${path}`, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${configuration.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `acceptance-${report.runId}-${report.runAttempt}-${report.workId}` }, body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Graphyard refused reporter request (${response.status})`); return response.json();
  };
  const status = await request('status');
  if (status.actor?.role !== 'producer' || !status.actor.proofs?.includes(report.proof)) throw new Error('Reporter identity is not an allowlisted producer');
  const work = (await request('work')).find(w => w.id === report.workId);
  if (!work || work.stage === 'done' || work.policyRevision !== report.policyRevision || work.candidate?.pr !== report.pr || work.candidate?.sha !== report.sha || work.candidate?.baseSha !== report.baseSha) throw new Error('Candidate changed or has not been observed; rerun acceptance for the current candidate');
  await request(`work/${work.id}/evidence`, { proof: report.proof, sha: report.sha, baseSha: report.baseSha, policyRevision: report.policyRevision, result: report.result, executed: report.executed, skipped: report.skipped,
    url: `https://github.com/${report.repository}/actions/runs/${report.runId}/attempts/${report.runAttempt}`, provenance });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = JSON.parse(await readFile(process.argv[2], 'utf8'));
    const expected = {
      repository: process.env.GITHUB_REPOSITORY, harnessCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      workId: process.env.GRAPHYARD_WORK_ID, pr: process.env.GRAPHYARD_PR, policyRevision: process.env.GRAPHYARD_POLICY_REVISION,
      artifactName: process.env.GRAPHYARD_ARTIFACT_NAME ?? `graphyard-acceptance-${process.env.GITHUB_RUN_ATTEMPT}`,
    };
    const provenance = await observeArtifactProvenance(expected, process.env.GITHUB_TOKEN);
    await publishReport(report, { url: process.env.GRAPHYARD_URL, token: process.env.GRAPHYARD_PRODUCER_TOKEN, expected, provenance });
    console.log('Acceptance evidence submitted for the tested candidate.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
