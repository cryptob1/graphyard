// Concern: cycle steps 5–7 — shepherd reviews, name merges the gates never authorized, the release-level deployment reading.
import { reviewProviderOf, reviewerProfileFor, exhaustedReviewerProfiles } from '../model.js';
import { type Work } from '../model.js';
import { mergedWithoutAuthorization, unauthorizedMergeViolation } from '../model/merge-authorization.js';
import { boundDeployment, deploymentObservationSchema, message } from './state.js';
import { candidateKey } from './reconcile.js';
import { detailChanged } from './text.js';
import { exhaustedProofDetail, exhaustedProofKey, standingVerdict } from './rework.js';
import { record } from './effects.js';
import type { Cycle } from './cycle.js';
import { defaultDeploymentReuseMinutes, deploymentDetail, deploymentStepBudgetMs, reusableDeployment, stillVerifying, withinDeploymentBudget } from './deployment.js';
import { readingDueNow, readingsStep } from './cycle-readings.js';

/** Step 5: shepherd reviews for submitted candidates. */
export async function shepherdStep(cycle: Cycle) {
  const { state, effects, now, performed, isolate, open } = cycle;
  // 5. Shepherd reviews for submitted candidates. Graphyard dispatches provider reviews; the daemon
  //    records exactly one request per candidate.
  //    Proofs gate nothing and no producer is requested (GY-1266, GY-1235).
  //    A producer request whose attempts are used up is raised here the cycle it is first seen
  //    (GY-496); the rework step applies the rework on a later cycle (rework.ts).
  const exhausted = await cycle.exhaustedProofs();
  for (const item of open.filter(candidate => candidate.submission && candidate.candidate && !candidate.reworkRequested && !standingVerdict(candidate))) await isolate('proof', item, item.key, async () => {
    const reviewGate = item.gates.find(gate => gate.name === 'review');
    if (reviewGate && !reviewGate.passed) {
      const key = candidateKey('review', item);
      const provider = reviewProviderOf(item.policy);
      const exhausted = provider === 'agent' && !reviewerProfileFor(item) && exhaustedReviewerProfiles(item).length > 0;
      const detail = exhausted ? `${item.key}: every configured reviewer profile is exhausted for the current candidate (${exhaustedReviewerProfiles(item).join(', ')}); add reviewer capacity or revise the review policy. Exhaustion is never an approval.`
        : provider === 'github' ? `${item.key}: an independent reviewer session's approval of the current commit is required; the coordinator cannot supply it`
          : item.reviewRequest ? `${item.key}: Graphyard dispatched ${provider} review to profile ${item.reviewRequest.profile ?? provider}; waiting for a verdict on ${item.candidate!.sha.slice(0, 12)}`
            : `${item.key}: waiting for Graphyard to dispatch a ${provider} review for ${item.candidate!.sha.slice(0, 12)}`;
      if (detailChanged(state.actions[key], detail)) performed.push(await record(state, key, { kind: 'review', work: item.key, principal: null, state: 'done', detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
    }
    for (const entry of exhausted.filter(entry => entry.work === item.key && entry.sha === item.candidate!.sha)) {
      const key = exhaustedProofKey(entry);
      if (!state.actions[key]) performed.push(await record(state, key, { kind: 'proof', work: item.key, principal: null, state: 'done', detail: exhaustedProofDetail(entry), attempts: 1, cycle: state.cycle }, now(), effects.persist));
    }
  });
}

/**
 * Step 6: the control-plane merge writer's trial, push and merge ledger are authoritative for what
 * landed (docs/delivery.md); this step merges nothing. It names, once, a merge whose gates had not
 * passed on its head — held as a violation, with a follow-up item to re-verify what it skipped.
 */
export async function mergeStep(cycle: Cycle) {
  const { state, effects, now, performed, isolate, open } = cycle;
  for (const item of open.filter(mergedWithoutAuthorization)) await isolate('merge', item, item.key, async () => {
    const key = `${candidateKey('merge', item)}:unauthorized`;
    if (state.actions[key]?.state === 'done') return;
    performed.push(await record(state, key, { kind: 'merge', work: item.key, principal: null, state: 'done', detail: `${item.key} was merged (${item.observation!.mergeSha?.slice(0, 12) ?? 'merge commit unknown'} at ${item.observation!.mergedAt ?? 'an unrecorded time'}) though its gates had not passed on that head: ${unauthorizedMergeViolation}. It stays at the merge stage with its violation; graphyard master create FILE files the follow-up that re-verifies what the merge skipped`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
  });
}

/** Step 7: observe what is actually deployed, as one release-level reading; a merged item is already done (GY-1981). */
export async function deploymentStep(cycle: Cycle) {
  const { config, state, effects, now, snapshot, performed } = cycle;
  // 7. Verify what is actually deployed. This is an observation, never a gate: Graphyard already
  //    marked the work Done on an observed merge, and a lagging rollout must stay visible as lag.
  const delivered = snapshot.work.filter(item => item.stage === 'done' && item.delivery)
    .sort((a, b) => Date.parse(a.delivery!.mergedAt) - Date.parse(b.delivery!.mergedAt));
  const deploymentKey = `deployment:${delivered.at(-1)?.delivery?.mergeSha ?? 'none'}`;
  // GY-1354: the step's reads share one per-cycle budget. A read still running at the bound is left
  // in flight and the last verified observation stands; a later cycle takes its answer, not a new read.
  // A carried answer was computed for the deliveries of the cycle that asked; recorded under this
  // cycle's key, it leaves out a delivery landed since until the next read answers for that one too.
  const budgetMs = deploymentStepBudgetMs(config.run.intervalSeconds * 1000), deadline = now() + budgetMs, deferred: string[] = [];
  // GY-1398: a verified observation younger than the reuse window that already places every
  // delivery and leaves none pending stands as it is: the cycle starts no release read at all.
  const reuseMs = (config.run.deploymentReuseMinutes ?? defaultDeploymentReuseMinutes) * 60_000;
  // A due loop-owned reading binds to the release read now: a reused observation up to the window old may name a release production has since left.
  const reused = !readingDueNow(cycle) && reusableDeployment(state.deployment, delivered, now(), reuseMs);
  const observed = reused ? { ok: true as const, value: state.deployment! } : await withinDeploymentBudget(state, 'observation', () => effects.observeDeployment(delivered, state.deployment?.containment ?? null), deadline, now);
  if (observed === stillVerifying) deferred.push('the release observation');
  else if (!reused) try {
    if (!observed.ok) throw observed.error;
    const observation = observed.value;
    state.deployment = deploymentObservationSchema.parse(boundDeployment(observation));
    if (detailChanged(state.actions[deploymentKey], deploymentDetail(state.deployment))) {
      performed.push(await record(state, deploymentKey, { kind: 'deployment', work: null, principal: null, state: observation.source === 'unavailable' ? 'failed' : 'done', detail: deploymentDetail(state.deployment), attempts: (state.actions[deploymentKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
    }
  } catch (error) {
    // A failed observation keeps the containment already established: it is a record of releases
    // that did serve these deliveries, and nothing about this failure makes that untrue.
    state.deployment = boundDeployment({ source: 'unavailable' as const, sha: null, at: new Date(now()).toISOString(), reason: message(error), deployed: [], pending: delivered.map(item => item.key), containment: state.deployment?.containment ?? null });
    performed.push(await record(state, deploymentKey, { kind: 'deployment', work: null, principal: null, state: 'failed', detail: `Deployment SHA could not be verified: ${message(error)}`, attempts: (state.actions[deploymentKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
  }

  // 7a'. The control plane reads a release as live under the environment named here; a failed
  //      publication is retried next cycle and holds nothing else back.
  if (effects.publishProductionEnvironment) await effects.publishProductionEnvironment().catch(() => undefined);

  // 7a''. GY-1982: no promotion drive: the between-cycles self-upgrade deploys each new base tip itself.

  const served = state.deployment;
  // 7c. GY-1779: the loop's own due readings of loop-owned observation items on the release verified above
  //     (cycle-readings.ts). An observation still in flight verifies nothing this cycle: the due readings
  //     are deferred with it, never taken on the release the last cycle observed.
  const readingsDeferred = await readingsStep(cycle, observed === stillVerifying ? stillVerifying : served, deadline);
  if (readingsDeferred) deferred.push(`${readingsDeferred} loop-owned observation readings`);
  await noteDeploymentBudget(cycle, budgetMs, deferred);
}

/** Record a budget-cut step, so the journal and `master status` say verification is in flight rather than blind; a full step supersedes the last cut once. */
async function noteDeploymentBudget(cycle: Pick<Cycle, 'state' | 'effects' | 'now' | 'performed'>, budgetMs: number, deferred: string[]) {
  const { state, effects, now, performed } = cycle, key = 'deployment:deferred', standing = state.actions[key];
  const within = 'The deployment step verified within its budget';
  if (!deferred.length) {
    if (standing && !standing.detail.startsWith(within)) performed.push(await record(state, key, { kind: 'deployment', work: null, principal: null, state: 'done', attempts: standing.attempts + 1, cycle: state.cycle, detail: `${within}; nothing is left in flight` }, now(), effects.persist));
    return;
  }
  performed.push(await record(state, key, { kind: 'deployment', work: null, principal: null, state: 'done', attempts: (standing?.attempts ?? 0) + 1, cycle: state.cycle,
    detail: `The deployment step spent its ${Math.round(budgetMs / 1000)}s budget before ${deferred.join(' and ')} finished, so the last verified observation stands and a later cycle resumes: it takes the answer of the read still in flight once it lands rather than starting another` }, now(), effects.persist));
}
