// Concern: cycle steps 5–7 — shepherd reviews, reconcile what GitHub merged, deployment verification.
import { reviewProviderOf, reviewerProfileFor, exhaustedReviewerProfiles, deploySmokeRequired, deliveryState, rollbackGuidance } from '../model.js';
import { type Work } from '../model.js';
import { mergedWithoutAuthorization, unauthorizedMergeViolation } from '../merge-queue.js';
import { boundDeployment, deploymentObservationSchema, maxProofAttempts, message, retainedActions } from './state.js';
import { candidateKey } from './reconcile.js';
import { readyToRetry } from './sessions.js';
import { detailChanged, exhaustedProofEscalation, exhaustedProofKey, githubPause, observationWakeDue, standingVerdict } from './decisions.js';
import { record } from './effects.js';
import type { Cycle } from './cycle.js';
import { defaultPromoteEveryMinutes, deploymentDetail, promotionCycle, promotionWorkflow } from './deployment.js';
import { mainGuardAttention } from '../main-guard.js';

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
  //    them may have had its row retired, so it is not raised again (`mainGuardAttention`'s `since`).
  const abandoned = (cycle.snapshot?.work ?? []).filter(item => item.mainGuardReverts?.some(revert => revert.state === 'abandoned'));
  if (abandoned.length) {
    const resolved = Object.entries(state.actions).filter(([key, action]) => (action.state === 'done' || action.state === 'failed') && !state.faults.failing[key]);
    const since = resolved.length >= retainedActions ? Math.min(...resolved.map(([, action]) => Date.parse(action.at))) : -Infinity;
    for (const line of mainGuardAttention(abandoned, since)) {
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
  try {
    const observation = await effects.observeDeployment(delivered, state.deployment?.containment ?? null);
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
  //       four scheduled runs in a row (GY-1302): when the base branch has moved past the last
  //       promoted SHA, no candidate is in validation and run.promoteEveryMinutes have passed since
  //       the last dispatch, the release-candidate workflow is dispatched with promote=true.
  //       A failed read or dispatch is recorded under one key and retried with backoff, and the
  //       cycle's read and dispatch stamps are kept, so a failure never repeats every cycle.
  const promotion = effects.promotion, promotionFailure = 'promotion:failed';
  if (promotion && readyToRetry(state.actions[promotionFailure], state.cycle)) {
    const result = await promotionCycle(state.promotion ?? null, promotion, { now: now(), everyMinutes: config.run.promoteEveryMinutes ?? defaultPromoteEveryMinutes });
    state.promotion = result.state;
    if (result.failure) {
      const detail = `Promotion could not be checked or dispatched: ${result.failure}`;
      performed.push(await record(state, promotionFailure, { kind: 'deployment', work: null, principal: null, state: 'failed', detail, attempts: (state.actions[promotionFailure]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
    } else if (state.actions[promotionFailure]) delete state.actions[promotionFailure];
    if (result.dispatched) performed.push(await record(state, `promotion:${result.state.mainSha}`, { kind: 'deployment', work: null, principal: null, state: 'done', detail: result.state.reason ?? `Dispatched ${promotionWorkflow}`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
  }

  // 7b. The second confidence layer. For each delivery whose policy asks for a smoke proof: record
  //     the observation on Graphyard once the release serves its merge, ask the provider to run the
  //     trusted smoke workflow against exactly that commit, and escalate a failed verdict with
  //     rollback guidance. The loop never produces the verdict: the workflow's producer does.
  const observed = state.deployment;
  for (const item of delivered.filter(candidate => deploySmokeRequired(candidate.policy))) await isolate('smoke', item, item.key, async () => {
    const delivery = item.delivery!;
    if (!delivery.deployment) {
      if (observed?.source === 'unavailable' || !observed?.sha || !observed.deployed.includes(item.key)) return;
      const key = `deployment:record:${item.id}:${observed.sha}`;
      if (state.actions[key] && state.actions[key].state !== 'failed') return;
      if (!readyToRetry(state.actions[key], state.cycle)) return;
      const attempts = (state.actions[key]?.attempts ?? 0) + 1;
      await record(state, key, { kind: 'deployment', work: item.key, principal: null, state: 'started', detail: `Recording that ${observed.sha.slice(0, 12)} from ${observed.source} serves ${item.key}`, attempts, cycle: state.cycle }, now(), effects.persist);
      try {
        await effects.recordDeployment(item, { sha: observed.sha, source: observed.source as 'endpoint' | 'github-deployment', observedAt: observed.at });
        performed.push(await record(state, key, { kind: 'deployment', work: item.key, principal: null, state: 'done', detail: `Recorded deployment ${observed.sha.slice(0, 12)} (${observed.source}) covering ${item.key} merge ${delivery.mergeSha.slice(0, 12)}; the smoke proof may now be requested`, attempts, cycle: state.cycle }, now(), effects.persist));
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
}
