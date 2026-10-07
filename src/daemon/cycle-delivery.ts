// Concern: cycle steps 5–7 — shepherd reviews, reconcile what GitHub merged, deployment verification.
import { reviewProviderOf, reviewerProfileFor, exhaustedReviewerProfiles, deploySmokeRequired, deliveryState, rollbackGuidance } from '../model.js';
import { type Work } from '../model.js';
import { mergedWithoutAuthorization, unauthorizedMergeViolation } from '../merge-queue.js';
import { boundDeployment, type DaemonAction, deploymentObservationSchema, maxProofAttempts, message, retainedActions } from './state.js';
import { candidateKey } from './reconcile.js';
import { readyToRetry } from './sessions.js';
import { detailChanged, exhaustedProofEscalation, exhaustedProofKey, githubPause, observationWakeDue, standingVerdict } from './decisions.js';
import { record } from './effects.js';
import type { Cycle } from './cycle.js';
import { defaultDeploymentReuseMinutes, defaultPromoteEveryMinutes, deploymentDetail, deploymentStepBudgetMs, promotionCycle, promotionWorkflow, reusableDeployment, stillVerifying, withinDeploymentBudget } from './deployment.js';
import { mainGuardAttention } from '../main-guard.js';
import { throughputRemeasureMs } from '../throughput.js';

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
  //       four scheduled runs in a row (GY-1302): when the base branch has moved past the last
  //       promoted SHA, no candidate is in validation and run.promoteEveryMinutes have passed since
  //       the last dispatch, the release-candidate workflow is dispatched with promote=true.
  //       A failed read or dispatch is recorded under one key and retried with backoff, and the
  //       cycle's read and dispatch stamps are kept, so a failure never repeats every cycle.
  const promotion = effects.promotion, promotionFailure = 'promotion:failed';
  if (promotion && readyToRetry(state.actions[promotionFailure], state.cycle)) {
    const checked = await withinDeploymentBudget(state, 'promotion', () => promotionCycle(state.promotion ?? null, promotion, { now: now(), everyMinutes: config.run.promoteEveryMinutes ?? defaultPromoteEveryMinutes, intervalMs: config.run.intervalSeconds * 1000 }), deadline, now);
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
  //        the loop records a measurement for the release the control plane serves, once per
  //        release while it verifies, with its own coordinator credential, reading only the window's deliveries
  //        whole; master status reads it back as verified or with its shortfall. One action per
  //        observed release: a plane that does not serve it yet answers `waiting`, asked again on
  //        the failure backoff (one status read per ask, never one per cycle) until it serves or a
  //        newer observation supersedes the key; a failure backs off the same way. It follows a
  //        verification: a cycle whose observation is still in flight (cut by the budget) starts
  //        no measurement, so the step never holds two reads in flight. GY-1438: a measurement that
  //        left the claim unverified is asked again once a delivery merged after it and
  //        throughputRemeasureMs have passed (`throughputRemeasureAsk`), so the serving release's
  //        record refreshes as deliveries accumulate; one whose population cannot accumulate raises
  //        the typed needs-decision once per changed finding.
  const verified = observed !== stillVerifying && observed.ok ? state.deployment : null, measure = effects.measureThroughput;
  if (measure && verified && verified.source !== 'unavailable' && verified.sha) {
    const key = `throughput:${verified.sha}`, previous = state.actions[key];
    if (throughputAskDue(previous, state.cycle) || throughputRemeasureAsk(previous, delivered, now())) {
      const measured = await withinDeploymentBudget(state, 'throughput', () => measure(snapshot.work, verified.sha!), deadline, now);
      if (measured === stillVerifying) deferred.push('the throughput measurement');
      else {
        const outcome = measured.ok ? measured.value : null;
        const detail = outcome ? outcome.detail : `GY-87's throughput measurement could not be recorded for ${verified.sha.slice(0, 12)}: ${message((measured as { error: unknown }).error)}`;
        const entryState = !outcome ? 'failed' : outcome.outcome === 'waiting' ? 'waiting' : 'done';
        // Every ask is recorded, so the backoff counts them; a wait whose reason stands is not reported again.
        const entry = await record(state, key, { kind: 'deployment', work: null, principal: null, state: entryState, detail, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
        if (entryState !== 'waiting' || detailChanged(previous, detail)) performed.push(entry);
        const stall = outcome?.stall;
        if (stall) {
          const escalationKey = `escalation:throughput:${stall.revision ?? verified.sha}`;
          if (detailChanged(state.actions[escalationKey], stall.text)) performed.push(await record(state, escalationKey, { kind: 'escalation', work: stall.owner, principal: null, state: 'done', detail: stall.text, attempts: (state.actions[escalationKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
        }
      }
    }
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
 * is asked now, a measured one (`done`) never again, and a wait on the plane or a failure on the
 * failure backoff (`readyToRetry`, doubling per ask up to its cap), so a plane that lags the
 * deployment record costs one status read per ask rather than per cycle.
 */
export function throughputAskDue(previous: DaemonAction | undefined, cycle: number) {
  return readyToRetry(previous?.state === 'waiting' ? { ...previous, state: 'failed' } : previous, cycle);
}

/**
 * GY-1438: whether a release measured unverified is asked again. Its recorded answer (`done`)
 * names the verdict; one that says unverified is re-asked once a delivery merged after the
 * answer and `throughputRemeasureMs` have passed since it, so the re-measure costs one bounded
 * read per spacing rather than one per merge or per cycle. A verified answer is final.
 */
export function throughputRemeasureAsk(previous: DaemonAction | undefined, delivered: Work[], now: number) {
  if (previous?.state !== 'done' || !/\bunverified\b/.test(previous.detail)) return false;
  const answered = Date.parse(previous.at), newest = Date.parse(delivered.at(-1)?.delivery?.mergedAt ?? '');
  return Number.isFinite(answered) && now - answered >= throughputRemeasureMs && Number.isFinite(newest) && newest > answered;
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
