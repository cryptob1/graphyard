// Concern: cycle step 4c — request and supervise the routine decisions and their approver sessions.
import { observationWaker } from '../master/base-break-refresh.js';
import { decisionSituation, uncitedRefusals } from '../model/approval.js';
import type { Work } from '../model.js';
import { canonicalJson } from '../onboarding.js';
import { type ContainmentAssessment, type RoleCapacity, approvedMerge, decisionInput } from '../master.js';
import { recordSettledDecision } from '../model/project-memory.js';
import { type ApprovalWatch, approvalWatchSchema, carriedSession, type DaemonActionKind, type DaemonState, latencySampleSchema, message, scopeMeasurementSchema } from './state.js';
import { decisionKey, scopeAnsweredAt, scopeKey, scopeOutcomeAnswered } from './reconcile.js';
import { readyToRetry } from './sessions.js';
import { approvalStep, recordWatchEnded, approverLaunchKey, attestDecisions, boundDetail, cappedReworkBound, exhaustedProofKey, decisionReasonMax, detailChanged, fitDecisionReason, githubPause, handWatchPrefix, maxApproverCloses, maxRefusalAnswers, maxDecisionRequests, namePaths, neededDecision, observedFrom, overtakenDecision, resolveCovers, reworkDecisionReason, refusalNamedIn, standingNamedIn, adoptedOnRefusal, conflictReworkOverdue, reworkObservationWait, routineDecision, type RoutineDecision, sameAnswers, scopeRoutineDecision, blockerScopeDecision, standingVerdict, uncountedScopeFailure, withheldDecision } from './decisions.js';
import {
  bindHeldSupervisedAsk, clearCoveringAdoptIfGone, coveringAdoptLeftAskOpen, coveringScopeAdoptWatch, heldAdoptWatch,
  heldDecisionRefusal, heldDecisionNamedIn, heldWaitDetail, heldWaitMarker, heldWaitScope, approvedResumePendingDetail,
  markHeldScopeAsk, clearHeldScopeAsk, syncHeldScopeAskMarks, staleRevisionDecideRefusal, staleRevisionDecideNote, staleRevisionDecideDetail,
} from './metrics.js';
import { candidateMovedMeanwhile, decisionFailureKind, decisionReads, deliveredMeanwhile, lateDecisionRead, resumedApplication, selfHealingDecisionFailure } from './decision-reads.js';
import { refusedAttestationWatch, type RefusedAttestation } from '../model/rework-ground.js';
import { record } from './effects.js'; import { reportMechanicalPlans } from './mechanical-plan-report.js';
import { adoptedWatch, refusedOnOtherGrounds } from './rework-grounds.js';
import type { FaultKind } from '../model/fault-classes.js';
import type { Cycle } from './cycle.js';
import { baseRefreshConflict } from '../merge-queue.js'; import { docsSyncRoute } from './docs-sync-route.js';
import { throughputDecisionAdopts, throughputRoutineDecision, wakeObservationJob } from './cycle-delivery.js';
import { createApproverSupervisor } from './cycle-approvers.js';
import { decisionBudget, deferredFirst, settleDeferred } from './decision-budget.js';
import { staleReleaseStep } from './stale-releases.js';
import { closeStanding, closingItems, recordingWrites, staleCloseStep } from './stale-closes.js';
/** The approval-watch key prefix of a hand-launched approver, re-exported for the blocker step (GY-403). */
export { handWatchPrefix };
const holdBounds = new WeakMap<DaemonState, Map<string, number>>(); // GY-1622: per loop cursor, each held item's docs-sync hold bound on the local clock; an item the step did not reach this cycle (put off by its budget) keeps the one it last left; one already passed locally while its hold stood is a zero wait, so the next cycle re-reads it; one exactly a wait away still binds, so the guard's time comes off it. `bound` is the earliest bound when it ends this wait, `next` the earliest whether or not it does: one just beyond the wait still caps the sleep left after the checkout guard
export const holdBoundWait = (state: DaemonState, wait: number, at: number) => { const bounds = holdBounds.get(state); const next = bounds?.size ? Math.min(...bounds.values()) : null; return next !== null && next - at <= wait ? { wait: Math.max(0, next - at), bound: next, next } : { wait, bound: null, next }; };
/** Step 4c: request and supervise the routine decisions. */
export async function decisionStep(cycle: Cycle, settled: Map<string, Work>, assessments: Record<string, ContainmentAssessment>, { capacities, approversSpent }: { capacities: RoleCapacity[]; approversSpent: boolean }) {
  const { config, state, now, snapshot, clock, clockOffset, performed, isolate, agents, open } = cycle;
  // The items this step writes, which the stale-close step leaves to the next cycle's read (GY-1439).
  const written = new Set<string>();
  const effects = recordingWrites(await decisionReads(cycle.effects, cycle.heldDecisions, snapshot.work, Object.values(state.approvals), clock, cycle.effects.decisionReadDeadlineMs), written);
  // 4c. Routine decisions: request with the master's operator-agent identity, launch an independent approver, supervise every cycle (see `approvalStep`).
  const stamp = new Date(clock).toISOString(), bounds = holdBounds.get(state) ?? new Map<string, number>(); holdBounds.set(state, bounds); for (const id of bounds.keys()) if (!snapshot.work.some(work => work.id === id)) bounds.delete(id);
  const note = async (key: string, item: Work, kind: DaemonActionKind, outcome: 'done' | 'failed', detail: string, at = now(), faultKind?: FaultKind | null) =>
    performed.push(await record(state, key, { kind, work: item.key, principal: null, state: outcome, detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, epoch: item.epoch, cycle: state.cycle }, at, effects.persist, faultKind));
  const approvers = createApproverSupervisor(cycle, effects, stamp, note, capacities, approversSpent);
  const { sessions, invalidate, closeApprover, endApproverSession, endWatchSession, launch, capacityRelaunchWaits, approverExhausted, bindHandLaunch, rebindReplacedPane, stallInputs, escalateUnjudged, actOnStep } = approvers;
  /** Request the decision (or adopt the one already standing) and put it to an approver. */
  const request = async (item: Work, decision: RoutineDecision, key: string, carried: ApprovalWatch | null) => {
    const verdict = decision.action === 'rework' && !carried ? standingVerdict(item) : null;
    const previous = state.actions[key], attempts = (previous?.attempts ?? 0) + 1;
    await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'started', detail: `Requesting the ${decision.action} decision for ${item.key}`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist);
    try {
      // An unreadable history is unknown, not empty (GY-1241): the request fails until a read answers,
      // except rework/recover, whose refusal the server names and the loop cites (GY-229).
      const unread = decision.action === 'rework' || decision.action === 'recover';
      const history = effects.decisions ? (await effects.decisions(item).catch(error => { if (unread) return { decisions: [] }; throw error; })).decisions : [];
      const applied = decision.action === 'merge' ? approvedMerge(item, history) : null;
      if (applied) {
        state.approvals[key] = approvalWatchSchema.parse({ work: item.key, action: decision.action, decision: applied.id, requestedAt: stamp, settledAt: stamp });
        performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: `${item.key} already holds an applied merge decision for candidate ${decision.binding.slice(0, 12)}; nothing to request`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
        return;
      }
      // A request whose response was lost is already standing on the item, and the server refuses a second one; adopting it is what keeps a retry from leaving a decision nobody will judge.
      let standing = history.find(entry => entry.action === decision.action && (entry.state === 'requested' || entry.state === 'approved' || entry.state === 'held'));
      // GY-1687/GY-1701/GY-1702: held waits stay live; covering asks bind; still-approved resume races retry with no fault.
      const adoptHeld = async (held: Parameters<typeof heldAdoptWatch>[1], why: string) => {
        const { watch: adopted, bound, unmatched, clearPrevious } = heldAdoptWatch(item, held, decision, carried, stamp);
        if (clearPrevious) clearHeldScopeAsk(state.scope, item.key, clearPrevious.epoch, clearPrevious.at);
        state.approvals[key] = adopted;
        if (bound) markHeldScopeAsk(state.scope, item.key, bound.epoch, bound.at);
        performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: heldWaitDetail(item.key, decision.action, held, why, unmatched), attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
      };
      if (standing?.state === 'held') { await adoptHeld(standing, standing.outcome ?? 'the item holds a live attempt'); return; }
      if (standing?.state === 'approved' && effects.resume) {
        let resumed: Awaited<ReturnType<NonNullable<typeof effects.resume>>>;
        try { resumed = await effects.resume(item, standing.id); }
        catch (error) {
          if (heldDecisionRefusal(error)) { await adoptHeld({ id: standing.id, approvedAt: standing.approvedAt, approvedBy: standing.approvedBy, outcome: message(error), input: standing.input }, 'the item holds a live attempt'); return; }
          throw error;
        }
        if (resumed.state === 'held') { await adoptHeld({ id: resumed.id, approvedAt: resumed.approvedAt, approvedBy: resumed.approvedBy, outcome: resumed.outcome, input: (resumed as { input?: { plannedFiles?: unknown } | null }).input ?? standing.input }, resumed.outcome ?? 'the item holds a live attempt'); return; }
        if (resumed.state === 'approved') {
          const cover = decision.scope ? coveringScopeAdoptWatch(item, standing, decision, carried?.requestedAt ?? stamp) : null;
          const { scope } = heldWaitScope({ id: standing.id, input: standing.input }, decision, decision.scope ?? carried?.scope ?? null);
          const kept = carried ? { ...carriedSession(carried), closeAttempts: carried.closeAttempts } : {};
          state.approvals[key] = approvalWatchSchema.parse({ ...(cover ?? { work: item.key, action: decision.action, decision: standing.id, requestedAt: carried?.requestedAt ?? stamp, settledAt: null, approvedAt: standing.approvedAt ?? null, approvedBy: standing.approvedBy ?? null, scope }), ...kept, settledAt: null });
          if (scope) markHeldScopeAsk(state.scope, item.key, scope.epoch, scope.at);
          performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: approvedResumePendingDetail(item.key, decision.action, standing.id, standing.approvedBy), attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
          return;
        }
        if (resumed.state === 'applied') {
          const same = carried?.decision === standing.id ? carried : null;
          const watch = state.approvals[key] = approvalWatchSchema.parse({ ...same, work: item.key, action: decision.action, decision: standing.id, requestedAt: same?.requestedAt ?? stamp, settledAt: stamp, scope: same?.scope ?? decision.scope ?? null });
          recordSettledDecision(state.projectMemory, watch, { ...resumed, state: 'applied', approvedBy: resumed.approvedBy ?? null }, stamp);
          performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: `Applied ${decision.action} decision ${standing.id} on ${item.key}: approved by ${standing.approvedBy ?? 'its approver'} at ${standing.approvedAt ?? 'an unrecorded time'}, its application had recorded no outcome, and the control plane applied it on the loop's resume${resumed.outcome ? ` (${boundDetail(resumed.outcome, 300)})` : ''}`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
          if (watch.scope) await noteScopeOutcome(item, watch, { ...resumed, state: 'applied', approvedBy: resumed.approvedBy ?? null });
          return;
        }
        standing = undefined;
      }
      // Earlier-head merge/attest: withdraw. Withdrawal that applied settles it (GY-1298).
      const overtaken = standing ? overtakenDecision(item, decision, standing, !!effects.withdraw, clock) : null;
      if (overtaken) {
        const applied = await effects.withdraw!(item, standing!.id, overtaken).then(() => null, (error: unknown) => { if (resumedApplication.test(message(error))) return message(error); throw error; });
        if (applied) {
          const watch = state.approvals[key] = approvalWatchSchema.parse({ work: item.key, action: decision.action, decision: standing!.id, requestedAt: stamp, settledAt: stamp });
          recordSettledDecision(state.projectMemory, watch, { ...standing!, state: 'applied' }, stamp);
          performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: `${overtaken}; the control plane applied it: ${boundDetail(applied, 400)}`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
          return;
        }
        standing = undefined;
      }
      // One resolve at a time: a standing one for another escalation is left to its requester.
      if (standing && decision.action === 'resolve' && decision.escalation && !resolveCovers(standing, decision.escalation)) {
        throw new Error(`resolve decision ${standing.id} is ${standing.state} for ${String(standing.input?.trigger)}, not the ${decision.escalation.trigger} raised at ${decision.escalation.at}; the control plane holds one resolve at a time, so this one is requested once it settles: graphyard master decisions ${item.key}`);
      }
      // Already-refused same widening (answers): do not re-request.
      const judged = decision.action === 'requirements' ? history.find(entry => entry.action === 'requirements' && entry.state === 'refused'
        && JSON.stringify(entry.input?.plannedFiles) === JSON.stringify(decision.input?.plannedFiles) && entry.input?.expectedPolicyRevision === item.policyRevision
        && sameAnswers(entry.input?.answers, decision.input?.answers)) : undefined;
      if (judged) {
        // A refusal recorded after this observation is settled once an observation shows it.
        const pending = !!decision.scope && scopeOutcomeAnswered(item, decision.scope, judged, clock) === 'pending';
        const watch = state.approvals[key] = approvalWatchSchema.parse({ work: item.key, action: decision.action, decision: judged.id, requestedAt: stamp, settledAt: pending ? null : stamp, scope: decision.scope ?? null });
        performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: `${item.key}'s requirements decision ${judged.id} for this widening was already refused by ${judged.refusal?.approver ?? 'its approver'}; nothing to request`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
        if (!pending) await noteScopeOutcome(item, watch, judged);
        return;
      }
      // Refused attestation of this head (GY-1394): keep the refusal; return the head to a worker.
      const refusedAttest = decision.action === 'attest' ? history.find(entry => entry.action === 'attest' && entry.input?.proof === decision.input?.proof
        && entry.input?.sha === item.candidate?.sha && entry.input?.baseSha === item.candidate?.baseSha && entry.input?.policyRevision === item.policyRevision && refusedAttestationWatch(entry)) : undefined;
      if (refusedAttest) {
        state.approvals[key] = approvalWatchSchema.parse({ work: item.key, action: decision.action, decision: refusedAttest.id, requestedAt: stamp, settledAt: stamp, refusal: refusedAttestationWatch(refusedAttest) });
        performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: `${item.key}'s attest decision ${refusedAttest.id} for ${String(decision.input?.proof)} on this head was already refused by ${refusedAttest.refusal?.approver ?? 'its approver'}; nothing to request, and ${item.key} returns to a worker on that refusal`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
        return;
      }
      // One requirements at a time. GY-1701/GY-1702: adopt a covering revision; else wait (GY-1687/GY-1630).
      if (standing && decision.action === 'requirements' && !standing.input?.answers && !throughputDecisionAdopts(standing.input, decision, item)) {
        const cover = coveringScopeAdoptWatch(item, standing, decision, stamp);
        if (cover) {
          state.approvals[key] = cover;
          if (cover.scope) markHeldScopeAsk(state.scope, item.key, cover.scope.epoch, cover.scope.at);
          performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: `${item.key}'s requirements decision ${standing.id} is ${standing.state} and already plans the paths its scope request asks for; that revision answers the ask once applied, so nothing is requested for the widening`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
          return;
        }
        const other = JSON.stringify(standing.input?.plannedFiles) !== JSON.stringify(decision.input?.plannedFiles) ? 'another planned-files revision' : 'a widening that answers no scope request';
        throw new Error(`requirements decision ${standing.id} is ${standing.state} for ${other}, not the widening ${item.key}'s scope request asks for; it is left to its requester, and the control plane holds one at a time, so this one is requested once it settles: graphyard master decisions ${item.key}`);
      }
      // Stale answers/revision/plannedFiles: withdraw and re-ask (covering no-answers is adopted above).
      if (standing && decision.action === 'requirements') {
        const stale = !sameAnswers(standing.input?.answers, decision.input?.answers)
          ? `requirements decision ${standing.id} is ${standing.state} for the scope request made at ${standing.input?.answers?.at}, not the one ${item.key}'s worker made at ${decision.scope?.at ?? 'now'}`
          : standing.input?.expectedPolicyRevision !== item.policyRevision
            ? `requirements decision ${standing.id} is ${standing.state} against policy revision ${String(standing.input?.expectedPolicyRevision)}, not ${item.key}'s current revision ${item.policyRevision}`
            : JSON.stringify(standing.input?.plannedFiles) !== JSON.stringify(decision.input?.plannedFiles)
              ? `requirements decision ${standing.id} is ${standing.state} for another planned-files revision than the widening ${item.key}'s scope request now asks for`
              : null;
        if (stale) {
          if (standing.state !== 'requested' || !effects.withdraw) throw new Error(`${stale}; ${effects.withdraw ? 'only a requested decision can be withdrawn' : 'this loop has no way to withdraw it'}, and this one is requested once it settles: graphyard master decisions ${item.key}`);
          await effects.withdraw(item, standing.id, `${stale}; it can never answer the current request, so it is withdrawn for a decision that does, against the current revision`);
          standing = undefined;
        }
      }
      const observed = decision.action === 'rework' && item.observation ? { at: item.observation.at, sha: item.observation.candidate.sha } : null;
      // Cite uncited refusals of this action/candidate before the request (GY-407/475/163/229/265).
      const situated = decision.action === 'rework' || decision.action === 'recover' ? decision.action : null;
      const prefix = decision.action === 'rework' ? `${observedFrom(item)} ` : '';
      let refused: string[] = [];
      if (situated) {
        const judged = history.map(entry => ({ ...entry, reason: entry.reason ?? '' }));
        const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
        const situation = decisionSituation(situated, item);
        refused = [...new Set([
          ...uncitedRefusals(judged, situated, decisionInput(situated, item, decision.input ?? {}), same, situation),
          ...uncitedRefusals(judged, situated, decisionInput(situated, item, {}), same, situation),
        ])];
      }
      let reason = situated ? reworkDecisionReason(prefix, decision.reason, refused, situated) : fitDecisionReason('', decision.reason, '');
      if (reason === null) {
        // Retrying would be refused every time; the request is not sent, and the master is told once.
        const escalation = `escalation:${situated}-refusals:${item.key}:${refused.length}`;
        performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'failed', detail: `Did not request the ${situated} decision for ${item.key}: its ${refused.length} uncited refused ${situated} decisions no longer fit, cited, within the reason bound`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
        if (!state.actions[escalation]) await note(escalation, item, 'escalation', 'failed', `${item.key} has ${refused.length} refused ${situated} decisions that no later refused request cited, and a ${situated} request must cite each by id within the ${decisionReasonMax}-character reason bound; they no longer fit beside its grounds (${decision.reason.slice(0, 300)}), so the loop has stopped requesting it: read them with graphyard master decisions ${item.key}, then request it with graphyard master decide ${item.key} ${situated} --precedent ID[,ID] REASON citing them, or act on the item yourself`);
        return;
      }
      // Missed refusal the server names: re-request citing it, bounded (GY-229).
      let requested: { id: string } | undefined = standing, adopted = !!standing;
      for (let answers = 0; !requested; answers++) {
        try { requested = await effects.decide!(item, decision.action, reason, decision.input); }
        catch (error) {
          // GY-1374: the server names the request of this action already standing, which the history
          // read missed; it is this decision, adopted for an approver like one the read had found.
          const held = adoptedOnRefusal.includes(decision.action) ? standingNamedIn(error, decision.action) : null;
          if (held) { requested = { id: held }; adopted = true; continue; }
          const named = situated && answers < maxRefusalAnswers ? refusalNamedIn(error, situated) : null;
          const cited = named && situated && !refused.includes(named) ? reworkDecisionReason(prefix, decision.reason, [...refused, named], situated) : null;
          if (!named || cited === null) throw error;
          refused = [...refused, named];
          reason = cited;
        }
      }
      // Same decision under a moved binding: retire the other watch; carry sessions/counts and GY-849 capacity wait.
      const [retired, prior] = adopted ? Object.entries(state.approvals).find(([other, entry]) => other !== key && entry.decision === requested.id && !entry.settledAt) ?? [] : [];
      if (retired) delete state.approvals[retired];
      const kept = prior ? { ...carriedSession(prior), capacity: prior.capacity, reportedExhaustion: prior.reportedExhaustion, heldExhaustion: prior.heldExhaustion } : {};
      const watch = state.approvals[key] = approvalWatchSchema.parse({ work: item.key, action: decision.action, decision: requested.id, requestedAt: prior?.requestedAt ?? stamp, ...kept, requests: prior ? prior.requests : (carried?.requests ?? 0) + 1, ended: (prior ?? carried)?.ended ?? [], observation: observed, scope: decision.scope ?? null,
        ...(standing?.state === 'approved' && requested.id === standing.id ? { approvedAt: standing.approvedAt ?? null, approvedBy: standing.approvedBy ?? null } : {}) });
      const verdictAt = verdict ? Date.parse(verdict.at) : Number.NaN;
      if (Number.isFinite(verdictAt)) state.latency.push(latencySampleSchema.parse({ work: item.key, at: stamp, verdictToReworkMs: Math.max(0, Math.round(clock - verdictAt)) }));
      await effects.persist(state);
      // GY-883: low/medium rework applies as requested (no approver); failed → retry/escalate like any unapplied settle.
      const settledState = (requested as { state?: string }).state;
      if (settledState === 'applied' || settledState === 'failed') {
        if (settledState === 'applied') watch.settledAt = stamp;
        const why = (requested as { approvedBy?: string }).approvedBy === 'graphyard-risk-lane' || settledState === 'failed' ? 'its risk lane needs no approver' : `the control plane resumed an approved decision of ${(requested as { approvedBy?: string }).approvedBy ?? 'its approver'} whose application had recorded no outcome`;
        performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: settledState === 'applied' ? 'done' : 'failed', detail: `Requested decision ${requested.id} (${decision.action}) for ${item.key}; ${why}, and the control plane ${settledState === 'applied' ? 'applied it' : 'could not apply it'} at once: ${reason}`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
        return;
      }
      // Launch (or keep) the approver; a capacity wait keeps its oldest-first place across re-key (GY-849).
      const how = prior?.agentName ? `kept approver session ${prior.agentName}, already judging it under the earlier binding`
        : watch.capacity && capacityRelaunchWaits(watch) ? 'held its capacity wait behind the relaunch already in flight'
        : await launch(item, watch, true);
      performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: `${adopted ? `Adopted decision ${requested.id} (${decision.action}), already standing on ${item.key},` : `Requested decision ${requested.id} (${decision.action}) for ${item.key}`} and ${how}: ${reason}`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      // Late read / delivered / moved / self-healing: first miss is no fault (GY-1293/1405/1430/1505). GY-1702: held/stale-revision refuses wait.
      const heldId = heldDecisionNamedIn(error);
      if (heldId) {
        state.approvals[key] = approvalWatchSchema.parse({ work: item.key, action: decision.action, decision: heldId, requestedAt: stamp, settledAt: null });
        performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: `${item.key}'s ${decision.action} decision ${heldId} is approved and held; the control plane applies it when the attempt ends, so nothing is requested`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
        return;
      }
      if (staleRevisionDecideRefusal(error)) {
        performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: `Could not put the ${decision.action} decision for ${item.key} to an approver: ${message(error)}; ${staleRevisionDecideNote}, so the request is re-computed next cycle against the applied revision`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist, null));
        return;
      }
      const detail = `Could not put the ${decision.action} decision for ${item.key} to an approver: ${message(error)}`;
      const moot = deliveredMeanwhile(detail), moved = !moot && candidateMovedMeanwhile(detail, item), late = lateDecisionRead(detail) && !(previous?.state === 'failed' && lateDecisionRead(previous.detail));
      const why = moot ? `; ${item.key} was delivered after this cycle's snapshot, so it needs no ${decision.action} decision` : moved ? `; ${item.key}'s candidate moved after this cycle's snapshot, so the next snapshot decides afresh` : '';
      performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'failed', detail: `${detail}${why}`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist, late || moot || moved ? null : decisionFailureKind(state, item.key, detail, previous)));
    }
  };
  /**
   * Record how the approver judged the scope request a `requirements` decision answered (GY-176).
   * The worker is never sent it: the control plane holds the outcome on the item, in the same
   * transaction as the approval or refusal, and the worker reads it with its own
   * `scope-request GY-N EPOCH --wait` or `status` (a paste carries no authority in its session).
   */
  const noteScopeOutcome = async (item: Work, watch: ApprovalWatch, judged: { state: string; approvedBy: string | null; approvedAt?: string | null; approvalReason?: string | null; refusal?: { approver: string; reason: string; at?: string } | null; outcome?: string | null }) => {
    const scope = watch.scope, key = `scope:outcome:${watch.decision}`;
    if (!scope || state.actions[key]?.state === 'done') return;
    const approved = judged.state === 'applied', by = approved ? judged.approvedBy : judged.refusal?.approver;
    // A judgement the control plane did not attach to this request (its revision or the asking
    // lease had moved on) left the request as it stood: the worker sees no outcome, so none is
    // measured or reported, only that this decision answered nothing.
    if (scopeOutcomeAnswered(item, scope, judged, clock) !== 'answered') {
      await note(key, item, 'scope', 'done', `${watch.action} decision ${watch.decision} (${judged.state}) did not answer ${item.key}'s scope request (epoch ${scope.epoch}, asked at ${scope.at}): the control plane left the request as it stood, so no outcome is measured or reported`);
      return;
    }
    const why = approved ? judged.approvalReason : judged.refusal?.reason ?? judged.outcome;
    // The wait the worker saw, from its ask to the approver's answer (step 2 left the rule refusal
    // unmeasured). It ends when the control plane recorded the answer, which the worker reads at
    // once, never when this cycle observed it: a stopped or slow loop must not lengthen the sample.
    const answered = scopeAnsweredAt(item, scope, approved ? judged.approvedAt : judged.refusal?.at) ?? stamp;
    state.scope.push(scopeMeasurementSchema.parse({ work: item.key, epoch: scope.epoch, at: answered, waitedMs: Math.max(0, Date.parse(answered) - Date.parse(scope.at)), state: approved ? 'approved' : 'refused' }));
    await note(key, item, 'scope', 'done', `${approved ? 'Approved' : 'Refused'} ${item.key}'s scope request (epoch ${scope.epoch}) for ${namePaths(scope.paths)} through ${watch.action} decision ${watch.decision}${by ? ` by ${by}` : ''}${why ? `: ${boundDetail(why, 400)}` : ''}; ${scope.requestedBy} reads it with ${config.cliPath ? `node ${config.cliPath}` : 'graphyard'} scope-request ${item.key} ${scope.epoch} --wait`);
  };
  /** Look again at a decision already requested: its state on the control plane, and its session. */
  const supervise = async (item: Work, decision: RoutineDecision, key: string, watch: ApprovalWatch) => {
    // Its approver is still being launched (GY-616): there is no session to judge yet.
    if (cycle.launcher.busy(approverLaunchKey(watch.decision))) return;
    const history = effects.decisions ? await effects.decisions(item).then(result => result.decisions, () => undefined) : undefined;
    const judged = history === undefined ? undefined : history.find(entry => entry.id === watch.decision) ?? null;
    // GY-1604: an approver launched by hand while the watch held no session is the one it has, bound before anything is judged.
    if (!judged || judged.state === 'requested') await bindHandLaunch(item, watch, await sessions());
    // A same-named replacement in another pane is dated by its own launch, never by the pane it replaced (see `rebindReplacedPane`).
    if ((!judged || judged.state === 'requested') && !await rebindReplacedPane(item, watch, await sessions())) return;
    if ((!judged || judged.state === 'requested') && await approverExhausted(item, watch)) return;
    // What the silence measure names this wait (GY-1298): an approval owed its settlement is not an approver judging it.
    if (judged?.state === 'approved') Object.assign(watch, { approvedAt: judged.approvedAt ?? null, approvedBy: judged.approvedBy });
    if (judged?.state === 'held') { // GY-1702: live wait; bind race-discovered match; coveringAdopt stays watched
      await closeApprover(item, watch, 'its decision is held');
      const { detail, mark } = bindHeldSupervisedAsk(watch, judged, decision, item);
      if (mark && watch.scope) {
        if (!watch.ended.some(entry => entry.includes(heldWaitMarker))) recordWatchEnded(watch, heldWaitMarker);
        markHeldScopeAsk(state.scope, item.key, watch.scope.epoch, watch.scope.at);
      }
      if (detailChanged(state.actions[key], detail)) await note(key, item, 'decision', 'done', detail);
      return;
    }
    const seen = await sessions(), step = approvalStep(watch, judged, seen, clock, await stallInputs(watch, judged, seen));
    if (step.step === 'wait' || (watch.exhaustedAt && step.step === 'exhausted')) return;
    // A decision whose approver could not be launched for want of capacity is not a session that
    // ended: nothing is closed, counted or recorded until an account resets (GY-182).
    if (step.step === 'relaunch' && !watch.agentName && approversSpent) return;
    // A routed request judged after this observation is settled from one that shows the outcome.
    if ((step.step === 'settled' || step.step === 'refused') && watch.scope && judged && scopeOutcomeAnswered(item, watch.scope, judged, clock) === 'pending') return;
    const base = `approver:${watch.decision}`;
    // GY-1300: an approved decision whose application recorded no outcome is applied by the loop, never re-judged. Its session has
    // nothing left to do and is put down; the true state is kept on the watch for the silence measure while the request path asks
    // the control plane to replay what was approved, on the widening retry interval of any refused action.
    if (step.step === 'apply') {
      await closeApprover(item, watch, 'its decision is approved');
      recordWatchEnded(watch, step.detail);
      if (state.actions[key]?.state === 'failed' && !readyToRetry(state.actions[key], state.cycle)) return;
      if (!state.actions[`${base}:apply`]) await note(`${base}:apply`, item, 'decision', 'done', step.detail);
      await request(item, decision, key, watch);
      return;
    }
    if (step.step === 'settled') {
      await closeApprover(item, watch, 'its decision is applied');
      // GY-1702: ledger can show applied before this cycle's work snapshot reflects the held application.
      if (watch.scope && judged?.state === 'applied' && item.scopeRequest
        && item.scopeRequest.at === watch.scope.at && item.scopeRequest.epoch === watch.scope.epoch
        && scopeOutcomeAnswered(item, watch.scope, judged, clock) !== 'answered') return;
      if (watch.scope) clearHeldScopeAsk(state.scope, item.key, watch.scope.epoch, watch.scope.at);
      if (!watch.scope && decision.scope && !watch.coveringAdopt) { // GY-1702: free the ask after a non-matching hold settles
        delete state.approvals[key];
        await note(`${base}:settled`, item, 'decision', 'done', `${step.detail}; it did not answer ${item.key}'s scope ask, so the ask is requested next`);
        return;
      }
      watch.settledAt = stamp;
      // The shared memory takes the approver's judgement as it settled, never a refusal (GY-1125).
      recordSettledDecision(state.projectMemory, watch, judged, stamp);
      await note(`${base}:settled`, item, 'decision', 'done', step.detail);
      if (judged) await noteScopeOutcome(item, watch, judged);
      return;
    }
    if (step.step === 'refused') {
      // Settled for the loop: no replacement session; the refusal stands in `master status` until answered.
      await closeApprover(item, watch, 'its decision is refused');
      watch.settledAt = stamp;
      // Refused widening answers the worker; GY-1701 clears a covering adopt that left the ask open.
      if (watch.scope && judged) {
        await noteScopeOutcome(item, watch, judged);
        if (coveringAdoptLeftAskOpen(watch, item, judged, clock)) {
          delete state.approvals[key];
          await note(`${base}:refused`, item, 'decision', 'done', `${step.detail}; the covering revision did not answer ${item.key}'s scope request, so the ask is requested again`);
        }
        return;
      }
      // GY-1394: a refused attestation returns the head to a worker on it, with no second approver.
      const attested = watch.action === 'attest' ? refusedAttestationWatch(judged) : null;
      if (attested) { watch.refusal = attested; await note(`${base}:refused`, item, 'decision', 'done', `${step.detail}; ${item.key} returns to a worker on that refusal`); return; }
      // GY-1606: a rework this binding adopted while it stood requested on other grounds (a capped review rework
      // its approver refused as non-blocking) never judged these: the watch is dropped, and this binding's own
      // request is made at once, on the fresh observation this step was reached on. The refusal is no one's to answer by hand.
      const refusedBinding = judged?.input?.binding;
      if (watch.action === 'rework' && refusedOnOtherGrounds(refusedBinding, decision.binding)) {
        delete state.approvals[key];
        await note(`${base}:refused`, item, 'decision', 'done', `${step.detail}; it judged ${String(refusedBinding).slice(41)}, not ${decision.binding.slice(41)}, which ${item.key} still needs, so the loop requests that rework on its own grounds`);
        await request(item, decision, key, null);
        return;
      }
      // A refused capped review rework is answered by the review-cap step: it withdraws the change request and has the head re-reviewed.
      if (watch.action === 'rework' && cappedReworkBound(refusedBinding)) {
        await note(`${base}:refused`, item, 'decision', 'done', `${step.detail}; the review-cap step withdraws the change request and has the head re-reviewed with its findings as FOLLOW-UP, so the loop does not request it again`);
        return;
      }
      await note(`escalation:decision-refused:${watch.decision}`, item, 'escalation', 'done', `${step.detail}. The loop does not request it again or launch another approver; answer the refusal: read it with graphyard master decisions ${item.key}, then request what the item needs with a reason that cites ${watch.decision} and gives what the refused request lacked, or act on the refusal instead`);
      return;
    }
    // Every other step replaces the session, so the one that ended goes first (with the close, the
    // relaunch — one at a time for a capacity wait, GY-849 — the record and the escalation shared
    // with the hand watches, GY-779). Only the re-request returns here: it is bound to this
    // request, so it is taken below.
    if (await actOnStep(item, watch, step) !== 'rerequest') return;
    // Server settled it failed/stale/withdrawn: re-request within the widening bound. GY-1484: closed-scope failure gets one request back.
    // GY-1702 AC-3: clear a covering adopt as soon as its revision is gone so the ask's wait/bound resume even when the replacement defers or fails.
    const uncounted = uncountedScopeFailure(watch, judged, item);
    if (uncounted && watch.givenBack !== watch.decision) Object.assign(watch, { requests: Math.max(0, watch.requests - 1), givenBack: watch.decision });
    const coveringGone = clearCoveringAdoptIfGone(state.approvals, state.scope, key, watch, item, judged ?? null, clock);
    if (watch.requests >= maxDecisionRequests) { if (!watch.exhaustedAt) await escalateUnjudged(item, watch, step.detail); return; }
    if (state.actions[key]?.state === 'failed' && !readyToRetry(state.actions[key], state.cycle)) return;
    const moved = judged?.state === 'stale' || judged?.state === 'superseded' || judged?.state === 'withdrawn' || uncounted;
    if (!state.actions[`${base}:ended`]) await note(`${base}:ended`, item, 'decision', moved ? 'done' : 'failed', coveringGone
      ? `${step.detail}; the covering revision did not answer ${item.key}'s scope request, so the ask's wait resumes and it is requested again`
      : `${step.detail}; ${item.key} still needs it, so it is requested again`);
    await request(item, decision, key, coveringGone ? null : watch);
  };
  const needed = new Set<string>(), unattestable = new Set<string>(), budget = decisionBudget(state, now, (config.run.intervalSeconds ?? 20) * 1000);
  const pause = githubPause(snapshot.jobs, clock);
  // A scope request is judged by the review-finding rule (step 2a) before it is the approver's: the
  // findings for this request and policy revision were read and named none of it. A loop that
  // cannot read findings or widen on them has no rule to wait for.
  const findingsJudged = (item: Work) => {
    const request = item.scopeRequest;
    // A carried ask (GY-1568) outlived its attempt: the finding rule widens only for a live one, so it is the approver's.
    if (!request) return !!item.carriedScopeRequest;
    if (!effects.reviewFindings || !effects.widenScope) return true;
    const judged = state.actions[`${scopeKey(item, request)}:finding:${item.policyRevision}`];
    return judged?.state === 'done' && !/^Widened /.test(judged.detail);
  };
  // GY-566: a docs-only conflict routes to a docs-sync session instead of a rework decision. The
  // route — classification, session watch, hotspot log — lives in docs-sync-route.ts; the step
  // runs its sweep here and consults `holds` where a conflict rework decision would be requested.
  const docsSync = docsSyncRoute({ config, state, effects, snapshot, sessions, note, inventorySpent: invalidate, stamp, clock });
  await docsSync.sweep();
  // GY-849: when capacity frees, the capacity-refused decisions are relaunched oldest first. The
  // items a waiting decision belongs to move to the front of the step in age order, and their
  // relaunches enter the launcher one at a time (`capacityRelaunchInFlight`), so the oldest waiting
  // decision is the one that meets the freed slot, not the first the snapshot happened to list.
  const capacityRank = new Map<string, number>();
  if (!approversSpent) for (const watch of Object.values(state.approvals)) {
    if (!watch.capacity || watch.settledAt) continue;
    const age = Date.parse(watch.requestedAt);
    if (!Number.isFinite(age)) continue;
    const held = capacityRank.get(watch.work);
    if (held === undefined || age < held) capacityRank.set(watch.work, age);
  }
  const waitingRank = (item: Work) => capacityRank.get(item.key) ?? Number.POSITIVE_INFINITY;
  const ordered = deferredFirst(snapshot.work, state.decisionsDeferred), workToProcess = capacityRank.size ? [...ordered].sort((a, b) => waitingRank(a) - waitingRank(b)) : ordered;
  // A producer request whose attempts are used up calls for rework once its escalation stood a cycle (GY-496).
  const exhausted = (await cycle.exhaustedProofs()).filter(entry => { const raised = state.actions[exhaustedProofKey(entry)]; return !!raised && raised.cycle < state.cycle; });
  // A needed decision with no watch is requested once ready to retry, or escalated.
  const requestNeeded = async (item: Work, decision: RoutineDecision, key: string) => {
    const previous = state.actions[key];
    if (previous?.state === 'failed' && !readyToRetry(previous, state.cycle) && !lateDecisionRead(previous.detail) && !selfHealingDecisionFailure(previous.detail) && !staleRevisionDecideDetail(previous.detail)) return;
    if (effects.decide && effects.approver) return request(item, decision, key, null);
    const escalationKey = `escalation:decision:${item.id}:${decision.binding}`, input = decision.action === 'attest' ? ` '${JSON.stringify(decision.input)}'` : '';
    const detail = `${item.key} needs a${decision.action === 'attest' ? 'n' : ''} ${decision.action} decision: ${decision.reason} This loop runs without the decision effects, so it cannot request one: graphyard master decide ${item.key} ${decision.action}${input} REASON, then graphyard master approver ${item.key} DECISION`;
    if (detailChanged(state.actions[escalationKey], detail)) performed.push(await record(state, escalationKey, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail, attempts: (state.actions[escalationKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
  };
  const wake = effects.observe && observationWaker(effects.observe);
  const noteWait = async (item: Work, detail: string) => { const waitKey = `wait:rework:${item.id}`; if (detailChanged(state.actions[waitKey], detail)) await note(waitKey, item, 'decision', 'done', detail); };
  // GY-1436: one stable wait per held item, naming the docs-sync session, head, base and the end of its bound; that bound, reached or still ahead, ends the loop's idle wait (GY-1622), kept at the latest local time the control plane can reach it (the read's upper clock offset): the cycle it wakes finds the hold ended, at most one round trip late.
  const noteHold = async (item: Work, { wait: detail, deadline }: { wait: string; deadline: string }) => { const bound = Date.parse(deadline); const waitKey = `wait:docs-sync:${item.id}`; if (bound >= clock) bounds.set(item.id, bound + clockOffset.max); if (detailChanged(state.actions[waitKey], detail)) await note(waitKey, item, 'decision', 'done', detail); };
  const mechanical = effects.mechanicalFixes ? await effects.mechanicalFixes().then(read => read.requests, () => []) : []; // GY-971 planned bot rounds; GY-1764: reported to the review gate, an unreported plan holds its item's decision
  const planUnreported = await reportMechanicalPlans(snapshot.work, mechanical, effects, clock, async (item, detail) => { const key = `mechanical-plan:${item.id}`; if (detailChanged(state.actions[key], detail)) await note(key, item, 'decision', 'failed', detail); });
  const routinePass = budget.pass(), attestPass = budget.pass();
  // GY-1439: while a close stands requested and unapplied on an item, nothing advances it (closingItems): no
  // bot round, rework, attestation or observation wake moves the revision under the close or spends a round on it.
  // Its decisions are not needed meanwhile, so a request of the loop's still standing on it is withdrawn below.
  const closing = closingItems(cycle);
  const noteClosing = async (item: Work, action: string, close: string) => {
    const key = `wait:closing:${item.id}`, detail = `${item.key}: close decision ${close} stands unapplied, so the loop takes no ${action} decision on it while it is being closed`;
    if (detailChanged(state.actions[key], detail)) await note(key, item, 'decision', 'done', detail);
  };
  // Attestations an approver refused (GY-1394), kept on their watches, indexed once per cycle by item.
  const refusedByWork = new Map<string, RefusedAttestation[]>();
  for (const watch of Object.values(state.approvals)) if (watch.action === 'attest' && watch.refusal) refusedByWork.set(watch.work, [...refusedByWork.get(watch.work) ?? [], { decision: watch.decision, refusal: watch.refusal }]);
  for (const read of workToProcess) await isolate('decision', read, read.key, async () => { const reached = bounds.get(read.id), released = { at: false }; bounds.delete(read.id); try { await decideItem(read, reached, released); } catch (error) { if (reached !== undefined && !released.at && !bounds.has(read.id)) bounds.set(read.id, reached); throw error; } });
  async function decideItem(item: Work, reached: number | undefined, released: { at: boolean }) { if (planUnreported.has(item.id)) return; // the item's bound is re-set below while its hold stands; a throw before the hold read as released puts it back above, so a transient closeStanding or docsSync.hold failure keeps the idle wait ending there (GY-1624)
    const assessment = assessments[item.id];
    // A request step 2 refused this cycle is read as it was decided, not as the snapshot saw it, and
    // its decision is requested against that revision: one a partial widening moved past the
    // snapshot's would carry a policy revision its approval could never apply to (GY-1293).
    const scoped = settled.get(item.id) ?? item;
    const scope = scopeRoutineDecision(scoped, clock, findingsJudged(scoped)) ?? blockerScopeDecision(scoped);
    if (scope) item = scoped;
    const refused = refusedByWork.get(item.key) ?? [];
    let decision = scope ?? (effects.decide && effects.approver ? throughputRoutineDecision(item, state.actions) : null) ?? routineDecision(item, config, clock, assessment, cycle.baseFailed.get(item.id), exhausted, mechanical, refused); // GY-1630: the throughput owner's standing needs-decision is the loop's to request
    if (!decision) {
      // Still called for, only not attestable this cycle: its request is not one the item moved past.
      const called = neededDecision(item, config, cycle.baseFailed.get(item.id), exhausted, mechanical, refused);
      if (called) unattestable.add(decisionKey(item, called));
      // The item needs the decision and the loop will not attest what it could not verify. Step 3b
      // has already escalated an open item whose fence this host assessed and could not settle.
      const withheld = withheldDecision(item, config, clock, assessment);
      const escalationKey = `escalation:decision-withheld:${item.id}:${item.containmentQuarantine?.epoch ?? item.epoch}`;
      const detail = withheld ? `${withheld.reason}. Stop the supervisor on its registered host and settle the fence there (graphyard master settle-containment ${item.key}), or request the decision yourself on an attestation you verified` : '';
      if (withheld && !(item.stage !== 'done' && assessment) && detailChanged(state.actions[escalationKey], detail)) await note(escalationKey, item, 'escalation', 'done', detail);
      return;
    }
    const close = decision.action === 'close' ? undefined : await closeStanding(effects, item, snapshot.work, closing);
    if (close) return noteClosing(item, decision.action, close);
    let key = decisionKey(item, decision); if (routinePass.over()) { needed.add(key); budget.defer(item); if (reached !== undefined) bounds.set(item.id, reached); return; }
    // A confirmed conflict confined to docs pages is a docs-sync's, not a worker's (GY-566). A standing
    // hold is the item's recorded wait, never a bare skip (GY-1436); one that ended awaits an
    // observation since, which the step wakes below rather than waiting for one unprompted.
    // A docs-sync stopped at the loop-owned rework's cutoff (GY-1434) gives the conflict up on a reading taken since: woken here at
    // once, or by the observation job for the next cycle. That reading is the one the rework is then decided from.
    const synced: { work: Work | null } = { work: null };
    const observe = async (work: Work) => { synced.work = wake ? await wake(work, clock) : null; if (!synced.work) await wakeObservationJob(cycle, work, 'docs-sync give-up'); return synced.work; };
    const docsConflict = (subject: Work, routine: RoutineDecision) => routine.action === 'rework' && !state.approvals[decisionKey(subject, routine)] && !!baseRefreshConflict(subject) && routine.binding === `${subject.candidate!.sha}:conflict`;
    const hold = docsConflict(item, decision) ? await docsSync.hold(item, observe) : null;
    if (hold?.held) return noteHold(item, hold); released.at = true;
    if (synced.work && synced.work.candidate?.sha === item.candidate?.sha && synced.work.policyRevision === item.policyRevision) item = synced.work;
    needed.add(key);
    // Rework waits for an observation that still describes the item (GY-144); the step wakes it unless paused (GY-793) and re-decides.
    // The loop's own landed wake of the submitted head counts as that observation, whatever its age (GY-1266, GY-1257).
    const woken = state.actions[`wake:observation:${item.id}`];
    const endedWait = (subject: Work, at: string) => `${subject.key}: its docs-sync hold ended at ${at}; rework waits for an observation since then showing the head unmoved`;
    let wait = conflictReworkOverdue(item, decision, clock) ? null : hold?.awaiting ? endedWait(item, hold.awaiting)
      : decision.action === 'rework' ? reworkObservationWait(item, clock, pause, woken?.state === 'done' ? woken.at : null) : null;
    const fresh = wait && !pause && wake && !state.approvals[key] ? await wake(item, clock) : null;
    const again = fresh && routineDecision(fresh, config, now(), assessment, fresh.candidate?.sha === item.candidate?.sha ? cycle.baseFailed.get(item.id) : undefined, [], [], refused);
    if (fresh && again?.action !== 'rework') return noteWait(item, `${item.key}: woke its observation for a rework decision; the reading at ${fresh.observation?.at ?? 'unknown'} no longer calls for one`);
    if (fresh && again) {
      item = fresh; decision = again; key = decisionKey(item, decision); needed.add(key);
      // The fresh reading settles an ended docs-sync hold in the cycle it ended (GY-1436).
      const settled = hold?.awaiting && docsConflict(item, decision) ? await docsSync.hold(item) : null;
      if (settled?.held) return noteHold(item, settled);
      wait = conflictReworkOverdue(item, decision, now()) ? null : settled?.awaiting ? endedWait(item, settled.awaiting) : reworkObservationWait(item, now(), pause);
    }
    const watch = state.approvals[key];
    if (wait) {
      await noteWait(item, wait);
      // The refusal wakes the item's observation job at once (GY-710); rework is decided once it lands.
      // Its one-per-item wake:observation entry stays for guarded merge; pruneDaemonState bounds it.
      return wakeObservationJob(cycle, item, 'rework');
    }
    // Settled watches are done; GY-1701 re-requests when a covering adopt's revision later vanishes.
    if (watch) {
      if (!watch.settledAt) await supervise(item, decision, key, watch);
      else {
        const stranded = watch.scope && effects.decisions ? await effects.decisions(item).then(r => r.decisions.find(e => e.id === watch.decision), () => undefined) : undefined;
        if (stranded && coveringAdoptLeftAskOpen(watch, item, stranded, clock)) {
          delete state.approvals[key];
          await note(`approver:${watch.decision}:covering-cleared`, item, 'decision', 'done', `Cleared covering watch for ${watch.decision} (${stranded.state}); ${item.key}'s scope ask is requested again`);
          await requestNeeded(item, decision, key);
        } else if (watch.session) await endApproverSession(item, watch, `approver for ${watch.work} decision ${watch.decision} settled`);
      }
      return;
    }
    // GY-1606: a request of these grounds another binding adopted comes back to this key, so its refusal is answered as this binding's.
    const others = decision.action === 'rework' && effects.decisions && Object.values(state.approvals).some(entry => entry.work === item.key && !entry.settledAt);
    const [from, adopted] = others ? adoptedWatch(state.approvals, await effects.decisions!(item).then(result => result.decisions, () => []), item.key, decision.action, decision.binding, key) ?? [] : [];
    if (from && adopted) { delete state.approvals[from]; state.approvals[key] = adopted; return supervise(item, decision, key, adopted); }
    // A done entry with no watch adopts the standing decision and launches an approver.
    await requestNeeded(item, decision, key);
  }
  // 4c+. Attestations (GY-521): one attest decision per `manual:` proof no producer may run, bound to its head, one at a time.
  for (const item of ordered) await isolate('decision', item, item.key, async () => {
    const attestations = attestDecisions(item, snapshot.work, clock);
    const close = attestations.length ? await closeStanding(effects, item, snapshot.work, closing) : null;
    if (close) return noteClosing(item, 'attest', close);
    let judging = false; if (attestations.length && attestPass.over()) { for (const decision of attestations) needed.add(decisionKey(item, decision)); budget.defer(item); return; }
    for (const decision of attestations) {
      const key = decisionKey(item, decision), watch = state.approvals[key];
      needed.add(key);
      if (watch && !watch.settledAt) { judging = true; await supervise(item, decision, key, watch); }
      else if (watch?.session) await endApproverSession(item, watch, `approver for ${watch.work} decision ${watch.decision} settled`);
    }
    const next = judging ? undefined : attestations.find(decision => !state.approvals[decisionKey(item, decision)]);
    if (next) await requestNeeded(item, next, decisionKey(item, next));
  });
  // A watch whose item no longer needs its decision is closed rather than left holding a provider seat.
  for (const [key, watch] of Object.entries(state.approvals)) await isolate('decision', snapshot.work.find(candidate => candidate.key === watch.work) ?? null, watch.work, async () => {
    // A watch the loop made for a session it did not launch has no request of the loop's to take back (below).
    if (needed.has(key) || key.startsWith(handWatchPrefix)) return;
    if (!(await sessions()).available) return;
    const item = snapshot.work.find(candidate => candidate.key === watch.work);
    // A request the item moved past is taken back by the identity that made it, whatever its
    // action: left `requested`, it would be adopted for some later round on a reason that describes
    // an older head. One the item still calls for stays, and is adopted when it can be attested.
    let withdrawn = true;
    // An applied widening clears the request it answered, and so does the approver's refusal, so
    // the item stops needing it at once: its outcome is noted and measured here, before the watch goes.
    if (item && watch.scope && !watch.settledAt && effects.decisions) {
      const judged = await effects.decisions(item).then(result => result.decisions.find(entry => entry.id === watch.decision), () => undefined);
      if (judged?.state === 'applied' || judged?.state === 'refused') {
        if (scopeOutcomeAnswered(item, watch.scope, judged, clock) === 'pending') return;
        clearHeldScopeAsk(state.scope, item.key, watch.scope.epoch, watch.scope.at);
        watch.settledAt = stamp; await noteScopeOutcome(item, watch, judged);
      }
    }
    // Another current watch holds this decision: the request is not moved past, only re-keyed.
    if (Object.entries(state.approvals).some(([other, entry]) => other !== key && needed.has(other) && entry.decision === watch.decision)) { delete state.approvals[key]; return; }
    if (watch.coveringAdopt) { // GY-1701: drop without withdrawing the foreign no-answers revision
      if (item) await closeApprover(item, watch, `${watch.work} no longer needs its covering watch for ${watch.action} decision ${watch.decision}`);
      else await endWatchSession(watch, `${watch.work} is no longer open`);
      delete state.approvals[key];
      return;
    }
    if (item && !watch.settledAt && !unattestable.has(key) && effects.withdraw && effects.decisions) {
      try {
        const standing = (await effects.decisions(item)).decisions.find(entry => entry.id === watch.decision);
        if (standing?.state === 'requested') {
          await effects.withdraw(item, watch.decision, `${watch.work} moved past the ${watch.action} this decision asked for before any approver judged it, so its reason no longer describes the item`);
          await note(`approver:${watch.decision}:withdrawn`, item, 'decision', 'done', `Withdrew ${watch.action} decision ${watch.decision}: ${watch.work} no longer needs it and no approver had judged it`);
        }
      } catch (error) {
        withdrawn = false; watch.closeAttempts += 1;
        // GY-1405: a history read that only missed the step's deadline judged nothing, as on the
        // request path (GY-1293): one alone is no fault, and the withdrawal is tried next cycle; the
        // second in a row counts. A withdrawal refused on an item delivered meanwhile is moot.
        const withdrawKey = `approver:${watch.decision}:withdrawn`, prior = state.actions[withdrawKey];
        const detail = `Could not withdraw ${watch.action} decision ${watch.decision}, which ${watch.work} no longer needs: ${message(error)}`;
        const late = lateDecisionRead(detail) && !(prior?.state === 'failed' && lateDecisionRead(prior.detail));
        await note(withdrawKey, item, 'decision', 'failed', detail, now(), late || deliveredMeanwhile(detail) ? null : undefined);
      }
    }
    // An item no longer open has no pane to close, but its registry session still holds a slot.
    let closed = true;
    if (item) closed = await closeApprover(item, watch, `${watch.work} no longer needs ${watch.action} decision ${watch.decision}`);
    else closed = await endWatchSession(watch, `${watch.work} is no longer open`);
    // A tab that will not close, or a request that cannot be taken back, is left to the operator
    // after a few tries; the session name is this decision's alone, so it can refuse no other launch.
    // A registry session is not: its id is the only way to end it, and while it lives it holds the
    // role's slot, so the watch stays, past any bound, until the registry is told.
    if ((closed && withdrawn) || (watch.closeAttempts >= maxApproverCloses && !watch.session)) delete state.approvals[key];
  });
  await settleDeferred(cycle, budget);
  await approvers.superviseHandApprovers();
  await approvers.reconcileRegistrySessions();
  syncHeldScopeAskMarks(state.scope, Object.values(state.approvals));
  // 4c++. A close that went stale on a revision race is requested again against the fresh revision, its grounds re-validated (GY-1439).
  await staleCloseStep(cycle, effects, written);
  // 4c+++. A stale release of a backlog item is asked again, whoever asked first (GY-1315): last, so its backlog reads hold nothing above.
  await staleReleaseStep(cycle, effects);
}
