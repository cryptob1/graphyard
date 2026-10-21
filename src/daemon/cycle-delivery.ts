// Concern: cycle steps 5–7 — shepherd reviews, escalate merges the gates never authorized, the release-level deployment reading.
import { reviewProviderOf, reviewerProfileFor, exhaustedReviewerProfiles } from '../model.js';
import { type Work } from '../model.js';
import { mergedWithoutAuthorization, unauthorizedMergeViolation } from '../model/merge-authorization.js';
import { boundDeployment, type DaemonAction, type DaemonState, deploymentObservationSchema, message, storeAction } from './state.js';
import { candidateKey } from './reconcile.js';
import { readyToRetry } from './sessions.js';
import { detailChanged, exhaustedProofEscalation, exhaustedProofKey, standingVerdict } from './decisions.js';
import { record } from './effects.js';
import type { Cycle } from './cycle.js';
import { defaultDeploymentReuseMinutes, deploymentDetail, deploymentStepBudgetMs, reusableDeployment, stillVerifying, withinDeploymentBudget } from './deployment.js';
import { readingDueNow, readingsStep } from './cycle-readings.js';
import { throughputRemeasureAt } from '../throughput.js';

/** Step 5: shepherd reviews for submitted candidates. */
export async function shepherdStep(cycle: Cycle) {
  const { state, effects, now, performed, isolate, open } = cycle;
  // 5. Shepherd reviews for submitted candidates. Graphyard dispatches provider reviews; the daemon
  //    records exactly one request per candidate and escalates what only a human may resolve.
  //    Proofs gate nothing and no producer is requested (GY-1266, GY-1235).
  //    A producer request whose attempts are used up is raised here the cycle it is first seen
  //    (GY-496); the decision step requests the rework on a later cycle (cycle-decisions.ts).
  const exhausted = await cycle.exhaustedProofs();
  for (const item of open.filter(candidate => candidate.submission && candidate.candidate && !candidate.reworkRequested && !standingVerdict(candidate))) await isolate('proof', item, item.key, async () => {
    const reviewGate = item.gates.find(gate => gate.name === 'review');
    if (reviewGate && !reviewGate.passed) {
      const key = candidateKey('review', item);
      const provider = reviewProviderOf(item.policy);
      const exhausted = provider === 'agent' && !reviewerProfileFor(item) && exhaustedReviewerProfiles(item).length > 0;
      if (exhausted) {
        const escalation = `${item.key}: every configured reviewer profile is exhausted for the current candidate (${exhaustedReviewerProfiles(item).join(', ')}); add reviewer capacity or revise the review policy. Exhaustion is never an approval.`;
        const escalationKey = `escalation:review:${item.id}:${item.candidate!.sha}:${item.policyRevision}`;
        if (state.actions[escalationKey]?.state !== 'done') performed.push(await record(state, escalationKey, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail: escalation, attempts: 1, cycle: state.cycle }, now(), effects.persist));
      } else {
        const detail = provider === 'github' ? `${item.key}: an independent reviewer session's approval of the current commit is required; the coordinator cannot supply it`
          : item.reviewRequest ? `${item.key}: Graphyard dispatched ${provider} review to profile ${item.reviewRequest.profile ?? provider}; waiting for a verdict on ${item.candidate!.sha.slice(0, 12)}`
            : `${item.key}: waiting for Graphyard to dispatch a ${provider} review for ${item.candidate!.sha.slice(0, 12)}`;
        if (detailChanged(state.actions[key], detail)) performed.push(await record(state, key, { kind: 'review', work: item.key, principal: null, state: 'done', detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      }
    }
    for (const entry of exhausted.filter(entry => entry.work === item.key && entry.sha === item.candidate!.sha)) {
      const key = exhaustedProofKey(entry);
      if (!state.actions[key]) performed.push(await record(state, key, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail: exhaustedProofEscalation(entry), attempts: 1, cycle: state.cycle }, now(), effects.persist));
    }
  });
}

/**
 * Step 6: the control-plane merge writer's trial, push and merge ledger are authoritative for what
 * landed (docs/delivery.md); this step merges nothing. It names, once, a merge whose gates had not
 * passed on its head — held as a violation until a two-party decision reconciles it.
 */
export async function mergeStep(cycle: Cycle) {
  const { state, effects, now, performed, isolate, open } = cycle;
  for (const item of open.filter(mergedWithoutAuthorization)) await isolate('escalation', item, item.key, async () => {
    const key = `${candidateKey('escalation', item)}:merged`;
    if (state.actions[key]?.state === 'done') return;
    performed.push(await record(state, key, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail: `${item.key} was merged (${item.observation!.mergeSha?.slice(0, 12) ?? 'merge commit unknown'} at ${item.observation!.mergedAt ?? 'an unrecorded time'}) though its gates had not passed on that head: ${unauthorizedMergeViolation}. It stays at the merge stage until a two-party decision reconciles it: graphyard master decide ${item.key} merge REASON, then graphyard master approver ${item.key} DECISION; Graphyard re-checks the record at the merge cutoff and delivers on the approved decision`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
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

  // 7a'''. GY-1385: GY-87's throughput claim is measured, not asserted. After a verified deployment
  //        the loop records a measurement for the release the control plane serves, with its own
  //        coordinator credential, reading only the window's deliveries whole; master status reads
  //        it back as verified or with its shortfall. One action per observed release: a plane that
  //        does not serve it yet answers `waiting`, asked again on the failure backoff (one status
  //        read per ask, never one per cycle) until it serves or a newer observation supersedes the
  //        key; a failure backs off the same way. It follows a verification: a cycle whose
  //        observation is still in flight (cut by the budget) starts no measurement, so the step
  //        never holds two reads in flight. GY-1437/GY-1438: the verification is live — an
  //        unverified answer is not settled, so it is asked again on the same backoff and the
  //        measurement is re-taken once its record is throughputRemeasureMs old. GY-1458: the
  //        re-measure is asked in the cycle that finds it due, whatever the backoff has grown to.
  //        GY-2186: the verification is owned by nobody — no owner item is filed or closed, and a
  //        needs-decision a measurement shows is the throughput attention line alone.
  const verified = observed !== stillVerifying && observed.ok ? state.deployment : null, measure = effects.measureThroughput;
  if (measure && verified && verified.source !== 'unavailable' && verified.sha) {
    const key = `throughput:${verified.sha}`, previous = state.actions[key];
    if (throughputAskDue(previous, state.cycle, now())) {
      const measured = await withinDeploymentBudget(state, 'throughput', () => measure(snapshot.work, verified.sha!), deadline, now);
      if (measured === stillVerifying) deferred.push('the throughput measurement');
      else {
        const outcome = measured.ok ? measured.value : null;
        const detail = outcome ? outcome.detail : `GY-87's throughput measurement could not be recorded for ${verified.sha.slice(0, 12)}: ${message((measured as { error: unknown }).error)}`;
        // An unverified measurement of the serving release is not settled (GY-1437): it waits on the
        // same backoff and is measured again as session-free deliveries accumulate.
        const unverified = outcome?.settled === false || outcome?.verdict === 'unverified';
        const entryState = !outcome ? 'failed' : outcome.outcome === 'waiting' || unverified ? 'waiting' : 'done';
        // Every ask is recorded, so the backoff counts them; a wait whose reason stands is not reported again.
        const entry = await record(state, key, { kind: 'deployment', work: null, principal: null, state: entryState, detail, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
        if (entryState !== 'waiting' || detailChanged(previous, detail)) performed.push(entry);
      }
    }
    // GY-2186: the loop raises no needs-decision on a throughput owner any more — no owner item is
    // filed or closed, and the measurement's needs-decision is the attention line alone. An
    // escalation an earlier loop raised settles here, so no cursor row waits on an owner nobody moves.
    settleThroughputEscalations(state);
  }

  const served = state.deployment;
  // 7c. GY-1779: the loop's own due readings of loop-owned observation items on the release verified above
  //     (cycle-readings.ts). An observation still in flight verifies nothing this cycle: the due readings
  //     are deferred with it, never taken on the release the last cycle observed.
  const readingsDeferred = await readingsStep(cycle, observed === stillVerifying ? stillVerifying : served, deadline);
  if (readingsDeferred) deferred.push(`${readingsDeferred} loop-owned observation readings`);
  await noteDeploymentBudget(cycle, budgetMs, deferred);
}

/**
 * When the throughput measurement for an observed release is asked again: a release never asked
 * is asked now, a settled one (`done`, verified) never again, and a wait on the plane, an
 * unverified measurement still accumulating its population (GY-1437), or a failure on the
 * failure backoff (`readyToRetry`, doubling per ask up to its cap), so a plane that lags the
 * deployment record costs one status read per ask rather than per cycle. GY-1458: an unverified
 * answer naming its re-measure time (`throughputRemeasureAt`) is asked as soon as that time comes,
 * whatever the backoff has grown to: thirty cycles of backoff outlast the hour the loop promises.
 */
export function throughputAskDue(previous: DaemonAction | undefined, cycle: number, now: number) {
  const remeasureAt = previous?.state === 'waiting' && answeredVerdict(previous) === 'unverified' ? throughputRemeasureAt(previous.detail) : null;
  if (remeasureAt !== null && now >= remeasureAt) return true;
  return readyToRetry(previous?.state === 'waiting' ? { ...previous, state: 'failed' } : previous, cycle);
}

/**
 * GY-1438: the verdict the release's recorded answer names — the verdict word a `recorded` answer
 * gives after its revision (`: unverified:`) or a `current` one in its parenthesis (`(verified,`) —
 * or null for any other answer: a wait on the plane, a failure or a skip names none.
 */
export function answeredVerdict(answer: DaemonAction | undefined): 'verified' | 'unverified' | null {
  const named = answer && answer.state !== 'failed' ? /(?:: |\()(unverified|verified)[:,]/.exec(answer.detail) : null;
  return named ? named[1] as 'verified' | 'unverified' : null;
}

/**
 * The action key the loop's old raises used for a needs-decision on a throughput owner, keyed by the
 * owner's requirements revision when it was raised, so only a revision applied after it answers it
 * (`throughputOwnerAnswered`). GY-2186 retired the raises: no owner item is filed or closed, and the
 * needs-decision a measurement shows is the throughput attention line alone. The key stays so
 * `throughputEscalatedAt` still reads what an earlier loop raised, which the attention line names.
 */
export const throughputEscalationKey = (owner: string, policyRevision: number) => `escalation:throughput:${owner}:${policyRevision}`;
/**
 * The owner's requirements revision at which the loop raised its needs-decision (the earliest, should a key repeat), or null when it raised none.
 * Read by the throughput attention (master-status-sections.ts) to word what an applied revision answered. The old
 * `waiting` raises settle through settleThroughputEscalations, and a settled row still answers here.
 */
export function throughputEscalatedAt(actions: Record<string, DaemonAction>, owner: Pick<Work, 'key'>): number | null {
  const prefix = `escalation:throughput:${owner.key}:`;
  const raised = Object.entries(actions).filter(([key, action]) => key.startsWith(prefix) && (action.state === 'waiting' || action.state === 'done') && action.work === owner.key)
    .map(([key]) => Number(key.slice(prefix.length))).filter(Number.isInteger);
  return raised.length ? Math.min(...raised) : null;
}

/**
 * GY-2186: every throughput escalation an earlier loop raised on an owner item is settled at once.
 * No owner item is filed or closed any more, so no raise has an owner to wait on: the decision the
 * measurement shows is the throughput attention line alone, and the cursor keeps no row waiting on
 * an owner nobody moves. `done` keeps the raise readable (throughputEscalatedAt).
 */
function settleThroughputEscalations(state: DaemonState) {
  for (const [key, action] of Object.entries(state.actions)) {
    if (key.startsWith('escalation:throughput:') && action.state === 'waiting') storeAction(state, key, { ...action, state: 'done' }, null);
  }
}


/** Record a budget-cut step, so the journal and `master status` say verification is in flight rather than blind; a full step supersedes the last cut once. */
async function noteDeploymentBudget(cycle: Pick<Cycle, 'state' | 'effects' | 'now' | 'performed'>, budgetMs: number, deferred: string[]) {
  const { state, effects, now, performed } = cycle, key = 'deployment:deferred', standing = state.actions[key];
  const within = 'The deployment step verified within its budget';
  if (!deferred.length) {
    if (standing && !standing.detail.startsWith(within)) performed.push(await record(state, key, { kind: 'deployment', work: null, principal: null, state: 'done', attempts: standing.attempts + 1, cycle: state.cycle, detail: `${within}; nothing is left in flight` }, now(), effects.persist, null));
    return;
  }
  performed.push(await record(state, key, { kind: 'deployment', work: null, principal: null, state: 'done', attempts: (standing?.attempts ?? 0) + 1, cycle: state.cycle,
    detail: `The deployment step spent its ${Math.round(budgetMs / 1000)}s budget before ${deferred.join(' and ')} finished, so the last verified observation stands and a later cycle resumes: it takes the answer of the read still in flight once it lands rather than starting another` }, now(), effects.persist, null));
}
