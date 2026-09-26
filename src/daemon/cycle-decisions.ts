// Concern: cycle step 4c — request and supervise the routine decisions and their approver sessions.
import { decisionSituation, uncitedRefusals } from '../model/approval.js';
import type { Work } from '../model.js';
import { type ContainmentAssessment, type HerdrAgent, type RoleCapacity, approverProfile, ownLoginAccounts, approverSessionId, approverSessionName, approvedMerge, decisionInput } from '../master.js';
import { type ApprovalWatch, approvalWatchSchema, carriedSession, type DaemonActionKind, latencySampleSchema, message, scopeMeasurementSchema } from './state.js';
import { decisionKey, scopeAnsweredAt, scopeKey, scopeOutcomeAnswered } from './reconcile.js';
import { readyToRetry } from './sessions.js';
import { approvalStep, boundDetail, decisionReasonMax, detailChanged, fitDecisionReason, githubPause, maxApproverCloses, maxRefusalAnswers, maxApproverLaunches, maxDecisionRequests, namePaths, neededDecision, observedFrom, resolveCovers, reworkDecisionReason, refusalNamedIn, reworkObservationWait, routineDecision, type RoutineDecision, sameAnswers, scopeRoutineDecision, standingVerdict, withheldDecision } from './decisions.js';
import { type DaemonEffects, failoverKey, record, stoppedStates } from './effects.js';
import { detectExhaustion } from '../model/capacity.js';
import { capacityRefusal } from '../fleet.js';
import { sessionName } from '../session-name.js';
import type { Cycle } from './cycle.js';

/** The approval-watch key of an approver session no request of the loop's launched (GY-403). */
export const handWatchPrefix = 'hand:';
/** The name prefixes every approver session for `key` starts with (see `approverSessionName`). */
const approverPrefixes = (key: string) => ['graphyard-approver', 'gy-approver'].map(prefix => `${sessionName(prefix, key)}-`);

