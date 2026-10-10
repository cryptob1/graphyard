// Concern: cycle steps 5–7 — shepherd reviews, reconcile what GitHub merged, deployment verification.
import { createHash } from 'node:crypto';
import { reviewProviderOf, reviewerProfileFor, exhaustedReviewerProfiles, deploySmokeRequired, deliveryState, rollbackGuidance } from '../model.js';
import { type Work } from '../model.js';
import { mergedWithoutAuthorization, unauthorizedMergeViolation } from '../merge-queue.js';
import { boundDeployment, type DaemonAction, type DaemonState, deploymentObservationSchema, maxProofAttempts, message, retainedActions, storeAction } from './state.js';
import { candidateKey } from './reconcile.js';
import { readyToRetry } from './sessions.js';
import { detailChanged, exhaustedProofEscalation, exhaustedProofKey, githubPause, observationWakeDue, standingVerdict, type RoutineDecision } from './decisions.js';
import { record } from './effects.js';
import type { Cycle } from './cycle.js';
import { defaultDeploymentReuseMinutes, defaultPromoteEveryMinutes, deploymentDetail, deploymentStepBudgetMs, promotionCycle, promotionWorkflow, reusableDeployment, stillVerifying, withinDeploymentBudget } from './deployment.js';
import { mainGuardAttention } from '../main-guard.js';
import { promotionFreeze } from './main-watch.js';
import { openThroughputOwner, throughputAnsweredAt, throughputClaim, throughputDecisionCause, throughputDecisionRelease, throughputHandAsked, throughputOwnerAnsweredBy, throughputOwnerClosure, throughputOwnerItem, throughputRemeasureAt, throughputSelfAsked, throughputStallText, type ThroughputStall } from '../throughput.js';

/**
 * GY-710. Wake the item's observation job for a step refused on a stale observation — a rework —
 * through the effects' `resync`. One wake stands until an observation newer than it
 * lands (`observationWakeDue`); it is stamped on the snapshot's clock, the one the observation's
 * time is on. A wake that failed stamps no standing wake: it is sent again on the cycle backoff.
 */
export async function wakeObservationJob(cycle: Cycle, item: Work, why: string) {
  const { state, effects, now, snapshot, clock, performed } = cycle;
  if (!effects.wakeObservation) return;
  const key = `wake:observation:${item.id}`, previous = state.actions[key];
  if (previous?.state === 'failed' ? !readyToRetry(previous, state.cycle) : !observationWakeDue(item, previous?.at, clock, githubPause(snapshot.jobs, clock))) return;
  const note = async (outcome: 'done' | 'failed', detail: string, at: number) =>
    performed.push(await record(state, key, { kind: 'refresh', work: item.key, principal: null, state: outcome, detail, attempts: outcome === 'failed' ? (previous?.state === 'failed' ? previous.attempts : 0) + 1 : 1, epoch: item.epoch, cycle: state.cycle }, at, effects.persist));
  try { await effects.wakeObservation(item); await note('done', `Woke the observation job of ${item.key}: its ${why} waits for an observation newer than ${item.observation?.at ?? 'none'}`, clock); }
  catch (error) { await note('failed', `Could not wake the observation job of ${item.key}: ${message(error)}`, now()); }
}

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
        const detail = provider === 'github' ? `${item.key}: an independent GitHub approval of the current commit is required; the coordinator cannot supply it`
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
 * Step 6: reconcile what GitHub merged. GitHub merges a candidate whose build, review and required
 * checks passed on its head (docs/delivery.md); the merged observation records the delivery. The
 * loop runs no merge of its own: it names, once, a merge whose gates had not passed — held as a
 * violation until a two-party decision reconciles it — and a revert the main guard abandoned.
 */
