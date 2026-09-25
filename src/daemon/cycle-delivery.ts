// Concern: cycle steps 5–7 — shepherd reviews and proofs, the guarded merge, deployment verification.
import { reviewProviderOf, reviewerProfileFor, exhaustedReviewerProfiles, deploySmokeRequired, deliveryState, rollbackGuidance } from '../model.js';
import { mergedWithoutAuthorization, unauthorizedMergeViolation, approvedMerge } from '../master.js';
import { boundDeployment, deploymentObservationSchema, maxProofAttempts, message } from './state.js';
import { candidateKey, decisionKey } from './reconcile.js';
import { missingProofs } from './metrics.js';
import { readyToRetry } from './sessions.js';
import { detailChanged, maxApproverLaunches, standingVerdict } from './decisions.js';
import { record } from './effects.js';
import type { Cycle } from './cycle.js';
import { deploymentDetail } from './deployment.js';

/** Step 5: shepherd reviews and proofs for submitted candidates. */
export async function shepherdStep(cycle: Cycle) {
  const { config, state, effects, now, clock, performed, isolate, open } = cycle;
  // 5. Shepherd reviews and proofs for submitted candidates. Graphyard dispatches provider reviews
  //    and trusted producers publish evidence; the daemon records exactly one request per candidate
  //    and escalates what only a human or a producer may resolve.
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
    const outstanding = missingProofs(item, new Date(clock));
    if (!outstanding.length) return;
    const manual = outstanding.filter(proof => proof.startsWith('manual:'));
    const automatable = outstanding.filter(proof => !proof.startsWith('manual:'));
    if (manual.length) {
      const key = `escalation:proof:${item.id}:${item.candidate!.sha}:${item.policyRevision}`;
      if (state.actions[key]?.state !== 'done') performed.push(await record(state, key, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail: `${item.key} needs operator-witnessed proof for ${manual.join(', ')}; the coordinator holds no producer credential and cannot submit it`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
    }
    if (!automatable.length) return;
    const key = candidateKey('proof', item);
    const previous = state.actions[key];
    if (previous && (previous.state === 'done' || previous.attempts >= maxProofAttempts || !readyToRetry(previous, state.cycle))) return;
    if (!config.run.proofWorkflow) {
      if (previous?.state !== 'failed') performed.push(await record(state, key, { kind: 'proof', work: item.key, principal: null, state: 'failed', detail: `${item.key} needs trusted evidence for ${automatable.join(', ')}; configure master run --proof-workflow so the loop can request it from the trusted producer workflow`, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      return;
    }
    await record(state, key, { kind: 'proof', work: item.key, principal: null, state: 'started', detail: `Requesting ${config.run.proofWorkflow} for ${item.key}`, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
    try {
      await effects.requestProof(item);
      performed.push(await record(state, key, { kind: 'proof', work: item.key, principal: null, state: 'done', detail: `Requested trusted producer workflow ${config.run.proofWorkflow} for ${item.key} PR #${item.submission!.pr} at ${item.candidate!.sha.slice(0, 12)} (${automatable.join(', ')})`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      performed.push(await record(state, key, { kind: 'proof', work: item.key, principal: null, state: 'failed', detail: `Could not request ${config.run.proofWorkflow} for ${item.key}: ${message(error)}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    }
  });
}

/** Step 6: merge through the guarded command only. */
export async function mergeStep(cycle: Cycle) {
  const { config, state, effects, now, performed, isolate, open } = cycle;
  // 6. Merge. The only path is the guarded command, which rechecks the exact candidate, every gate,
  //    branch protection and the published queue tip immediately before the provider call.
  //    An item GitHub already merged with no valid execution behind it is not a candidate: the
  //    merge cannot be re-run, so the loop names the violation and the two-party decision that
  //    reconciles it once, instead of asking the guarded merge every cycle.
  for (const item of open.filter(mergedWithoutAuthorization)) await isolate('escalation', item, item.key, async () => {
    const key = `${candidateKey('escalation', item)}:merged`;
    if (state.actions[key]?.state === 'done') return;
    performed.push(await record(state, key, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail: `${item.key} was merged on GitHub (${item.observation!.mergeSha?.slice(0, 12) ?? 'merge commit unknown'} at ${item.observation!.mergedAt ?? 'an unrecorded time'}) without a valid merge execution: ${unauthorizedMergeViolation}. It stays at the merge stage until a two-party decision reconciles it: graphyard master decide ${item.key} merge REASON, then graphyard master approver ${item.key} DECISION; Graphyard re-checks the record at the merge cutoff and delivers on the approved decision`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
  });
  const mergeCandidates = open.filter(candidate => candidate.stage === 'merge' && !mergedWithoutAuthorization(candidate));
  for (const item of mergeCandidates) await isolate('merge', item, item.key, async () => {
    const key = candidateKey('merge', item);
    const previous = state.actions[key];
    if (!readyToRetry(previous, state.cycle)) return;
    // With automatic merging off the guarded merge runs for exactly the candidate an approver
    // agent approved (step 4c requested it). Until that approval is applied, the loop waits on the
    // approver rather than on a person, and says which decision it is waiting for.
    if (!config.autoMerge) {
      const approval = effects.decisions ? approvedMerge(item, (await effects.decisions(item).catch(() => ({ decisions: [] }))).decisions as Parameters<typeof approvedMerge>[1]) : null;
      if (!approval) {
        const waitKey = candidateKey('escalation', item);
        const watch = state.approvals[decisionKey(item, { action: 'merge', binding: item.candidate!.sha })];
        // A loop that can request the decision says so and waits for the approver agent; one
        // without the master's operator-agent identity is genuinely waiting on the master session,
        // and names the two commands that put the same decision to the same approver. The wait
        // names the decision and the session it is with, so it is raised again whenever that
        // changes — a replaced session, or a decision no session judged — not once and never again.
        const detail = watch?.exhaustedAt ? `Automatic merging is disabled and merge decision ${watch.decision} for ${item.key} is still unjudged after ${watch.launches} approver session(s); put it to a fresh one with graphyard master approver ${item.key} ${watch.decision}`
          : watch ? `Automatic merging is disabled; ${item.key} merges as soon as approver session ${watch.agentName ?? '(not launched yet)'} (launch ${watch.launches} of ${maxApproverLaunches}) applies merge decision ${watch.decision}, which this loop requested`
          : effects.decide ? `Automatic merging is disabled; ${item.key} merges once an approver agent applies a merge decision for candidate ${item.candidate!.sha.slice(0, 12)}`
            : `Automatic merging is disabled; ${item.key} awaits explicit operator approval before the guarded merge runs: graphyard master decide ${item.key} merge REASON, then graphyard master approver ${item.key} DECISION`;
        if (detailChanged(state.actions[waitKey], detail)) performed.push(await record(state, waitKey, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail, attempts: (state.actions[waitKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
        return;
      }
    }
    await record(state, key, { kind: 'merge', work: item.key, principal: null, state: 'started', detail: `Invoking the guarded merge for ${item.key}`, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
    try {
      const result = await effects.merge(item);
      performed.push(await record(state, key, { kind: 'merge', work: item.key, principal: null, state: 'done', detail: `Guarded merge accepted for ${item.key}: ${(result as { result?: string })?.result ?? 'merge requested'}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      // A refusal is the gate working, not a daemon fault: record it and keep cycling.
      performed.push(await record(state, key, { kind: 'merge', work: item.key, principal: null, state: 'failed', detail: `Guarded merge refused for ${item.key}: ${message(error)}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    }
  });
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
