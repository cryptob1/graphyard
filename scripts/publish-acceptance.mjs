import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { contract } from './contracts.mjs';

export function validateReport(report, expected) {
  // The inventory is selected by the reported proof and fixed in protected source; a report can
  // never widen, shrink, or rename the cases its own proof requires.
  const { requiredCases } = contract(report.proof);
  if (report.schema !== 1 || !['pass', 'fail'].includes(report.result) || !Number.isSafeInteger(report.executed) || report.executed < 0 || report.executed > requiredCases.length || report.skipped !== 0) throw new Error('Incomplete acceptance report');
  if (!Array.isArray(report.cases) || report.cases.length !== requiredCases.length || requiredCases.some(id => report.cases.filter(c => c.id === id && ['pass', 'fail'].includes(c.result)).length !== 1)) throw new Error('Required acceptance case inventory is incomplete');
  if (report.result === 'pass' && (report.cases.some(c => c.result !== 'pass') || report.executed !== requiredCases.length)) throw new Error('Required acceptance cases did not all pass');
  for (const [key, value] of Object.entries(expected)) if (value === undefined || value === '' || String(report[key]) !== String(value)) throw new Error(`Report ${key} does not match this trusted run`);
  for (const key of ['sha', 'baseSha', 'testedTree', 'harnessCommit']) if (!/^[a-f0-9]{40}$/.test(report[key] ?? '')) throw new Error(`Invalid ${key}`);
  if (!Number.isSafeInteger(report.policyRevision) || report.policyRevision < 1) throw new Error('Invalid policy revision');
  return report;
}
export async function publishReport(report, configuration, fetcher = fetch) {
  validateReport(report, configuration.expected);
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
  await request(`work/${work.id}/evidence`, { proof: report.proof, sha: report.sha, baseSha: report.baseSha, policyRevision: report.policyRevision, result: report.result, executed: report.executed, skipped: 0,
    url: `https://github.com/${report.repository}/actions/runs/${report.runId}/attempts/${report.runAttempt}` });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = JSON.parse(await readFile(process.argv[2], 'utf8'));
    await publishReport(report, { url: process.env.GRAPHYARD_URL, token: process.env.GRAPHYARD_PRODUCER_TOKEN, expected: {
      repository: process.env.GITHUB_REPOSITORY, harnessCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      workId: process.env.GRAPHYARD_WORK_ID, pr: process.env.GRAPHYARD_PR, policyRevision: process.env.GRAPHYARD_POLICY_REVISION, proof: process.env.GRAPHYARD_PROOF,
    } });
    console.log('Acceptance evidence submitted for the tested candidate.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