export async function mergeStep(cycle: Cycle) {
  const { state, effects, now, performed, isolate, open } = cycle;
  for (const item of open.filter(mergedWithoutAuthorization)) await isolate('escalation', item, item.key, async () => {
    const key = `${candidateKey('escalation', item)}:merged`;
    if (state.actions[key]?.state === 'done') return;
    performed.push(await record(state, key, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail: `${item.key} was merged on GitHub (${item.observation!.mergeSha?.slice(0, 12) ?? 'merge commit unknown'} at ${item.observation!.mergedAt ?? 'an unrecorded time'}) though its gates had not passed on that head: ${unauthorizedMergeViolation}. It stays at the merge stage until a two-party decision reconciles it: graphyard master decide ${item.key} merge REASON, then graphyard master approver ${item.key} DECISION; Graphyard re-checks the record at the merge cutoff and delivers on the approved decision`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
  });
  //    A revert the main guard abandoned (GY-1250) is raised as one attention line naming the
  //    merge, the failing check and the revert PR; nothing waits on it. One abandoned while main's
  //    check failed (`red`, GY-1332) is raised every cycle until main's latest run of each failing
  //    check passes, then once more as recovered; an older record is raised once. Once the cursor
  //    holds as many resolved rows as pruneDaemonState keeps, a revert abandoned before the oldest of
  //    them may have had its row retired, so it is not raised again unless its row is still held
  //    (`mainGuardAttention`'s `since`); a red line's row is re-recorded every cycle, so it is.
  const abandoned = (cycle.snapshot?.work ?? []).filter(item => item.mainGuardReverts?.some(revert => revert.state === 'abandoned'));
  if (abandoned.length) {
    const resolved = Object.entries(state.actions).filter(([key, action]) => (action.state === 'done' || action.state === 'failed') && !state.faults.failing[key]);
    const since = resolved.length >= retainedActions ? Math.min(...resolved.map(([, action]) => Date.parse(action.at))) : -Infinity;
    for (const line of mainGuardAttention(abandoned, since, key => Boolean(state.actions[key]))) {
      const previous = state.actions[line.key];
      const raise = async (detail: string) => { performed.push(await record(state, line.key, { kind: 'escalation', work: line.work, principal: null, state: 'done', detail, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist)); };
      // Without a reader of main's check runs the loop cannot tell when main is green again, so it raises the line once.
      if (!line.red.length || !effects.baseCheck) { if (!previous) await raise(line.text); continue; }
      if (previous?.detail === line.recovered) continue;
      // A check whose run on main cannot be read is not known to pass: main is still red.
      const passed = await Promise.all(line.red.map(check => effects.baseCheck!(check).then(base => base.state === 'passed', () => false)));
      await raise(passed.every(Boolean) ? line.recovered : line.text);
    }
  }
}

/** Step 7: verify what is actually deployed, and request the smoke proofs deliveries ask for. */
export async function deploymentStep(cycle: Cycle) {
  const { config, state, effects, now, snapshot, performed, isolate } = cycle;
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
  const reused = reusableDeployment(state.deployment, delivered, now(), reuseMs);
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

  // 7a''. Promotion is the loop's, not GitHub's cron, which is best-effort and on 2026-10-05 dropped
  //       four scheduled runs in a row (GY-1302): as soon as the base branch has moved past the last
  //       promoted SHA and the last cut, no candidate is in validation and the run.promoteEveryMinutes
  //       minimum gap has passed since the last dispatch (GY-1488), the release-candidate workflow is
  //       dispatched with promote=true.
  //       A failed read or dispatch is recorded under one key and retried with backoff, and the
  //       cycle's read and dispatch stamps are kept, so a failure never repeats every cycle.
  const promotion = effects.promotion, promotionFailure = 'promotion:failed';
  if (promotion && readyToRetry(state.actions[promotionFailure], state.cycle)) {
    const checked = await withinDeploymentBudget(state, 'promotion', () => promotionCycle(state.promotion ?? null, promotion, { now: now(), everyMinutes: config.run.promoteEveryMinutes ?? defaultPromoteEveryMinutes, intervalMs: config.run.intervalSeconds * 1000, ...promotionFreeze(effects.mainWatch?.freeze ?? false, state.mainWatch) }), deadline, now);
    if (checked === stillVerifying) deferred.push('the promotion check');
    else {
      if (!checked.ok) throw checked.error;
      const result = checked.value;
      state.promotion = result.state;
      if (result.failure) {
        const detail = `Promotion could not be checked or dispatched: ${result.failure}`;
        performed.push(await record(state, promotionFailure, { kind: 'deployment', work: null, principal: null, state: 'failed', detail, attempts: (state.actions[promotionFailure]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      } else if (state.actions[promotionFailure]) delete state.actions[promotionFailure];
      if (result.dispatched) performed.push(await record(state, `promotion:${result.state.mainSha}`, { kind: 'deployment', work: null, principal: null, state: 'done', detail: result.state.reason ?? `Dispatched ${promotionWorkflow}`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
    }
  }

  // 7a'''. GY-1385: GY-87's throughput claim is measured, not asserted. After a verified deployment
  //        the loop records a measurement for the release the control plane serves, with its own
  //        coordinator credential, reading only the window's deliveries whole; master status reads
  //        it back as verified or with its shortfall. One action per observed release: a plane that
  //        does not serve it yet answers `waiting`, asked again on the failure backoff (one status
  //        read per ask, never one per cycle) until it serves or a newer observation supersedes the
  //        key; a failure backs off the same way. It follows a verification: a cycle whose
  //        observation is still in flight (cut by the budget) starts no measurement, so the step
  //        never holds two reads in flight. GY-1437/GY-1438: the verification is owned and live — an
  //        unverified answer is not settled, so it is asked again on the same backoff and the
  //        measurement is re-taken once its record is throughputRemeasureMs old; throughputOwnerStep
  //        files and closes the owner item and raises that decision. GY-1458: the re-measure is
  //        asked in the cycle that finds it due, whatever the backoff has grown to, and a standing
  //        needs-decision no longer holds it back, so the measurement never stands past that bound.
  const verified = observed !== stillVerifying && observed.ok ? state.deployment : null, measure = effects.measureThroughput;
  if (measure && verified && verified.source !== 'unavailable' && verified.sha) {
    const key = `throughput:${verified.sha}`, previous = state.actions[key];
    let stall: ThroughputStall | null = null;
    if (throughputAskDue(previous, state.cycle, now())) {
      const measured = await withinDeploymentBudget(state, 'throughput', () => measure(snapshot.work, verified.sha!), deadline, now);
      if (measured === stillVerifying) deferred.push('the throughput measurement');
      else {
        const outcome = measured.ok ? measured.value : null;
        const detail = outcome ? outcome.detail : `GY-87's throughput measurement could not be recorded for ${verified.sha.slice(0, 12)}: ${message((measured as { error: unknown }).error)}`;
        // An unverified measurement of the serving release is not settled (GY-1437): it waits on the
        // same backoff and is measured again as session-free deliveries accumulate. Its verdict stays
        // in the detail (`answeredVerdict`) for the owner step.
        const unverified = outcome?.settled === false || outcome?.verdict === 'unverified';
        const entryState = !outcome ? 'failed' : outcome.outcome === 'waiting' || unverified ? 'waiting' : 'done';
        // Every ask is recorded, so the backoff counts them; a wait whose reason stands is not reported again.
        const entry = await record(state, key, { kind: 'deployment', work: null, principal: null, state: entryState, detail, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
        if (entryState !== 'waiting' || detailChanged(previous, detail)) performed.push(entry);
        stall = outcome?.stall ?? null;
      }
    }
    await throughputOwnerStep(cycle, verified.sha, snapshot.work, stall);
  }

  // 7b. The second confidence layer. For each delivery whose policy asks for a smoke proof: record
  //     the observation on Graphyard once the release serves its merge, ask the provider to run the
  //     trusted smoke workflow against exactly that commit, and escalate a failed verdict with
  //     rollback guidance. The loop never produces the verdict: the workflow's producer does.
  const served = state.deployment;
  let smokeDeferred = 0;
  for (const item of delivered.filter(candidate => deploySmokeRequired(candidate.policy))) await isolate('smoke', item, item.key, async () => {
    // Past the budget nothing more is started: every record and request below is keyed, so the next cycle resumes where this one stopped.
    if (now() >= deadline) { smokeDeferred++; return; }
    const delivery = item.delivery!;
    if (!delivery.deployment) {
      if (served?.source === 'unavailable' || !served?.sha || !served.deployed.includes(item.key)) return;
      const key = `deployment:record:${item.id}:${served.sha}`;
      if (state.actions[key] && state.actions[key].state !== 'failed') return;
      if (!readyToRetry(state.actions[key], state.cycle)) return;
      const attempts = (state.actions[key]?.attempts ?? 0) + 1;
      await record(state, key, { kind: 'deployment', work: item.key, principal: null, state: 'started', detail: `Recording that ${served.sha.slice(0, 12)} from ${served.source} serves ${item.key}`, attempts, cycle: state.cycle }, now(), effects.persist);
      try {
        await effects.recordDeployment(item, { sha: served.sha, source: served.source as 'endpoint' | 'github-deployment', observedAt: served.at });
        performed.push(await record(state, key, { kind: 'deployment', work: item.key, principal: null, state: 'done', detail: `Recorded deployment ${served.sha.slice(0, 12)} (${served.source}) covering ${item.key} merge ${delivery.mergeSha.slice(0, 12)}; the smoke proof may now be requested`, attempts, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        performed.push(await record(state, key, { kind: 'deployment', work: item.key, principal: null, state: 'failed', detail: `Could not record the deployment for ${item.key}: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist));
      }
      return;
    }
    const outcome = deliveryState(item);
    if (outcome === 'delivered-with-failure') {
      const key = `escalation:smoke:${item.id}:${delivery.smoke!.evidenceId}`;
      if (state.actions[key]?.state !== 'done') performed.push(await record(state, key, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail: rollbackGuidance(item, config.baseBranch)!, attempts: 1, cycle: state.cycle }, now(), effects.persist));
      return;
    }
    if (outcome !== 'awaiting-smoke') return;
    const key = `smoke:${item.id}:${delivery.deployment.sha}`;
    const previous = state.actions[key];
    if (previous && (previous.state === 'done' || previous.attempts >= maxProofAttempts || !readyToRetry(previous, state.cycle))) return;
    if (!config.run.smokeWorkflow) {
      if (previous?.state !== 'failed') performed.push(await record(state, key, { kind: 'smoke', work: item.key, principal: null, state: 'failed', detail: `${item.key} is deployed at ${delivery.deployment.sha.slice(0, 12)} and needs its post-deployment smoke proof; configure master init --smoke-workflow so the loop can request it from the trusted producer workflow`, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      return;
    }
    await record(state, key, { kind: 'smoke', work: item.key, principal: null, state: 'started', detail: `Requesting ${config.run.smokeWorkflow} for ${item.key} at ${delivery.deployment.sha.slice(0, 12)}`, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
    try {
      await effects.requestSmoke(item);
      performed.push(await record(state, key, { kind: 'smoke', work: item.key, principal: null, state: 'done', detail: `Requested trusted smoke workflow ${config.run.smokeWorkflow} for ${item.key} against deployed ${delivery.deployment.sha.slice(0, 12)} (merge ${delivery.mergeSha.slice(0, 12)})`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      performed.push(await record(state, key, { kind: 'smoke', work: item.key, principal: null, state: 'failed', detail: `Could not request ${config.run.smokeWorkflow} for ${item.key}: ${message(error)}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    }
  });
  if (smokeDeferred) deferred.push(`${smokeDeferred} deliveries' deployment records and smoke requests`);
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
 * The loop's action keys for the owner item of a release (filed once per release) and for the
 * needs-decision asked on an owner, keyed by the owner's requirements revision when it was raised,
 * so only a revision applied after it answers it (`throughputOwnerAnswered`).
 */
/** How many closed owners of one release a single filing follows to reach (or file) the open one. */
export const throughputOwnerSuccessions = 8;
export const throughputOwnerKey = (revision: string) => `throughput:owner:${revision}`;
/**
 * GY-1609: how often an open owner with no needs-decision raised reads the one standing on the
 * newest recorded measurement: well inside the minutes a decision and its approver take. A filing's
 * own read counts, so a cycle that files an owner never reads the ledger a second time.
 */
export const throughputStandingReadMs = 60_000;
const standingReads = new WeakMap<DaemonState, number>();
export const throughputEscalationKey = (owner: string, policyRevision: number) => `escalation:throughput:${owner}:${policyRevision}`;
/**
 * The owner's requirements revision at which the loop raised its needs-decision (the earliest, should a key repeat), or null when it raised none.
 * GY-1587: the escalation is recorded `waiting` until its owner is closed, so the cursor's bound on
 * resolved actions never drops the revision its answer is judged against; it is settled `done` then.
 */
export function throughputEscalatedAt(actions: Record<string, DaemonAction>, owner: Pick<Work, 'key'>): number | null {
  const prefix = `escalation:throughput:${owner.key}:`;
  const raised = Object.entries(actions).filter(([key, action]) => key.startsWith(prefix) && (action.state === 'waiting' || action.state === 'done') && action.work === owner.key)
    .map(([key]) => Number(key.slice(prefix.length))).filter(Number.isInteger);
  return raised.length ? Math.min(...raised) : null;
}

/**
 * An escalation waits while its owner is open (`throughputEscalatedAt`); once that owner is closed, by
 * the loop on its answer or by anyone, its answer is consumed, and the row is settled `done` (raise time
 * kept) so the cursor's bound may retire it. `open` is the owner still open, whose escalation stands.
 */
function settleThroughputEscalations(state: DaemonState, open: string | null) {
  for (const [key, action] of Object.entries(state.actions)) {
    if (key.startsWith('escalation:throughput:') && action.state === 'waiting' && action.work !== open) storeAction(state, key, { ...action, state: 'done' }, null);
  }
}

/**
 * GY-1438: the item that owns GY-87's verification on the serving release, every cycle the
 * deployment verified. An open owner is closed once the release's answer verified the claim or its
 * needs-decision was answered (`throughputOwnerClosure`), and never otherwise. With none open, an
 * unverified answer files one, once per release: a release whose owner was closed (on an answered
 * decision, or by anyone) is not given a second unless a needs-decision still stands on its newest
 * measurement (GY-1465), which files one even when the latest ask failed, and the next release
 * files afresh. GY-1467: an owner closed on its answer is succeeded in the cycle that closes it, so
 * no cycle between re-measures leaves the standing decision unowned, under a key naming the
 * revision that answered it — one successor per (release, answered revision). The filing body and
 * its key are read from the newest recorded measurement, never from this cycle's own, so a retry
 * after a refusal or a lost reply sends the same body under the same key and is answered from the
 * stored receipt. A measurement showing the population cannot accumulate raises the typed
 * needs-decision on the owner once per owner: it stands until answered, so a re-measure that finds
 * the same — or more of the same — never raises it again. GY-1587: so does a miss the ledger's
 * pursuit escalated over an accumulating population (`throughputEscalatedMiss`), asked once per
 * release: after its answer the successor owns the release until a measurement verifies it. Filing and closing go through the
 * operator-agent; a failure backs off on the action.
 */
async function throughputOwnerStep(cycle: Pick<Cycle, 'state' | 'effects' | 'now' | 'performed'>, revision: string, work: Work[], stall: ThroughputStall | null) {
  const { state, effects, now, performed } = cycle, answer = state.actions[`throughput:${revision}`];
  const verdict = answeredVerdict(answer);
  const ownerKey = throughputOwnerKey(revision);
  const note = (work: string | null, outcome: DaemonAction['state'], detail: string) => record(state, ownerKey, { kind: 'deployment', work, principal: null, state: outcome, detail, attempts: (state.actions[ownerKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
  let owner = openThroughputOwner(work), answered: { key: string; by: number; cause: ReturnType<typeof throughputDecisionCause>; asked: string | null } | null = null;
  settleThroughputEscalations(state, owner?.key ?? null);
  if (owner) {
    // Without a reason it stays open: the claim is not verified and its needs-decision is not answered.
    // GY-1587: the closure names which decision it answered, read from the escalation that asked it.
    // GY-1609: and the release it was asked on, which an owner open across a release change need not be serving now.
    const raisedAt = throughputEscalatedAt(state.actions, owner), escalation = raisedAt === null ? null : state.actions[throughputEscalationKey(owner.key, raisedAt)]?.detail;
    const cause = throughputDecisionCause(escalation), asked = throughputDecisionRelease(escalation);
    const reason = throughputOwnerClosure(owner, { revision, verdict }, raisedAt, cause, asked), ownerAction = state.actions[ownerKey];
    if (reason) {
      if (effects.closeThroughputOwner && (ownerAction?.state !== 'failed' || readyToRetry(ownerAction, state.cycle))) try {
        if (await effects.closeThroughputOwner(owner, reason, `throughput-owner:close:${owner.id}:${owner.revision}`)) {
          settleThroughputEscalations(state, null);
          performed.push(await note(owner.key, 'done', `Closed ${owner.key}: ${reason}`));
          // Closed on its answer, not a verified claim: its successor is judged in this same cycle.
          if (verdict !== 'verified') answered = { key: owner.key, by: owner.policyRevision, cause, asked };
        }
      } catch (error) { performed.push(await note(owner.key, 'failed', `Could not close ${owner.key}: ${message(error)}`)); }
      if (!answered) return;
      owner = null;
    }
  }
  if (!owner && verdict !== 'verified' && effects.fileThroughputOwner) {
    // GY-1465: with no owner open, a needs-decision that still stands on the newest measurement
    // files one within the cycle, whether or not the record of an earlier owner was retained and
    // whatever the latest ask answered — a failed re-measure or a wait on the plane leaves the
    // recorded measurement, and its needs-decision, standing — so the attention is never left with
    // no item to decide on. Without an unverified answer only a standing decision files one.
    // The read the owner step below would take again this cycle: one parse of the ledger answers both (GY-1609).
    standingReads.set(state, now());
    const recorded = await effects.standingThroughputStall?.(revision).catch(() => null) ?? null, ownerAction = state.actions[ownerKey];
    stall ??= recorded;
    if (verdict !== 'unverified' && !stall) return;
    if (ownerAction?.state === 'done' ? !stall : !readyToRetry(ownerAction, state.cycle)) return;
    // The key binds the owner it succeeds (with the requirements revision that answered it, when the
    // loop closed it on its answer), the recorded measurement the decision stands on and the exact
    // input, so a retry after a lost reply returns the item already filed, while a later filing for
    // the same release is neither refused as a reused key (409) nor answered with a closed predecessor.
    // GY-1467: nothing this cycle measured enters the body or the key, so they are the same whether or not it measured.
    const input = throughputOwnerItem(revision, recorded?.admitted ?? null), digest = createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16);
    const answeredBy = (key: string, closed?: Pick<Work, 'closure'>) => key === answered?.key ? answered.by : throughputOwnerAnsweredBy(closed ?? work.find(item => item.key === key));
    const file = (predecessor: string | null, closed?: Pick<Work, 'closure'>) => {
      const by = predecessor ? answeredBy(predecessor, closed) : null;
      return effects.fileThroughputOwner!(input, `throughput-owner:${revision}:${predecessor ? `${predecessor}:` : ''}${by !== null ? `${by}:` : ''}${recorded ? `${recorded.measuredAt}:` : ''}${digest}`);
    };
    let predecessor = ownerAction?.work ?? null;
    try {
      let filed = await file(predecessor);
      // A key whose record was pruned is answered with the owner it filed before, since closed: that
      // one is the predecessor, never the new owner, and is succeeded only while a decision stands.
      // Each succession key answers the owner filed after it, so the chain is followed to its open end.
      for (let hop = 0; filed && !openThroughputOwner([filed]); hop++) {
        const closed: Work = filed;
        predecessor = closed.key;
        filed = stall && hop < throughputOwnerSuccessions ? await file(predecessor, closed) : null;
        if (!filed) { performed.push(await note(predecessor, 'done', `${predecessor} already owned GY-87's throughput verification on ${revision.slice(0, 12)} and is closed${stall ? '; the needs-decision standing on it files its successor next cycle' : ''}`)); return; }
      }
      if (filed) { owner = filed; performed.push(await note(filed.key, 'done', `Filed ${filed.key} to own GY-87's throughput verification on ${revision.slice(0, 12)}${predecessor ? `, succeeding ${predecessor}` : ''}${stall ? ' and the needs-decision standing on it' : ''}; it closes once the claim verifies or its needs-decision is answered`)); }
    } catch (error) { performed.push(await note(predecessor, 'failed', `Could not file the item that owns GY-87's throughput verification on ${revision.slice(0, 12)}${predecessor ? `, succeeding ${predecessor}` : ''}: ${message(error)}`)); }
  }
  if (!owner || throughputEscalatedAt(state.actions, owner) !== null) return;
  // GY-1609: master status asks the decision from the newest recorded measurement, whenever it reads,
  // so an open owner with none raised reads it too rather than waiting for a cycle that measures:
  // raised after its answer was applied, at the answering revision, it could never be seen answered.
  // The read parses the whole ledger, so it is taken at most once per throughputStandingReadMs.
  if (!stall && effects.standingThroughputStall && now() - (standingReads.get(state) ?? -Infinity) >= throughputStandingReadMs) {
    standingReads.set(state, now());
    stall = await effects.standingThroughputStall(revision).catch(() => null);
  }
  if (!stall) return;
  // GY-1587: an escalated miss over an accumulating population is asked once per release. Once an
  // owner of this release closed on the answer to that escalated miss, its successor carries the
  // verification without a second ask; the next release asks afresh. An answered stall is a
  // different decision and never suppresses it.
  // GY-1609: an answer counts for the release it was asked on, so an owner asked on A and answered once
  // B serves leaves B's miss to be asked on its successor.
  const answeredHere = answered?.cause === 'escalated-miss' && (answered.asked ?? revision.slice(0, 12)) === revision.slice(0, 12);
  if (stall.cause === 'escalated-miss' && (answeredHere || throughputAnsweredAt(work, revision) !== null)) return;
  // GY-1609: the owner's requirements revision is read again before the escalation is keyed by it.
  // The work list is the cycle's opening snapshot, and a revision approved since — before this
  // escalation was raised, so answering nothing — would otherwise read as applied after it and close
  // the owner on the next cycle. Unreadable, nothing is raised: the next standing read raises it.
  if (effects.readThroughputOwner) {
    const fresh = await effects.readThroughputOwner(owner).catch(() => null);
    if (!fresh || !openThroughputOwner([fresh]) || throughputEscalatedAt(state.actions, fresh) !== null) return;
    owner = fresh;
  }
  // GY-1630: the record names who asks the decision: the loop's own decision step where it has the decide and approver
  // effects (`throughputRoutineDecision`), the hand path only for a loop without them.
  const asks = effects.decide && effects.approver ? throughputSelfAsked(owner.key) : throughputHandAsked(owner.key);
  performed.push(await record(state, throughputEscalationKey(owner.key, owner.policyRevision), { kind: 'escalation', work: owner.key, principal: null, state: 'waiting', detail: `${throughputStallText({ ...stall, owner: owner.key })}. ${asks}`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
}

/** The binding of the requirements decision the loop requests on a throughput owner's standing needs-decision: one per raise. */
export const throughputDecisionBound = (binding: unknown) => typeof binding === 'string' && binding.startsWith('throughput:');

/**
 * GY-1630: the requirements decision the loop requests itself on the open throughput owner while the
 * needs-decision it raised there stands unanswered (`escalation:throughput:GY-N:REVISION` waiting, the
 * owner still at that revision), or null. It asks the option of record, which changes no requirement:
 * the coordination unchanged and GY-87's claim recorded unverified on the release it was asked on, the
 * budgets unchanged and never relaxed. `expectedPolicyRevision` is the revision at the raise, so the
 * revision answers exactly that needs-decision (`throughputOwnerAnswered`) and the unchanged closure
 * path closes the owner once it is applied. The binding names the raise and the measurement it stands
 * on, so a lost reply adopts the request already standing rather than asking a second.
 */
export function throughputRoutineDecision(work: Work, actions: Record<string, DaemonAction>): RoutineDecision | null {
  if (!openThroughputOwner([work])) return null;
  const raisedAt = throughputEscalatedAt(actions, work), escalation = raisedAt === null ? null : actions[throughputEscalationKey(work.key, raisedAt)];
  if (raisedAt === null || escalation?.state !== 'waiting' || work.policyRevision !== raisedAt) return null;
  const measuredAt = /\(measured ([^)]+)\)/.exec(escalation.detail)?.[1] ?? 'unrecorded', release = throughputDecisionRelease(escalation.detail);
  const on = release ? `the release ${release} it was asked on` : 'the release it was asked on';
  const text = `${throughputClaim.item}'s throughput claim stands recorded unverified on ${on}, and the needs-decision the loop raised on ${work.key} at its requirements revision ${raisedAt} (measured ${measuredAt}) is answered by this revision: `
    + `the coordination is left unchanged, and ${throughputClaim.item}'s budgets stay exactly as stated (${throughputClaim.statement} Judged over at least ${throughputClaim.minimumDeliveries} session-free deliveries), recorded unverified and never relaxed; a later release verifies the claim through a fresh measurement or the successor the loop files.`;
  const reason = `The loop raised the throughput needs-decision on ${work.key} at its requirements revision ${raisedAt} and requests it itself (GY-1630): ${escalation.detail.slice(0, 1000)}. `
    + `It asks the option of record, which changes no requirement: the coordination unchanged and the claim recorded unverified on this release, the budgets unchanged and never relaxed. expectedPolicyRevision ${raisedAt} binds the revision to that raise, so it answers exactly this needs-decision and the loop closes ${work.key} once it is applied.`;
  return { action: 'requirements', binding: `throughput:${raisedAt}:${measuredAt}`, reason: reason.slice(0, 2000),
    input: { criteria: [{ id: 'AC-1', text: text.slice(0, 2000), proofs: ['manual:throughput-claim-verified'] }], plannedFiles: work.plannedFiles ?? [], expectedPolicyRevision: raisedAt } };
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
