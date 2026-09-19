import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contract, ciProofFamilies } from './contracts.mjs';

// GitHub's maximum page size, and a bound on how many pages one run's inventory may take.
const PAGE_SIZE = 100, PAGE_LIMIT = 100;
export function validateReport(report, expected) {
  // The inventory is selected by the reported proof and fixed in protected source; a report can
  // never widen, shrink, or rename the cases its own proof requires.
  const { requiredCases } = contract(report.proof);
  if (report.schema !== 1 || !['pass', 'fail'].includes(report.result) || !Number.isSafeInteger(report.executed) || report.executed < 0 || report.executed > requiredCases.length || !Number.isSafeInteger(report.skipped) || report.skipped < 0 || report.skipped > requiredCases.length) throw new Error('Incomplete acceptance report');
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
// ---- CI-produced evidence -------------------------------------------------------------------
// A candidate-push run publishes one record per planned proof through the CI producer principal.
// The binding is the exercise job itself: this run attempt must have run on the report's head
// (never on the harness commit, which is main), under an event whose workflow definition comes
// from the protected default branch, and the job named after the proof must have completed with
// the conclusion the report claims. The control plane reads the same job back through its own
// App before accepting the record; this reporter refuses first so a mismatch never leaves the run.

/** The events whose workflow file GitHub takes from the default branch rather than the candidate. */
export const ciRunEvents = ['pull_request_target', 'workflow_dispatch'];

/** A grant pattern authorizes a proof: an exact name, a whole family, or a bounded prefix. Mirrors src/model/proof.ts. */
export function grantAuthorizes(pattern, proof) {
  const separator = pattern.indexOf(':');
  const kind = pattern.slice(0, separator), scope = pattern.slice(separator + 1);
  if (!proof.startsWith(`${kind}:`)) return false;
  const name = proof.slice(kind.length + 1);
  if (!name) return false;
  if (scope === '*') return true;
  if (scope.endsWith('/*')) { const prefix = scope.slice(0, -1); return name.startsWith(prefix) && name.length > prefix.length; }
  return name === scope;
}

export function validateCiRun(run, jobs, report, expected) {
  if (String(run.id) !== String(expected.runId) || run.run_attempt !== Number(expected.runAttempt) || run.repository?.full_name !== expected.repository) throw new Error('GitHub run does not match this trusted reporter invocation');
  if (!ciRunEvents.includes(run.event)) throw new Error(`Workflow run event ${run.event} takes its definition from the candidate; CI evidence is published only from ${ciRunEvents.join(' or ')} runs`);
  if (run.head_sha !== report.sha) throw new Error(`Workflow run ${expected.runId} attempt ${expected.runAttempt} ran on ${run.head_sha}, not on the reported candidate head ${report.sha}`);
  if (!['in_progress', 'completed'].includes(run.status)) throw new Error('GitHub run is not a live or completed acceptance invocation');
  const family = report.proof.slice(0, report.proof.indexOf(':'));
  if (!ciProofFamilies.includes(family)) throw new Error(`${report.proof} is not an automatable proof; CI publishes ${ciProofFamilies.map(f => `${f}:*`).join(' and ')} only`);
  // The exercise job carries the proof as its name, so exactly one job of this attempt decides it.
  const matches = jobs.filter(job => job.name === report.proof && job.run_attempt === Number(expected.runAttempt));
  if (matches.length !== 1) throw new Error(`Expected exactly one ${report.proof} job in run attempt ${expected.runAttempt}, found ${matches.length}`);
  const job = matches[0];
  if (!Number.isSafeInteger(job.id) || job.id < 1 || job.head_sha !== report.sha || job.status !== 'completed') throw new Error(`Job ${report.proof} has not completed on the reported candidate head`);
  if ((report.result === 'pass') !== (job.conclusion === 'success')) throw new Error(`Job ${report.proof} concluded ${job.conclusion}; a ${report.result} report cannot be published from it`);
  if (typeof job.html_url !== 'string' || !/^https:\/\/github\.com\//.test(job.html_url)) throw new Error('Job URL is unavailable');
  return { binding: { provider: 'github-actions', repository: expected.repository, runId: String(run.id), runAttempt: run.run_attempt, jobId: job.id }, jobUrl: job.html_url };
}

export async function observeCiRun(expected, report, token, fetcher = fetch) {
  if (!token) throw new Error('GitHub token is required to verify the CI run');
  if (!/^[\w.-]+\/[\w.-]+$/.test(expected.repository ?? '')) throw new Error('Invalid repository for CI run verification');
  if (!/^[1-9]\d*$/.test(String(expected.runId ?? '')) || !/^[1-9]\d*$/.test(String(expected.runAttempt ?? ''))) throw new Error('Invalid run identity for CI run verification');
  const get = async path => {
    const response = await fetcher(`https://api.github.com/repos/${expected.repository}/actions/${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Cannot verify the GitHub run (${response.status})`);
    return response.json();
  };
  const jobs = [];
  for (let page = 1; page <= PAGE_LIMIT; page++) {
    const listing = await get(`runs/${expected.runId}/attempts/${expected.runAttempt}/jobs?per_page=${PAGE_SIZE}&page=${page}`);
    if (!Array.isArray(listing.jobs)) throw new Error('Complete GitHub job inventory is unavailable');
    jobs.push(...listing.jobs);
    if (listing.jobs.length < PAGE_SIZE) break;
  }
  const run = await get(`runs/${expected.runId}/attempts/${expected.runAttempt}`);
  return validateCiRun(run, jobs, report, expected);
}

/** Publish one CI-produced report. `configuration.ci` is the observed binding from `observeCiRun`. */
export async function publishCiReport(report, configuration, fetcher = fetch) {
  validateReport(report, configuration.expected);
  const { binding, jobUrl } = configuration.ci ?? {};
  if (!binding || !jobUrl) throw new Error('Independently observed CI run binding is required');
  if (binding.repository !== report.repository || binding.runId !== String(report.runId) || binding.runAttempt !== Number(report.runAttempt)) throw new Error('CI run binding does not match the report');
  const url = new URL(configuration.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Reporter requires a credential-free HTTPS origin');
  const request = async (path, data) => {
    const response = await fetcher(`${url.origin}/api/${path}`, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${configuration.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `ci-${report.runId}-${report.runAttempt}-${report.workId}-${report.proof}` }, body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Graphyard refused reporter request (${response.status}): ${(await response.text()).slice(0, 300)}`); return response.json();
  };
  const status = await request('status');
  if (status.actor?.role !== 'producer' || status.actor.runtime !== 'github-actions') throw new Error('Reporter identity is not the CI producer principal');
  const authority = (await request('proof-grants')).authorities?.find(entry => entry.principalId === status.actor.id);
  if (!authority?.patterns?.some(pattern => grantAuthorizes(pattern, report.proof))) throw new Error(`The CI producer is not granted ${report.proof}`);
  const work = (await request('work')).find(w => w.id === report.workId);
  if (!work || work.stage === 'done' || work.policyRevision !== report.policyRevision || work.candidate?.pr !== report.pr || work.candidate?.sha !== report.sha || work.candidate?.baseSha !== report.baseSha) throw new Error('Candidate changed or has not been observed; the push that moved it runs its own proofs');
  await request(`work/${work.id}/evidence`, { proof: report.proof, sha: report.sha, baseSha: report.baseSha, policyRevision: report.policyRevision, result: report.result, executed: report.executed, skipped: report.skipped,
    url: `https://github.com/${report.repository}/actions/runs/${report.runId}/attempts/${report.runAttempt}`,
    artifacts: [{ kind: 'log', label: `GitHub Actions job ${report.proof}`, availability: 'external', url: jobUrl }], ciRun: binding });
}

/** Every acceptance.json under a downloaded-artifacts directory, one per exercised proof. */
export async function readCiReports(directory) {
  const reports = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    try { reports.push({ artifact: entry.name, report: JSON.parse(await readFile(join(directory, entry.name, 'acceptance.json'), 'utf8')) }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return reports;
}

async function publishCandidateRun(directory) {
  const expected = {
    repository: process.env.GITHUB_REPOSITORY, harnessCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    workId: process.env.GRAPHYARD_WORK_ID, pr: process.env.GRAPHYARD_PR, policyRevision: process.env.GRAPHYARD_POLICY_REVISION,
  };
  const reports = await readCiReports(directory);
  if (!reports.length) { console.log('No proof reports to publish for this run.'); return; }
  let failures = 0;
  for (const { artifact, report } of reports) {
    try {
      const ci = await observeCiRun(expected, report, process.env.GITHUB_TOKEN);
      await publishCiReport(report, { url: process.env.GRAPHYARD_URL, token: process.env.GRAPHYARD_CI_PRODUCER_TOKEN, expected: { ...expected, proof: report.proof }, ci });
      console.log(`${report.proof}: ${report.result} evidence submitted for the tested candidate (${artifact}).`);
    } catch (error) { failures++; console.error(`${report.proof ?? artifact}: ${error.message}`); }
  }
  if (failures) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // `--candidate-run DIRECTORY` publishes every report of a candidate-push run through the CI
    // producer; a single report path is the dispatched reporter publishing one proof.
    if (process.argv[2] === '--candidate-run') await publishCandidateRun(process.argv[3] ?? 'reports');
    else {
      const report = JSON.parse(await readFile(process.argv[2], 'utf8'));
      const expected = {
        repository: process.env.GITHUB_REPOSITORY, harnessCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
        workId: process.env.GRAPHYARD_WORK_ID, pr: process.env.GRAPHYARD_PR, policyRevision: process.env.GRAPHYARD_POLICY_REVISION, proof: process.env.GRAPHYARD_PROOF,
        artifactName: process.env.GRAPHYARD_ARTIFACT_NAME ?? `graphyard-acceptance-${process.env.GITHUB_RUN_ATTEMPT}`,
      };
      const provenance = await observeArtifactProvenance(expected, process.env.GITHUB_TOKEN);
      await publishReport(report, { url: process.env.GRAPHYARD_URL, token: process.env.GRAPHYARD_PRODUCER_TOKEN, expected, provenance });
      console.log('Acceptance evidence submitted for the tested candidate.');
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
