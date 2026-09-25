// Concern: cycle step 4c — request and supervise the routine decisions and their approver sessions.
import { uncitedRefusals } from '../model/approval.js';
import type { Work } from '../model.js';
import { type ContainmentAssessment, type HerdrAgent, approverSessionName, approvedMerge, decisionInput } from '../master.js';
import { type ApprovalWatch, approvalWatchSchema, type DaemonActionKind, latencySampleSchema, message, scopeMeasurementSchema } from './state.js';
import { decisionKey, scopeAnsweredAt, scopeKey, scopeOutcomeAnswered } from './reconcile.js';
import { readyToRetry } from './sessions.js';
import { approvalStep, boundDetail, decisionReasonMax, detailChanged, fitDecisionReason, githubPause, maxApproverCloses, maxApproverLaunches, maxDecisionRequests, namePaths, neededDecision, observedFrom, resolveCovers, reworkDecisionReason, reworkObservationWait, routineDecision, type RoutineDecision, sameAnswers, scopeRoutineDecision, standingVerdict, withheldDecision } from './decisions.js';
import { record } from './effects.js';
import type { Cycle } from './cycle.js';

/** Step 4c: request and supervise the routine decisions. */
export async function decisionStep(cycle: Cycle, settled: Map<string, Work>, assessments: Record<string, ContainmentAssessment>) {
  const { config, state, effects, now, snapshot, clock, performed, isolate, agents, open } = cycle;
  // 4c. The routine decisions. A standing verdict, a base the control plane could not merge in, and
  //     a delivered item still fenced by a dead supervisor each have one correct answer, and each
  //     used to wait for a master session to notice. The loop requests the decision with the
  //     master's own operator-agent identity and launches the independent approver session for it;
  //     it never approves its own request, so the separation the server enforces is unchanged.
  //     Automatic merging turned off is the fourth: the merge itself then waits for that approval.
  //     A request is not the end of it. The approver is a launched session like any other, so every
  //     cycle reads the decision back and looks at its session again (see `approvalStep`): a
  //     finished session is closed, a dead, stalled or hung one is replaced within a bound, a
  //     refused one is left to the master to answer, a decision the server settled some other way
  //     is requested again, and one no session will judge is escalated and left standing on the
  //     silence measure.
  const stamp = new Date(clock).toISOString();
  // One Herdr read serves the step, and is taken again after anything that changes the inventory.
  let inventory: { agents: HerdrAgent[]; available: boolean } | null = null;
  const sessions = async () => inventory ??= await effects.herdr?.() ?? { agents: await effects.agents(), available: true };
  const note = async (key: string, item: Work, kind: DaemonActionKind, outcome: 'done' | 'failed', detail: string) =>
    performed.push(await record(state, key, { kind, work: item.key, principal: null, state: outcome, detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
  /** Close the approver session a watch names, if Herdr still lists it. False only when it could not be closed. */
  const closeApprover = async (item: Work, watch: ApprovalWatch, why: string) => {
    const session = watch.agentName ? (await sessions()).agents.find(agent => agent.name === watch.agentName) : undefined;
    if (!session?.pane_id) return true;
    const key = `close:approver:${watch.decision}:${session.pane_id}`;
    try { await effects.closeSession(session.pane_id); inventory = null; await note(key, item, 'close', 'done', `Closed approver session ${watch.agentName} (${session.agent_status ?? 'unknown'}): ${why}`); return true; }
    catch (error) { inventory = null; watch.closeAttempts += 1; await note(key, item, 'close', 'failed', `Could not close approver session ${watch.agentName}: ${message(error)}`); return false; }
  };
  /** Put a watched decision to an approver session. The launch is counted before it is made. */
  const launch = async (item: Work, watch: ApprovalWatch, adopt: boolean) => {
    const name = approverSessionName(item, watch.decision), seen = await sessions();
    // A session a master started for the same decision (`master approver`) is the approver it has.
    const listed = adopt && seen.available ? seen.agents.find(agent => agent.name === name) : undefined;
    Object.assign(watch, { launches: watch.launches + 1, agentName: name, pane: listed?.pane_id ?? null, launchedAt: stamp });
    await effects.persist(state);
    if (listed) return `adopted approver session ${name}, already judging it`;
    inventory = null;
    const launched = await effects.approver!(item, watch.decision);
    Object.assign(watch, { agentName: launched?.agentName ?? name, pane: launched?.pane ?? null });
    return `launched independent approver session ${watch.agentName} (launch ${watch.launches} of ${maxApproverLaunches})`;
  };
  const escalateUnjudged = async (item: Work, watch: ApprovalWatch, detail: string) => {
    watch.exhaustedAt = stamp;
    await note(`escalation:decision-unjudged:${watch.decision}`, item, 'escalation', 'failed', `${detail}. ${watch.launches} approver session(s) and ${watch.requests} request(s) have not produced a judgement${watch.ended.length ? ` (${watch.ended.join('; ')})` : ''}, so the loop has stopped spending sessions on it: read it with graphyard master decisions ${item.key}, then put it to a fresh approver with graphyard master approver ${item.key} ${watch.decision}, or take the request back and decide what the item needs instead`);
  };
  /** Request the decision (or adopt the one already standing) and put it to an approver. */
  const request = async (item: Work, decision: RoutineDecision, key: string, carried: ApprovalWatch | null) => {
    const verdict = decision.action === 'rework' && !carried ? standingVerdict(item) : null;
    const attempts = (state.actions[key]?.attempts ?? 0) + 1;
    await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'started', detail: `Requesting the ${decision.action} decision for ${item.key}`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist);
    try {
      const history = effects.decisions ? (await effects.decisions(item).catch(() => ({ decisions: [] }))).decisions : [];
      const applied = decision.action === 'merge' ? approvedMerge(item, history) : null;
      if (applied) {
        state.approvals[key] = approvalWatchSchema.parse({ work: item.key, action: decision.action, decision: applied.id, requestedAt: stamp, settledAt: stamp });
        performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: `${item.key} already holds an applied merge decision for candidate ${decision.binding.slice(0, 12)}; nothing to request`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
        return;
      }
      // A request whose response was lost is already standing on the item, and the server refuses a
      // second one; adopting it is what keeps a retry from leaving a decision nobody will judge.
      let standing = history.find(entry => entry.action === decision.action && (entry.state === 'requested' || entry.state === 'approved'));
      // Only a merge decision names what it binds. One standing for an earlier candidate can never
      // apply to this one, and it refuses the request that could: the requester takes it back.
      if (standing && decision.action === 'merge' && !(standing.input?.sha === item.candidate?.sha && standing.input?.baseSha === item.candidate?.baseSha && standing.input?.policyRevision === item.policyRevision)) {
        const stale = `merge decision ${standing.id} is ${standing.state} for candidate ${String(standing.input?.sha).slice(0, 12)}, not the current ${decision.binding.slice(0, 12)}`;
        if (standing.state !== 'requested' || !effects.withdraw) throw new Error(`${stale}, and ${effects.withdraw ? 'only a requested decision can be withdrawn' : 'this loop has no way to withdraw it'}: graphyard master decisions ${item.key}`);
        await effects.withdraw(item, standing.id, `The candidate moved to ${decision.binding.slice(0, 12)}; ${stale}, so it can never apply and is withdrawn for a request that names the current candidate`);
        standing = undefined;
      }
      // Nor does the server keep more than one resolve standing, whatever its trigger. One for
      // another escalation (a security-concern a master asked about) is not this decision: adopting
      // it would settle this watch while the lease-loss still stands, and the binding would never
      // ask again. It is left to its own requester, and this one is asked once it settles.
      if (standing && decision.action === 'resolve' && decision.escalation && !resolveCovers(standing, decision.escalation)) {
        throw new Error(`resolve decision ${standing.id} is ${standing.state} for ${String(standing.input?.trigger)}, not the ${decision.escalation.trigger} raised at ${decision.escalation.at}; the control plane holds one resolve at a time, so this one is requested once it settles: graphyard master decisions ${item.key}`);
      }
      // An approver already refused this very request (a cursor lost since, or a restart): that is
      // its judgement, not a request to repeat — the server would refuse the repeat on every retry.
      // The refusal answers the request it names (`answers`): a worker that withdraws a refused ask
      // and asks again for the same paths with a better reason makes a new request, and it is asked.
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
      // The control plane holds one requirements decision at a time. One that answers no scope
      // request (a master's own revision) is not this request's answer: it is left to its
      // requester, and this one is asked once it settles.
      if (standing && decision.action === 'requirements' && !standing.input?.answers) {
        const other = JSON.stringify(standing.input?.plannedFiles) !== JSON.stringify(decision.input?.plannedFiles) ? 'another planned-files revision' : 'a widening that answers no scope request';
        throw new Error(`requirements decision ${standing.id} is ${standing.state} for ${other}, not the widening ${item.key}'s scope request asks for; it is left to its requester, and the control plane holds one at a time, so this one is requested once it settles: graphyard master decisions ${item.key}`);
      }
      // A scope decision answers the one request it names (`answers`), against the requirements of
      // one policy revision. One standing for a request the worker has since withdrawn and asked
      // again, or against a revision a later widening or review-policy bump has superseded (which
      // may also have moved plannedFiles), can never apply: the server rejects its approval and
      // leaves its refusal unattached, so adopting it would settle this request unasked. Whatever
      // the file list now reads, the loop takes it back and asks — as a merge for an earlier
      // candidate — before treating a differing list as anything but its own stale request.
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
      // A rework request names the observation it was decided from (GY-144), so its approver sees
      // at once whether the item has moved since; the watch keeps the same pair.
      const observed = decision.action === 'rework' && item.observation ? { at: item.observation.at, sha: item.observation.candidate.sha } : null;
      // The server refuses a request identical to a refused one unless it cites that refusal. The loop
      // reaches this point only on grounds no refused request of its own rested on (a rework binding
      // names its grounds, and a refused binding is never requested again), so it answers the prior
      // refusals of this action on the item by citing them. A refusal an earlier refused request
      // already cited is answered through it, so only the uncited ones are named: however many
      // refusals the item gathers, the citation stays the newest one or few (GY-163).
      const refused = decision.action === 'rework' ? uncitedRefusals(history.map(entry => ({ ...entry, reason: entry.reason ?? '' })), 'rework', decisionInput('rework', item, {}), (a, b) => JSON.stringify(a) === JSON.stringify(b)) : [];
      const reason = decision.action === 'rework' ? reworkDecisionReason(`${observedFrom(item)} `, decision.reason, refused) : fitDecisionReason('', decision.reason, '');
      if (reason === null) {
        // Retrying would be refused every time; the request is not sent, and the master is told once.
        const escalation = `escalation:rework-refusals:${item.key}:${refused.length}`;
        performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'failed', detail: `Did not request the rework decision for ${item.key}: its ${refused.length} uncited refused rework decisions no longer fit, cited, within the reason bound`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
        if (!state.actions[escalation]) await note(escalation, item, 'escalation', 'failed', `${item.key} has ${refused.length} refused rework decisions that no later refused request cited, and a rework request must cite each by id within the ${decisionReasonMax}-character reason bound; they no longer fit beside its grounds (${decision.reason.slice(0, 300)}), so the loop has stopped requesting it: read them with graphyard master decisions ${item.key}, then request it with graphyard master decide ${item.key} rework --precedent ID[,ID] REASON citing them, or act on the item yourself`);
        return;
      }
      const requested = standing ?? await effects.decide!(item, decision.action, reason, decision.input);
      // A standing request another watch holds is the same decision under a binding that has since
      // changed (a rework's unresolved-thread set moved while it was requested). That watch is
      // retired here, its sessions and counts carried over, so the cleanup below does not withdraw
      // the decision this watch just adopted and close its approver — on every cycle the set moves.
      const [retired, prior] = standing ? Object.entries(state.approvals).find(([other, entry]) => other !== key && entry.decision === requested.id && !entry.settledAt) ?? [] : [];
      if (retired) delete state.approvals[retired];
      const kept = prior ? { launches: prior.launches, agentName: prior.agentName, pane: prior.pane, launchedAt: prior.launchedAt, exhaustedAt: prior.exhaustedAt } : {};
      const watch = state.approvals[key] = approvalWatchSchema.parse({ work: item.key, action: decision.action, decision: requested.id, requestedAt: prior?.requestedAt ?? stamp, ...kept, requests: prior ? prior.requests : (carried?.requests ?? 0) + 1, ended: (prior ?? carried)?.ended ?? [], observation: observed, scope: decision.scope ?? null });
      // A verdict measured from when the reviewer landed it to when the loop asked for the round it
      // needs. A base conflict has no verdict behind it, so it is not part of that measurement. It
      // is sampled with the request, before the launch: a request whose first launch throws is
      // supervised from the watch and never comes back through here.
      const verdictAt = verdict ? Date.parse(verdict.at) : Number.NaN;
      if (Number.isFinite(verdictAt)) state.latency.push(latencySampleSchema.parse({ work: item.key, at: stamp, verdictToReworkMs: Math.max(0, Math.round(clock - verdictAt)) }));
      await effects.persist(state);
      // The request alone changes nothing; the approver session is what applies it. A launch that
      // fails leaves the watch behind, so the next cycle sees a decision with no session and
      // launches again, inside the same bound.
      // A retired watch's approver is judging this decision already; supervision relaunches it if it ends.
      const how = prior?.agentName ? `kept approver session ${prior.agentName}, already judging it under the earlier binding` : await launch(item, watch, true);
      performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: `${standing ? `Adopted decision ${requested.id} (${decision.action}), already standing on ${item.key},` : `Requested decision ${requested.id} (${decision.action}) for ${item.key}`} and ${how}: ${reason}`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'failed', detail: `Could not put the ${decision.action} decision for ${item.key} to an approver: ${message(error)}`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
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
    const history = effects.decisions ? await effects.decisions(item).then(result => result.decisions, () => undefined) : undefined;
    const judged = history === undefined ? undefined : history.find(entry => entry.id === watch.decision) ?? null;
    const step = approvalStep(watch, judged, await sessions(), clock);
    if (step.step === 'wait' || (watch.exhaustedAt && step.step === 'exhausted')) return;
    // A routed request judged after this observation is settled from one that shows the outcome.
    if ((step.step === 'settled' || step.step === 'refused') && watch.scope && judged && scopeOutcomeAnswered(item, watch.scope, judged, clock) === 'pending') return;
    const base = `approver:${watch.decision}`;
    if (step.step === 'settled') {
      await closeApprover(item, watch, 'its decision is applied');
      watch.settledAt = stamp;
      await note(`${base}:settled`, item, 'decision', 'done', step.detail);
      if (judged) await noteScopeOutcome(item, watch, judged);
      return;
    }
    if (step.step === 'refused') {
      // Settled for the loop: no replacement session and no re-request. The refusal stands in
      // `master status` until the master answers it with a request that cites it, or acts on it.
      await closeApprover(item, watch, 'its decision is refused');
      watch.settledAt = stamp;
      // A refused widening is the worker's answer, not the master's: the control plane recorded it
      // on the item, and the worker reads there that it stays inside plannedFiles.
      if (watch.scope && judged) { await noteScopeOutcome(item, watch, judged); return; }
      await note(`escalation:decision-refused:${watch.decision}`, item, 'escalation', 'done', `${step.detail}. The loop does not request it again or launch another approver; answer the refusal: read it with graphyard master decisions ${item.key}, then request what the item needs with a reason that cites ${watch.decision} and gives what the refused request lacked, or act on the refusal instead`);
      return;
    }
    // Every other step replaces the session, so the one that ended goes first. While it cannot be
    // closed its name is still taken, and the step is taken again next cycle.
    if (!await closeApprover(item, watch, step.detail) && watch.closeAttempts < maxApproverCloses) return;
    if (watch.ended.at(-1) !== step.detail.slice(0, 300)) watch.ended = [...watch.ended, step.detail.slice(0, 300)].slice(-10);
    if (step.step === 'rerequest') {
      // The server settled it some other way — failed on a precondition, stale, withdrawn — and
      // the item still needs the decision, so it is asked again: a bounded number of times, and on
      // the same widening interval as any refused action. The watch stays until a new request
      // replaces it, so the bound survives a request that is itself refused.
      if (watch.requests >= maxDecisionRequests) { if (!watch.exhaustedAt) await escalateUnjudged(item, watch, step.detail); return; }
      if (state.actions[key]?.state === 'failed' && !readyToRetry(state.actions[key], state.cycle)) return;
      if (!state.actions[`${base}:ended`]) await note(`${base}:ended`, item, 'decision', 'failed', `${step.detail}; ${item.key} still needs it, so it is requested again`);
      await request(item, decision, key, watch);
      return;
    }
    if (step.step === 'exhausted') { await escalateUnjudged(item, watch, step.detail); return; }
    try { await note(`${base}:launch:${watch.launches + 1}`, item, 'decision', 'done', `${step.detail}; ${await launch(item, watch, false)}`); }
    catch (error) { await note(`${base}:launch:${watch.launches}`, item, 'decision', 'failed', `${step.detail}; a replacement approver session could not be launched: ${message(error)}`); }
  };

  const needed = new Set<string>(), unattestable = new Set<string>();
  const pause = githubPause(snapshot.jobs, clock);
  // A scope request is judged by the review-finding rule (step 2a) before it is the approver's: the
  // findings for this request and policy revision were read and named none of it. A loop that
  // cannot read findings or widen on them has no rule to wait for.
  const findingsJudged = (item: Work) => {
    const request = item.scopeRequest;
    if (!request) return false;
    if (!effects.reviewFindings || !effects.widenScope) return true;
    const judged = state.actions[`${scopeKey(item, request)}:finding:${item.policyRevision}`];
    return judged?.state === 'done' && !/^Widened /.test(judged.detail);
  };
  for (const item of snapshot.work) await isolate('decision', item, item.key, async () => {
    const assessment = assessments[item.id];
    // A request step 2 refused this cycle is read as it was decided, not as the snapshot saw it.
    const scoped = settled.get(item.id) ?? item;
    const decision = scopeRoutineDecision(scoped, clock, findingsJudged(scoped)) ?? routineDecision(item, config, clock, assessment);
    if (!decision) {
      // Still called for, only not attestable this cycle: its request is not one the item moved past.
      const called = neededDecision(item, config);
      if (called) unattestable.add(decisionKey(item, called));
      // The item needs the decision and the loop will not attest what it could not verify. Step 3b
      // has already escalated an open item whose fence this host assessed and could not settle.
      const withheld = withheldDecision(item, config, clock, assessment);
      const escalationKey = `escalation:decision-withheld:${item.id}:${item.containmentQuarantine?.epoch ?? item.epoch}`;
      const detail = withheld ? `${withheld.reason}. Stop the supervisor on its registered host and settle the fence there (graphyard master settle-containment ${item.key}), or request the decision yourself on an attestation you verified` : '';
      if (withheld && !(item.stage !== 'done' && assessment) && detailChanged(state.actions[escalationKey], detail)) await note(escalationKey, item, 'escalation', 'done', detail);
      return;
    }
    const key = decisionKey(item, decision);
    needed.add(key);
    const watch = state.approvals[key];
    // Rework waits for an observation that still describes the item (GY-144). A request already
    // standing is left as it is — neither supervised into a second request nor withdrawn — until
    // GitHub is observed again and the item says whether it still needs the round.
    const wait = decision.action === 'rework' ? reworkObservationWait(item, clock, pause) : null;
    if (wait) {
      const waitKey = `wait:rework:${item.id}`;
      if (detailChanged(state.actions[waitKey], wait)) await note(waitKey, item, 'decision', 'done', wait);
      return;
    }
    if (watch) { if (!watch.settledAt) await supervise(item, decision, key, watch); return; }
    const previous = state.actions[key];
    // A `done` entry with no watch is a cursor written before requests were supervised; the
    // request path adopts the decision it left standing and launches an approver for it.
    if (previous?.state === 'failed' && !readyToRetry(previous, state.cycle)) return;
    if (!effects.decide || !effects.approver) {
      const escalationKey = `escalation:decision:${item.id}:${decision.binding}`;
      const detail = `${item.key} needs a ${decision.action} decision: ${decision.reason} This loop runs without the decision effects, so it cannot request one: graphyard master decide ${item.key} ${decision.action} REASON, then graphyard master approver ${item.key} DECISION`;
      if (detailChanged(state.actions[escalationKey], detail)) performed.push(await record(state, escalationKey, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail, attempts: (state.actions[escalationKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      return;
    }
    await request(item, decision, key, null);
  });
  // A watch whose item no longer needs its decision — applied and moved on, or overtaken by a new
  // head — has nothing left to judge. Its session is closed rather than left holding a provider
  // seat, and the watch goes with it; one Herdr cannot be read for stays until it can.
  for (const [key, watch] of Object.entries(state.approvals)) await isolate('decision', snapshot.work.find(candidate => candidate.key === watch.work) ?? null, watch.work, async () => {
    if (needed.has(key)) return;
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
        watch.settledAt = stamp; await noteScopeOutcome(item, watch, judged);
      }
    }
    // Another current watch holds this decision: the request is not moved past, only re-keyed.
    if (Object.entries(state.approvals).some(([other, entry]) => other !== key && needed.has(other) && entry.decision === watch.decision)) { delete state.approvals[key]; return; }
    if (item && !watch.settledAt && !unattestable.has(key) && effects.withdraw && effects.decisions) {
      try {
        const standing = (await effects.decisions(item)).decisions.find(entry => entry.id === watch.decision);
        if (standing?.state === 'requested') {
          await effects.withdraw(item, watch.decision, `${watch.work} moved past the ${watch.action} this decision asked for before any approver judged it, so its reason no longer describes the item`);
          await note(`approver:${watch.decision}:withdrawn`, item, 'decision', 'done', `Withdrew ${watch.action} decision ${watch.decision}: ${watch.work} no longer needs it and no approver had judged it`);
        }
      } catch (error) {
        withdrawn = false; watch.closeAttempts += 1;
        await note(`approver:${watch.decision}:withdrawn`, item, 'decision', 'failed', `Could not withdraw ${watch.action} decision ${watch.decision}, which ${watch.work} no longer needs: ${message(error)}`);
      }
    }
    const closed = !item || await closeApprover(item, watch, `${watch.work} no longer needs ${watch.action} decision ${watch.decision}`);
    // A tab that will not close, or a request that cannot be taken back, is left to the operator
    // after a few tries; the session name is this decision's alone, so it can refuse no other launch.
    if ((closed && withdrawn) || watch.closeAttempts >= maxApproverCloses) delete state.approvals[key];
  });
}