/** Step 4c: request and supervise the routine decisions. */
export async function decisionStep(cycle: Cycle, settled: Map<string, Work>, assessments: Record<string, ContainmentAssessment>, { capacities, approversSpent }: { capacities: RoleCapacity[]; approversSpent: boolean }) {
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
  /**
   * End the agent registry session a watch's launch holds (GY-182). At a role concurrency of 1 a
   * live one refuses the next decision's approver, so it goes wherever the approver is closed or
   * replaced, not only on failover. False only when the registry could not be told; it is kept and
   * ended on the next try, which the registry answers the same way when it is already ended.
   */
  const endApproverSession = async (item: Work, watch: ApprovalWatch, why: string) => {
    if (!watch.session || !effects.endRegistrySession) return true;
    try { await effects.endRegistrySession(watch.session, why.slice(0, 500)); watch.session = null; return true; }
    catch (error) { await note(`close:approver-session:${watch.decision}:${watch.session}`, item, 'close', 'failed', `Could not end approver registry session ${watch.session}: ${message(error)}`); return false; }
  };
  /**
   * Close the approver session a watch names, if Herdr still lists it, and end its registry
   * session first. False only when either could not be done.
   */
  const closeApprover = async (item: Work, watch: ApprovalWatch, why: string) => {
    if (!await endApproverSession(item, watch, why)) { watch.closeAttempts += 1; return false; }
    const session = watch.agentName ? (await sessions()).agents.find(agent => agent.name === watch.agentName) : undefined;
    if (!session?.pane_id) return true;
    const key = `close:approver:${watch.decision}:${session.pane_id}`;
    try {
      await effects.closeSession(session.pane_id); inventory = null;
      // Its launcher closed it, so the record ends now with why, rather than waiting for the
      // session report to find the pane gone (GY-172).
      const handle = (item.sessions ?? []).find(entry => entry.id === approverSessionId(watch.decision) && entry.state === 'running');
      if (handle) await effects.recordSession?.(item, { id: handle.id, kind: handle.kind, runtime: handle.runtime, host: handle.host, subject: handle.subject, state: 'finished', outcome: `closed by the loop: ${why}`.slice(0, 500) }).catch(() => { /* the report closes it once the pane is gone */ });
      await note(key, item, 'close', 'done', `Closed approver session ${watch.agentName} (${session.agent_status ?? 'unknown'}): ${why}`); return true;
    }
    catch (error) { inventory = null; watch.closeAttempts += 1; await note(key, item, 'close', 'failed', `Could not close approver session ${watch.agentName}: ${message(error)}`); return false; }
  };
  /**
   * Keep how a watch's session ended, named by its launch so two sessions that ended alike under
   * the same name stay two reasons (GY-551). The same step taken again on the same session — a
   * close or re-request retried next cycle — records nothing new.
   */
  const recordEnded = (watch: ApprovalWatch, detail: string) => {
    const entry = `${watch.agentName ? `session ${watch.launches}: ` : ''}${detail}`.slice(0, 300);
    if (watch.ended.at(-1) !== entry) watch.ended = [...watch.ended, entry].slice(-10);
  };
  const approverCapacity = capacities.find(capacity => capacity.role === 'approver');
  const capacityWait = () => `every approver account is spent, so no approver is launched before ${approverCapacity?.retryAt ?? 'an account reports quota again'}`;
  /**
   * Put a watched decision to an approver session. The launch is counted before it is made; one
   * refused because every account is spent is no launch at all (GY-182), and is not counted.
   */
  const launch = async (item: Work, watch: ApprovalWatch, adopt: boolean) => {
    const name = approverSessionName(item, watch.decision), seen = await sessions();
    // A session a master started for the same decision (`master approver`) is the approver it has.
    const listed = adopt && seen.available ? seen.agents.find(agent => agent.name === name) : undefined;
    if (!listed && approversSpent) { Object.assign(watch, { agentName: null, pane: null }); return `the decision waits: ${capacityWait()}`; }
    // An adopted session keeps the account its launch chose: that is the account it spends.
    const adopted = listed ? await effects.approverLaunch?.(name).catch(() => null) ?? null : null;
    // A session the watch still holds past its close attempts is ended before the watch forgets it.
    // While the registry cannot be told, its id stays on the watch and no replacement is launched:
    // at a role concurrency of 1 the live slot would refuse it, and the id is the only way to end it.
    if (watch.session && !listed && !await endApproverSession(item, watch, `approver for ${watch.work} decision ${watch.decision} replaced`))
      throw new Error(`registry session ${watch.session} of the replaced approver could not be ended, so no replacement is launched while it holds the role's slot; ending it is tried again next cycle`);
    Object.assign(watch, { launches: watch.launches + 1, agentName: name, pane: listed?.pane_id ?? null, launchedAt: stamp, account: adopted?.account ?? null, runtime: adopted?.runtime ?? null, session: adopted?.session ?? null });
    await effects.persist(state);
    if (listed) return `adopted approver session ${name}${adopted?.account ? ` on ${adopted.account}` : ''}, already judging it`;
    inventory = null;
    let launched: Awaited<ReturnType<NonNullable<DaemonEffects['approver']>>>;
    try { launched = await effects.approver!(item, watch.decision); }
    catch (error) {
      if ((error as { capacityExhausted?: boolean })?.capacityExhausted) { Object.assign(watch, { launches: watch.launches - 1, agentName: null, pane: null, account: null, runtime: null, session: null }); return `the decision waits for approver capacity: ${message(error)}`; }
      // A role at its concurrency limit is a wait for a slot, not a failed session (GY-190): the
      // launch is not counted against the decision's bound, and the next cycle makes it again, so
      // the approver starts on the first cycle after a slot frees without anybody asking.
      const full = capacityRefusal(error);
      if (!full) {
        // A registry session the failed launch could not end stays on the watch, so the next launch ends it first.
        // The launch made no session, so it is taken back like a capacity refusal (GY-551): a
        // registry or server timeout is retried next cycle within the bound, never spends it, and
        // the escalation past the bound counts only the sessions that ran.
        const orphan = (error as { registrySession?: string })?.registrySession;
        Object.assign(watch, { launches: watch.launches - 1, agentName: null, pane: null, launchedAt: null, account: null, runtime: null, session: orphan ?? null });
        await effects.persist(state);
        throw error;
      }
      Object.assign(watch, { launches: watch.launches - 1, agentName: null, pane: null, launchedAt: null, account: null, runtime: null, session: null, capacity: full.slice(0, 500) });
      await effects.persist(state);
      return `left it pending for an approver slot, launched on the first cycle one frees: ${full}`;
    }
    Object.assign(watch, { agentName: launched?.agentName ?? name, pane: launched?.pane ?? null, account: launched?.account ?? null, runtime: launched?.runtime ?? null, session: launched?.session ?? null, capacity: null, run: launched?.run ?? null });
    // A headless approver (GY-169) reports its run when it ends; the watch keeps it, and the next
    // cycle reads the verdict it applied back from the control plane like any other.
    launched?.settled?.then(async record => { if (watch.agentName === launched.agentName) { watch.run = record; await effects.persist(state); } }).catch(() => { /* the next cycle judges the decision itself */ });
    return `launched independent approver session ${watch.agentName}${watch.account ? ` on ${watch.account}` : ''} (launch ${watch.launches} of ${maxApproverLaunches})`;
  };
  /**
   * An approver that stopped on its provider's limit notice (GY-182) has judged nothing and never
   * will: its account is held until the reset the notice names, the exhaustion is recorded against
   * the decision, the session is closed, and the same decision goes to the next eligible account
   * in the same cycle. The launch it spent is not counted against the decision's bound.
   */
  const approverExhausted = async (item: Work, watch: ApprovalWatch) => {
    if (!effects.sessionOutput || !effects.reportCapacity || !watch.agentName) return false;
    const agent = (await sessions()).agents.find(candidate => candidate.name === watch.agentName);
    if (!agent || !stoppedStates.includes(agent.agent_status ?? '')) return false;
    const signal = await Promise.resolve(effects.sessionOutput(agent)).then(output => output ? detectExhaustion(output, clock) : null, () => null);
    if (!signal) return false;
    const session = `${watch.decision}:${watch.launchedAt ?? watch.launches}`;
    const key = failoverKey('approver', item, session), previous = state.actions[key];
    if (previous?.state === 'done' || !readyToRetry(previous, state.cycle)) return true;
    const attempts = (previous?.attempts ?? 0) + 1, resets = signal.resetsAt ? `resets ${signal.resetsAt}` : 'reset time unknown';
    const account = watch.account, spentOn = account ?? 'its runtime\'s own account';
    try {
      // The hold and the capacity record are written once per spent session (GY-316): a retried
      // failover — a session that could not be closed, a replacement that failed to launch —
      // writes neither again, so one spent session leaves one exhaustion record.
      if (watch.reportedExhaustion !== session) {
        // An approver on no named account spent its runtime's own login, which an escalation handler launches on too.
        for (const name of account ? [account] : ownLoginAccounts({ name: approverProfile, kind: watch.runtime ?? undefined })) await effects.holdAccount?.(name, { at: new Date(clock).toISOString(), resetsAt: signal.resetsAt, reason: signal.reason, role: 'approver', profile: approverProfile, work: item.key });
        await effects.reportCapacity(item, { event: 'exhausted', role: 'approver', requestId: watch.decision.slice(0, 64), profile: approverProfile, account, runtime: watch.runtime, reason: signal.reason, resetsAt: signal.resetsAt,
          partialWork: { state: 'not-applicable', detail: 'an approver session edits nothing: it judges a decision and leaves no work to keep' } });
        watch.reportedExhaustion = session;
        await effects.persist(state);
      }
      const ended = `approver session ${watch.agentName} exhausted ${spentOn} mid-session (${signal.reason}; ${resets})`;
      // The registry slot goes first (closeApprover ends it): at a role concurrency of 1 the replacement is refused while it is held.
      if (!await closeApprover(item, watch, ended)) throw new Error(`the session could not be closed, so its name or registry slot still refuses a replacement`);
      recordEnded(watch, ended);
      Object.assign(watch, { launches: Math.max(0, watch.launches - 1), agentName: null, pane: null });
      const next = await launch(item, watch, false);
      performed.push(await record(state, key, { kind: 'failover', work: item.key, principal: null, state: 'done', detail: `${ended} judging ${watch.action} decision ${watch.decision}; ${next}`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      performed.push(await record(state, key, { kind: 'failover', work: item.key, principal: null, state: 'failed', detail: `approver session ${watch.agentName ?? '(closed)'} for ${item.key} exhausted ${spentOn} (${signal.reason}) but could not be failed over: ${message(error)}`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
    }
    return true;
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
      // refusals the item gathers, the citation stays the newest one or few (GY-163). A refusal
      // stands only against the candidate and base it judged (GY-229): one refused for an earlier
      // candidate is not this request's to answer, so only this candidate's refusals are cited.
      // A recover request is situated the same way and answers its refusals alike (GY-265).
      const situated = decision.action === 'rework' || decision.action === 'recover' ? decision.action : null;
      const prefix = decision.action === 'rework' ? `${observedFrom(item)} ` : '';
      let refused = situated ? uncitedRefusals(history.map(entry => ({ ...entry, reason: entry.reason ?? '' })), situated, decisionInput(situated, item, {}), (a, b) => JSON.stringify(a) === JSON.stringify(b), decisionSituation(situated, item)) : [];
      let reason = situated ? reworkDecisionReason(prefix, decision.reason, refused, situated) : fitDecisionReason('', decision.reason, '');
      if (reason === null) {
        // Retrying would be refused every time; the request is not sent, and the master is told once.
        const escalation = `escalation:${situated}-refusals:${item.key}:${refused.length}`;
        performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'failed', detail: `Did not request the ${situated} decision for ${item.key}: its ${refused.length} uncited refused ${situated} decisions no longer fit, cited, within the reason bound`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
        if (!state.actions[escalation]) await note(escalation, item, 'escalation', 'failed', `${item.key} has ${refused.length} refused ${situated} decisions that no later refused request cited, and a ${situated} request must cite each by id within the ${decisionReasonMax}-character reason bound; they no longer fit beside its grounds (${decision.reason.slice(0, 300)}), so the loop has stopped requesting it: read them with graphyard master decisions ${item.key}, then request it with graphyard master decide ${item.key} ${situated} --precedent ID[,ID] REASON citing them, or act on the item yourself`);
        return;
      }
      // The history the loop read can miss a refusal the server holds (the read failed, or a refusal
      // landed since). The server's answer names it, and this candidate's refusal is the loop's to
      // answer on its new grounds: the request is made again citing it, a bounded number of times,
      // rather than failing on every cycle with nobody told why (GY-229).
      let requested: { id: string } | undefined = standing;
      for (let answers = 0; !requested; answers++) {
        try { requested = await effects.decide!(item, decision.action, reason, decision.input); }
        catch (error) {
          const named = situated && answers < maxRefusalAnswers ? refusalNamedIn(error, situated) : null;
          const cited = named && situated && !refused.includes(named) ? reworkDecisionReason(prefix, decision.reason, [...refused, named], situated) : null;
          if (!named || cited === null) throw error;
          refused = [...refused, named];
          reason = cited;
        }
      }
      // A standing request another watch holds is the same decision under a binding that has since
      // changed (a rework's unresolved-thread set moved while it was requested). That watch is
      // retired here, its sessions and counts carried over, so the cleanup below does not withdraw
      // the decision this watch just adopted and close its approver — on every cycle the set moves.
      const [retired, prior] = standing ? Object.entries(state.approvals).find(([other, entry]) => other !== key && entry.decision === requested.id && !entry.settledAt) ?? [] : [];
      if (retired) delete state.approvals[retired];
      const kept = prior ? carriedSession(prior) : {};
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
    if ((!judged || judged.state === 'requested') && await approverExhausted(item, watch)) return;
    const step = approvalStep(watch, judged, await sessions(), clock);
    if (step.step === 'wait' || (watch.exhaustedAt && step.step === 'exhausted')) return;
    // A decision whose approver could not be launched for want of capacity is not a session that
    // ended: nothing is closed, counted or recorded until an account resets (GY-182).
    if (step.step === 'relaunch' && !watch.agentName && approversSpent) return;
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
    // A launch waiting for a slot, or refused outright (GY-551), never ran a session, so there is no
    // ending to record: it is only made again.
    if (step.step === 'relaunch' && !watch.agentName) {
      const waited = watch.capacity ? 'waited for an approver slot' : 'had its last approver launch refused';
      try { await note(`${base}:launch:${watch.launches + 1}`, item, 'decision', 'done', `${item.key}'s ${watch.action} decision ${watch.decision} ${waited}; ${await launch(item, watch, false)}`); }
      catch (error) { await note(`${base}:launch:${watch.launches + 1}`, item, 'decision', 'failed', `${item.key}'s ${watch.action} decision ${watch.decision} ${waited}; its approver session could not be launched: ${message(error)}`); }
      return;
    }
    recordEnded(watch, step.detail);
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
    catch (error) { await note(`${base}:launch:${watch.launches + 1}`, item, 'decision', 'failed', `${step.detail}; a replacement approver session could not be launched: ${message(error)}`); }
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
    // A settled watch is supervised no more, but a registry session its close could not end still
    // holds the role's slot: ending it is tried again each cycle until the registry is told.
    if (watch) {
      if (!watch.settledAt) await supervise(item, decision, key, watch);
      else if (watch.session) await endApproverSession(item, watch, `approver for ${watch.work} decision ${watch.decision} settled`);
      return;
    }
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
    // An item no longer open has no pane to close, but its registry session still holds a slot.
    let closed = true;
    if (item) closed = await closeApprover(item, watch, `${watch.work} no longer needs ${watch.action} decision ${watch.decision}`);
    else if (watch.session && effects.endRegistrySession) closed = await effects.endRegistrySession(watch.session, `${watch.work} is no longer open`).then(() => { watch.session = null; return true; }, () => { watch.closeAttempts += 1; return false; });
    // A tab that will not close, or a request that cannot be taken back, is left to the operator
    // after a few tries; the session name is this decision's alone, so it can refuse no other launch.
    // A registry session is not: its id is the only way to end it, and while it lives it holds the
    // role's slot, so the watch stays, past any bound, until the registry is told.
    if ((closed && withdrawn) || (watch.closeAttempts >= maxApproverCloses && !watch.session)) delete state.approvals[key];
  });

  // 4c'. Approver sessions no request of the loop's launched (GY-403). `master approver` records the
  //      item and decision with its launch, and the loop registers such a session in its approval
  //      watch; one with no record is known by its name, which `approverSessionName` derives from the
  //      item and decision. Either way the session is supervised exactly as the loop's own approvers
  //      are (GY-551): closed, with why, once its decision is applied, refused or otherwise settled,
  //      or its item is delivered, and relaunched while the decision stands open and it ends without
  //      judging it — on the next eligible approver account, up to the same launch bound, a relaunch
  //      the registry or control plane refused retried on the next cycle. One the loop still needs
  //      is adopted by the request path, which retires this watch.
  await isolate('decision', null, 'hand-approvers', async () => {
    const seen = await sessions();
    if (!seen.available) return;
    const records = await effects.approverLaunches?.().catch(() => []) ?? [];
    const watched = Object.values(state.approvals);
    for (const agent of seen.agents) {
      if (!agent.name || !agent.pane_id || watched.some(watch => watch.agentName === agent.name)) continue;
      const record = records.findLast(entry => entry.agentName === agent.name && entry.work && entry.decision);
      const item = snapshot.work.find(candidate => record ? candidate.key === record.work : approverPrefixes(candidate.key).some(prefix => agent.name!.startsWith(prefix)));
      if (!item) continue;
      let decision = record?.decision ?? null;
      if (!decision) {
        const history = effects.decisions ? await effects.decisions(item).then(result => result.decisions, () => null) : null;
        decision = history?.find(entry => approverSessionName(item, entry.id) === agent.name)?.id ?? null;
        // A delivered item's approver is closed whatever it judges; it is named for its session.
        if (!decision && item.stage === 'done') decision = agent.name;
      }
      // Another watch holds this decision: the loop's own supervision decides its approver.
      if (!decision || watched.some(watch => watch.decision === decision)) continue;
      const watch = state.approvals[`${handWatchPrefix}${decision}`] = approvalWatchSchema.parse({ work: item.key, action: 'unknown', decision, requestedAt: stamp, agentName: agent.name, pane: agent.pane_id,
        launchedAt: record?.launchedAt ?? null, launches: 1, account: record?.account ?? null, runtime: record?.runtime ?? null, session: record?.session ?? null });
      watched.push(watch);
      await note(`approver:${decision}:watched`, item, 'decision', 'done', `Watching approver session ${agent.name}, which no request of the loop's launched, for ${item.key} decision ${decision}${record ? ' (launched with graphyard master approver)' : ''}`);
    }
    // A `master approver` session that ended before any cycle listed it is known by its launch
    // record alone (GY-551): while its decision still waits for a judgement it is watched as gone,
    // so supervision relaunches it like one seen to end. Without the approver effect nothing could
    // relaunch it, and the watch would only be closed and found again every cycle.
    if (effects.approver) for (const record of records) {
      if (!record.work || !record.decision || seen.agents.some(agent => agent.name === record.agentName) || watched.some(watch => watch.decision === record.decision || watch.agentName === record.agentName)) continue;
      const item = snapshot.work.find(candidate => candidate.key === record.work);
      if (!item || item.stage === 'done' || !effects.decisions) continue;
      const judged = await effects.decisions(item).then(result => result.decisions.find(entry => entry.id === record.decision) ?? null, () => null);
      if (judged?.state !== 'requested') continue;
      const watch = state.approvals[`${handWatchPrefix}${record.decision}`] = approvalWatchSchema.parse({ work: item.key, action: judged.action, decision: record.decision, requestedAt: stamp, agentName: record.agentName,
        launchedAt: record.launchedAt, launches: 1, account: record.account, runtime: record.runtime, session: record.session });
      watched.push(watch);
      await note(`approver:${record.decision}:watched`, item, 'decision', 'done', `Watching approver session ${record.agentName}, launched with graphyard master approver for ${item.key} decision ${record.decision} and gone before the loop saw it`);
    }
    await effects.persist(state);
    for (const [key, watch] of Object.entries(state.approvals)) {
      if (!key.startsWith(handWatchPrefix)) continue;
      const item = snapshot.work.find(candidate => candidate.key === watch.work);
      const listed = seen.agents.some(agent => agent.name === watch.agentName);
      let why: string | null = null, judged: { state: string; action: string } | null | undefined;
      if (!item) why = `${watch.work} is no longer open`;
      else if (item.stage === 'done') why = `${item.key} is delivered`;
      else if (effects.decisions) {
        judged = await effects.decisions(item).then(result => result.decisions.find(entry => entry.id === watch.decision) ?? null, () => undefined);
        if (judged === null) why = `${item.key} holds no decision ${watch.decision}`;
        else if (judged && !['requested', 'approved'].includes(judged.state)) why = `its decision is ${judged.state}`;
        if (judged) watch.action = judged.action;
      }
      // GY-551. A decision still open whose approver ended without judging it is moved on exactly
      // as the loop's own are: a replacement is launched on the next eligible approver account
      // within the same launch bound, a relaunch the registry or control plane refused is retried
      // next cycle rather than ending the decision, and past the bound the watch is kept, with
      // each session's end reason, for `master status` to name the decision unanswered. Without
      // the approver effect there is nothing to launch with, so only the close below runs.
      if (item && !why && effects.approver) {
        // Spent: the watch stays, with each session's end reason for `master status`, until the
        // decision settles or the item closes; no further session is launched for it. The
        // escalation's answer — `master approver` again — starts a session under the same name,
        // which the registration above cannot tell apart from this watch, so a session listed
        // under it that was launched after the escalation (the one it ended was closed first)
        // re-arms the watch as a fresh hand launch: supervised, closed and relaunched within the
        // bound like the first, rather than left to linger if it too ends without judging.
        if (watch.exhaustedAt) {
          const agent = seen.agents.find(candidate => candidate.name === watch.agentName);
          if (!agent?.pane_id) continue;
          const fresh = records.findLast(entry => entry.agentName === watch.agentName);
          if (fresh ? !(Date.parse(fresh.launchedAt) > Date.parse(watch.exhaustedAt)) : watch.closeAttempts >= maxApproverCloses) continue;
          Object.assign(watch, { exhaustedAt: null, launches: 1, closeAttempts: 0, pane: agent.pane_id, launchedAt: fresh?.launchedAt ?? stamp, account: fresh?.account ?? null, runtime: fresh?.runtime ?? null, session: fresh?.session ?? watch.session, capacity: null, reportedExhaustion: null });
          await note(`approver:${watch.decision}:rewatched:${watch.launchedAt}`, item, 'decision', 'done', `Watching approver session ${agent.name}, put to ${item.key} decision ${watch.decision} again after its earlier sessions were spent`);
        }
        if ((!judged || judged.state === 'requested') && await approverExhausted(item, watch)) continue;
        const step = approvalStep({ ...watch, launchedAt: watch.launchedAt ?? watch.requestedAt }, judged, seen, clock);
        if (step.step === 'wait') continue;
        if (step.step === 'relaunch' && !watch.agentName && approversSpent) continue;
        const base = `approver:${watch.decision}`;
        // While the ended session cannot be put down, its name or registry slot still refuses a
        // replacement, so the step is taken again next cycle.
        if (!await closeApprover(item, watch, step.detail) && watch.closeAttempts < maxApproverCloses) continue;
        // A launch that waited for a slot or was refused ran no session: it is only made again.
        if (step.step === 'relaunch' && !watch.agentName) {
          const waited = watch.capacity ? 'waited for an approver slot' : 'had its last approver launch refused';
          try { await note(`${base}:launch:${watch.launches + 1}`, item, 'decision', 'done', `${watch.work}'s ${watch.action} decision ${watch.decision} ${waited}; ${await launch(item, watch, false)}`); }
          catch (error) { await note(`${base}:launch:${watch.launches + 1}`, item, 'decision', 'failed', `${watch.work}'s ${watch.action} decision ${watch.decision} ${waited}; its approver session could not be launched: ${message(error)}`); }
          continue;
        }
        recordEnded(watch, step.detail);
        if (step.step === 'exhausted') { await escalateUnjudged(item, watch, step.detail); continue; }
        try { await note(`${base}:launch:${watch.launches + 1}`, item, 'decision', 'done', `${step.detail}; ${await launch(item, watch, false)}`); }
        catch (error) { await note(`${base}:launch:${watch.launches + 1}`, item, 'decision', 'failed', `${step.detail}; a replacement approver session could not be launched: ${message(error)}`); }
        continue;
      }
      if (listed && !why) continue;
      // A session gone on its own has no pane to close, only a registry session to end.
      if (!item) {
        if (watch.session && effects.endRegistrySession) await effects.endRegistrySession(watch.session, why!).then(() => { watch.session = null; }, () => { watch.closeAttempts += 1; });
        if (!watch.session || !effects.endRegistrySession) delete state.approvals[key];
        continue;
      }
      if (!listed) why ??= `approver session ${watch.agentName} is gone`;
      if (await closeApprover(item, watch, why!) || (watch.closeAttempts >= maxApproverCloses && !watch.session)) delete state.approvals[key];
    }
    await effects.persist(state);
  });

  // 4d. Registry sessions end with the sessions they record (GY-190). A registry session is a
  //     launch, not a process, and nothing reports its end: an approver that judged its decision and
  //     exited kept its role's slot, and after `concurrency` launches the role stopped launching.
  //     Each cycle therefore ends every live registry session whose runtime session is gone from
  //     Herdr, every session of an approver whose decision is judged, and every reviewer or
  //     producer session whose ledger record has settled (GY-205), naming why; a launch
  //     step 4c left waiting for a slot is made on the next cycle, into the room this frees.
  if (effects.reconcileSessions) await isolate('decision', null, 'agent-registry', async () => {
    const finished = new Map<string, string>();
    for (const watch of Object.values(state.approvals)) if (watch.session && watch.settledAt) finished.set(watch.session, `approver decision ${watch.decision} on ${watch.work} is judged`);
    const ended = await effects.reconcileSessions!(await sessions(), finished);
    for (const watch of Object.values(state.approvals)) if (watch.session && ended.some(entry => entry.session === watch.session)) watch.session = null;
    for (const entry of ended) performed.push(await record(state, `registry:end:${entry.session}`, { kind: 'close', work: entry.work, principal: null, state: 'done',
      detail: `Ended the ${entry.role} registry session ${entry.session} on ${entry.account}${entry.work ? ` for ${entry.work}` : ''}: ${entry.reason}`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
  });
}
