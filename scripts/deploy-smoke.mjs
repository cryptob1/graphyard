// Trusted post-deployment smoke producer. The run job probes the live deployment and writes a
// report; the publish job, which alone holds the producer secret, binds that report to the exact
// deployed commit Graphyard recorded for the delivery. Nothing here executes candidate code.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const smokeProof = 'e2e:deploy-smoke';
const fullSha = value => /^[a-f0-9]{40}$/.test(value ?? '');

/** The commit the deployment reports it is serving, read from a JSON endpoint the operator configured. */
export async function servedCommit(target, fetcher = fetch) {
  const url = new URL(target.url);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Smoke target must be a credential-free HTTPS URL');
  const response = await fetcher(url.href, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Deployment endpoint answered ${response.status}`);
  const payload = await response.json();
  const value = (target.shaField ?? 'commit').split('.').reduce((node, part) => node?.[part], payload);
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) throw new Error(`Deployment endpoint did not report a full commit at ${target.shaField ?? 'commit'}`);
  return value.toLowerCase();
}

/**
 * Run the smoke checks against the live deployment. The serving commit is read before and after
 * the checks: if it is not the deployed commit Graphyard recorded, or it changes mid-run, the run
 * is not attributable to that commit and no report is produced. A moved target is not a failure
 * of the delivered change; it is a refusal to attribute.
 */
export async function runSmoke(input, fetcher = fetch, spawn = spawnSync) {
  if (!fullSha(input.deployedSha) || !fullSha(input.mergeSha)) throw new Error('Smoke run requires the deployed and merge commits Graphyard recorded');
  const before = await servedCommit(input.target, fetcher);
  if (before !== input.deployedSha) throw new Error(`Deployment serves ${before}, not the recorded deployed commit ${input.deployedSha}; the run cannot be attributed`);
  const checks = [];
  for (const url of input.checkUrls ?? []) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Smoke check URLs must be credential-free HTTPS URLs');
    let status = 0;
    try { status = (await fetcher(parsed.href, { signal: AbortSignal.timeout(15_000) })).status; } catch { status = 0; }
    checks.push({ id: `http:${parsed.pathname}`, result: status >= 200 && status < 300 ? 'pass' : 'fail', detail: `HTTP ${status || 'unreachable'}` });
  }
  if (input.command) {
    const run = spawn(input.command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: input.commandTimeoutMs ?? 600_000,
      env: { ...process.env, SMOKE_DEPLOYED_SHA: input.deployedSha, SMOKE_MERGE_SHA: input.mergeSha, SMOKE_TARGET_URL: input.target.url } });
    checks.push({ id: 'command', result: run.status === 0 ? 'pass' : 'fail', detail: run.status === null ? `terminated by ${run.signal ?? 'timeout'}` : `exit ${run.status}` });
  }
  if (!checks.length) throw new Error('Configure at least one smoke check URL or a smoke command; an empty run proves nothing');
  const after = await servedCommit(input.target, fetcher);
  if (after !== input.deployedSha) throw new Error(`Deployment changed to ${after} during the smoke run; the result cannot be attributed to ${input.deployedSha}`);
  return { schema: 1, proof: smokeProof, workId: input.workId, sha: input.deployedSha, baseSha: input.mergeSha, policyRevision: input.policyRevision,
    result: checks.every(check => check.result === 'pass') ? 'pass' : 'fail', executed: checks.length, skipped: 0, checks,
    repository: input.repository, harnessCommit: input.harnessCommit, runId: input.runId, runAttempt: input.runAttempt };
}

export function validateSmokeReport(report, expected) {
  if (report.schema !== 1 || report.proof !== smokeProof || !['pass', 'fail'].includes(report.result) || !Number.isSafeInteger(report.executed) || report.executed < 1 || report.skipped !== 0) throw new Error('Incomplete smoke report');
  if (!Array.isArray(report.checks) || report.checks.length !== report.executed || report.checks.some(check => !['pass', 'fail'].includes(check.result))) throw new Error('Smoke check inventory is incomplete');
  if (report.result === 'pass' && report.checks.some(check => check.result !== 'pass')) throw new Error('A passing smoke report cannot contain a failed check');
  for (const [key, value] of Object.entries(expected)) if (value === undefined || value === '' || String(report[key]) !== String(value)) throw new Error(`Report ${key} does not match this trusted run`);
  for (const key of ['sha', 'baseSha', 'harnessCommit']) if (!fullSha(report[key])) throw new Error(`Invalid ${key}`);
  if (!Number.isSafeInteger(report.policyRevision) || report.policyRevision < 1) throw new Error('Invalid policy revision');
  return report;
}

/**
 * Publish the verdict. Graphyard is read first so the evidence names the deployed commit it
 * actually recorded for this delivery; a delivery Graphyard has not seen deployed, or one deployed
 * at another commit, is refused here before the control plane refuses it again.
 */
export async function publishSmoke(report, configuration, fetcher = fetch) {
  validateSmokeReport(report, configuration.expected);
  const url = new URL(configuration.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Reporter requires a credential-free HTTPS origin');
  const request = async (path, data) => {
    const response = await fetcher(`${url.origin}/api/${path}`, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${configuration.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `deploy-smoke-${report.runId}-${report.runAttempt}-${report.workId}` }, body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Graphyard refused reporter request (${response.status})`); return response.json();
  };
  const status = await request('status');
  if (status.actor?.role !== 'producer' || !status.actor.proofs?.includes(smokeProof)) throw new Error('Reporter identity is not a producer authorized for e2e:deploy-smoke');
  const work = (await request('work')).find(item => item.id === report.workId);
  if (!work || work.stage !== 'done' || !work.policy?.deploySmoke) throw new Error('Work is not a delivered item whose policy requires e2e:deploy-smoke');
  if (work.policyRevision !== report.policyRevision || work.delivery?.mergeSha !== report.baseSha) throw new Error('Delivery merge commit or policy changed; rerun the smoke proof from current Graphyard state');
  if (work.delivery?.deployment?.sha !== report.sha) throw new Error('Graphyard has not recorded a deployment at the smoke-tested commit; the coordinator records it once the release serves the merge');
  await request(`work/${work.id}/evidence`, { proof: smokeProof, sha: report.sha, baseSha: report.baseSha, policyRevision: report.policyRevision, result: report.result, executed: report.executed, skipped: 0,
    url: `https://github.com/${report.repository}/actions/runs/${report.runId}/attempts/${report.runAttempt}` });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, file] = process.argv.slice(2);
  const env = process.env;
  try {
    if (mode === 'run' && file) {
      const report = await runSmoke({ workId: env.GRAPHYARD_WORK_ID, deployedSha: env.GRAPHYARD_DEPLOYED_SHA, mergeSha: env.GRAPHYARD_MERGE_SHA, policyRevision: Number(env.GRAPHYARD_POLICY_REVISION),
        target: { url: env.SMOKE_DEPLOYMENT_URL, shaField: env.SMOKE_SHA_FIELD || 'commit' },
        checkUrls: (env.SMOKE_CHECK_URLS ?? '').split(',').map(value => value.trim()).filter(Boolean), command: env.SMOKE_COMMAND || undefined,
        repository: env.GITHUB_REPOSITORY, harnessCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT });
      await writeFile(file, JSON.stringify(report, null, 2));
      console.log(`Smoke ${report.result}: ${report.executed} check(s) against ${report.sha}.`);
      if (report.result !== 'pass') process.exitCode = 1;
    } else if (mode === 'publish' && file) {
      await publishSmoke(JSON.parse(await readFile(file, 'utf8')), { url: env.GRAPHYARD_URL, token: env.GRAPHYARD_PRODUCER_TOKEN, expected: {
        repository: env.GITHUB_REPOSITORY, harnessCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
        workId: env.GRAPHYARD_WORK_ID, sha: env.GRAPHYARD_DEPLOYED_SHA, baseSha: env.GRAPHYARD_MERGE_SHA, policyRevision: env.GRAPHYARD_POLICY_REVISION } });
      console.log('Post-deployment smoke evidence submitted for the recorded deployment.');
    } else throw new Error('Usage: deploy-smoke run report.json | deploy-smoke publish report.json');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
