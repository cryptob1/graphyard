// Plans the trusted CI run for one workflow invocation. Run from protected source only.
//
// A dispatch names its single proof and candidate facts as inputs. A candidate push
// (pull_request_target) instead asks the control plane which item the pull request is the
// candidate of, waits until Graphyard has observed the pushed head as that item's candidate, and
// plans every required proof in an automatable family that this checkout registers. Head, base
// and policy revision come from the control plane's candidate record, never from the event, so
// the evidence later published is bound to exactly what Graphyard will judge.
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { contract, planCiProofs } from './contracts.mjs';

const sha = value => /^[a-f0-9]{40}$/.test(value ?? '');
/** One matrix entry per proof; the slug names the report artifact, since `:` and `/` cannot. */
export const matrixEntry = ({ proof, kind }) => ({ proof, kind, slug: proof.replace(/[^\w.-]+/g, '-') });

/** The item a pull request is the current candidate of: open, submitted and not yet delivered. */
export function candidateWork(items, pr) {
  const matches = items.filter(item => item.stage !== 'done' && item.candidate?.pr === pr && item.submission);
  if (matches.length > 1) throw new Error(`Pull request #${pr} is the candidate of ${matches.map(item => item.key).join(', ')}; refusing an ambiguous plan`);
  return matches[0] ?? null;
}

/** The plan for an observed candidate: what runs, what waits, and the facts the run is bound to. */
export function ciPlan(work, head, registry) {
  if (!work) return { proofs: [], deferred: [], reason: 'no submitted candidate for this pull request', work: null };
  if (work.candidate?.sha !== head) return { proofs: [], deferred: [], reason: `Graphyard has observed ${work.candidate?.sha ?? 'no head'} as the candidate of ${work.key}, not ${head}`, work: null };
  const plan = planCiProofs(work.criteria.flatMap(criterion => criterion.proofs), registry);
  return { proofs: plan.runnable, deferred: plan.deferred, reason: null,
    work: { id: work.id, key: work.key, pr: work.candidate.pr, policyRevision: work.policyRevision, head: work.candidate.sha, base: work.candidate.baseSha } };
}

export async function planFromControlPlane({ url, token, pr, head, waitMs = 240_000, intervalMs = 10_000, fetcher = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), registry }) {
  const origin = new URL(url);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Enumeration requires a credential-free HTTPS origin');
  const read = async path => {
    const response = await fetcher(`${origin.origin}/api/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Graphyard refused the enumeration read (${response.status})`);
    return response.json();
  };
  const status = await read('status');
  if (status.actor?.role !== 'producer') throw new Error('The CI producer credential is not a producer principal');
  // Observation of a fresh push lags the event by a reconciliation pass; wait for it rather
  // than planning against the previous head.
  const deadline = Date.now() + waitMs;
  let plan = ciPlan(candidateWork(await read('work'), pr), head, registry);
  while (plan.reason && Date.now() < deadline) {
    await sleep(intervalMs);
    plan = ciPlan(candidateWork(await read('work'), pr), head, registry);
  }
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { GITHUB_EVENT_NAME: event, GRAPHYARD_PR: prText, GRAPHYARD_HEAD: head } = process.env;
    if (!/^\d+$/.test(prText ?? '')) throw new Error('Invalid pull request number');
    const outputs = {};
    if (event === 'workflow_dispatch') {
      const { GRAPHYARD_WORK_ID: workId, GRAPHYARD_POLICY_REVISION: revision, GRAPHYARD_PROOF: proof } = process.env;
      if (!/^[0-9a-f-]{36}$/.test(workId ?? '') || !/^[1-9]\d*$/.test(revision ?? '')) throw new Error('Invalid dispatch input');
      const selected = contract(proof ?? '');
      Object.assign(outputs, { mode: 'dispatch', proofs: JSON.stringify([matrixEntry({ proof, kind: selected.kind ?? 'integration' })]), pr: prText, work_id: workId, policy_revision: revision, head: '', base: '' });
      console.log(`Dispatch: ${proof} for PR #${prText}.`);
    } else if (!process.env.GRAPHYARD_URL || !process.env.GRAPHYARD_CI_PRODUCER_TOKEN) {
      // An installation that has not provisioned the CI producer yet plans nothing, visibly,
      // instead of failing every candidate push; docs/deployment.md#ci-producer says what to set.
      console.log('::warning::Proofs in CI are not provisioned: set GRAPHYARD_URL and GRAPHYARD_CI_PRODUCER_TOKEN on the graphyard-reporting environment (docs/deployment.md#ci-producer).');
      Object.assign(outputs, { mode: 'candidate', proofs: '[]', pr: prText, work_id: '', policy_revision: '', head: '', base: '' });
    } else {
      if (!sha(head)) throw new Error('Invalid candidate head');
      const plan = await planFromControlPlane({ url: process.env.GRAPHYARD_URL, token: process.env.GRAPHYARD_CI_PRODUCER_TOKEN, pr: Number(prText), head });
      if (plan.reason) console.log(`Nothing to run: ${plan.reason}.`);
      else console.log(`Planned ${plan.proofs.map(entry => entry.proof).join(', ') || 'no proofs'} for ${plan.work.key} PR #${plan.work.pr} at ${plan.work.head}${plan.deferred.length ? `; left to producer sessions: ${plan.deferred.map(entry => `${entry.proof} (${entry.reason})`).join(', ')}` : ''}.`);
      Object.assign(outputs, { mode: 'candidate', proofs: JSON.stringify(plan.proofs.map(matrixEntry)), pr: prText, work_id: plan.work?.id ?? '', policy_revision: plan.work ? String(plan.work.policyRevision) : '', head: plan.work?.head ?? '', base: plan.work?.base ?? '' });
    }
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([name, value]) => `${name}=${value}\n`).join(''));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
