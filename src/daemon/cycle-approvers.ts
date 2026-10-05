// Concern: approver sessions — launch, supervise, fail over, close and record how they ended, for the loop's own and hand-launched approvers.
import type { Work } from '../model.js';
import { approverRuntime } from '../master/autonomy.js';
import { type HerdrAgent, type RoleCapacity, approverProfile, ownLoginAccounts, approverSessionId, approverSessionName } from '../master.js';
import { type ApprovalWatch, approvalWatchSchema, type DaemonActionKind, message } from './state.js';
import { readyToRetry } from './sessions.js';
import { approvalStep, type ApprovalStep, approverLaunchKey, approverPrefixes, handWatchPrefix, maxApproverCloses, maxApproverLaunches, maxLostApproverRuns, lostRunRefunded, recordWatchEnded } from './decisions.js';
import { type DaemonEffects, failoverKey, record, stoppedStates } from './effects.js';
import { capacityRefusal } from '../fleet.js';
import type { Cycle } from './cycle.js';
import { sessionExhaustion } from './cycle-sessions.js';

/**
 * The approver sessions step 4c puts its decisions to (GY-1147 moved them here from
 * cycle-decisions.ts unchanged): their launch, supervision, failover and close, the approvers no
 * request of the loop's launched (4c'), and the registry sessions that end with them (4d).
 */
export function createApproverSupervisor(cycle: Cycle, effects: DaemonEffects, stamp: string,
  note: (key: string, item: Work, kind: DaemonActionKind, outcome: 'done' | 'failed', detail: string, at?: number) => Promise<unknown>,
  capacities: RoleCapacity[], approversSpent: boolean) {
  const { config, state, now, snapshot, clock, performed, isolate } = cycle;
  // One Herdr read serves the step, and is taken again after anything that changes the inventory.
  let inventory: { agents: HerdrAgent[]; available: boolean } | null = null;
  const sessions = async () => inventory ??= await effects.herdr?.() ?? { agents: await effects.agents(), available: true };
  const invalidate = () => { inventory = null; };
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
      await effects.closeSession(session.pane_id); invalidate();
      // Its launcher closed it, so the record ends now with why, rather than waiting for the
      // session report to find the pane gone (GY-172).
      const handle = (item.sessions ?? []).find(entry => entry.id === approverSessionId(watch.decision) && entry.state === 'running');
      if (handle) await effects.recordSession?.(item, { id: handle.id, kind: handle.kind, runtime: handle.runtime, host: handle.host, subject: handle.subject, state: 'finished', outcome: `closed by the loop: ${why}`.slice(0, 500) }).catch(() => { /* the report closes it once the pane is gone */ });
      await note(key, item, 'close', 'done', `Closed approver session ${watch.agentName} (${session.agent_status ?? 'unknown'}): ${why}`); return true;
    }
    catch (error) { invalidate(); watch.closeAttempts += 1; await note(key, item, 'close', 'failed', `Could not close approver session ${watch.agentName}: ${message(error)}`); return false; }
  };
  const approverCapacity = capacities.find(capacity => capacity.role === 'approver');
  const capacityWait = () => `every approver account is spent, so no approver is launched before ${approverCapacity?.retryAt ?? 'an account reports quota again'}`;
  /**
   * GY-849: whether another capacity-waiting decision's relaunch is still queued or running on the
   * launcher, and whether one was handed off already this cycle. The launcher runs session launches
   * beside the cycle (GY-616), so two handed off in one cycle could race for the one freed slot or
   * account and let the newer decision take it — and one that settles mid-cycle clears its wait
   * before the item after it is reached. Holding each capacity-waiting relaunch until the previous
   * waiter's settles keeps the oldest waiting decision first in line, whatever the timing.
   */
  let capacityRelaunchHanded = false;
  const capacityRelaunchInFlight = (decision: string) =>
    Object.values(state.approvals).some(other => other.capacity && !other.settledAt && other.decision !== decision
      && cycle.launcher.busy(approverLaunchKey(other.decision)));
  const capacityRelaunchWaits = (watch: ApprovalWatch) =>
    !!watch.capacity && (capacityRelaunchHanded || capacityRelaunchInFlight(watch.decision));
  /**
   * Put a watched decision to an approver session. The launch is counted before it is made; one
   * refused because every account is spent is no launch at all (GY-182), and is not counted.
   */
  const launch = async (item: Work, watch: ApprovalWatch, adopt: boolean) => {
    const name = approverSessionName(item, watch.decision), seen = await sessions();
    // A session a master started for the same decision (`master approver`) is the approver it has.
    const listed = adopt && seen.available ? seen.agents.find(agent => agent.name === name) : undefined;
    if (!listed && approversSpent) {
      // GY-849: a request that lands while every account is spent is a capacity wait like a refused
      // launch. It is marked and persisted here, so the decision joins the oldest-first relaunch
      // queue and its relaunch runs through the one-at-a-time guard, instead of staying unmarked
      // and racing a marked older waiter for the first account that frees.
      Object.assign(watch, { agentName: null, pane: null, capacity: capacityWait().slice(0, 500) });
      await effects.persist(state);
      return `the decision waits: ${capacityWait()}`;
    }
    // An adopted session keeps the account its launch chose: that is the account it spends.
    const adopted = listed ? await effects.approverLaunch?.(name).catch(() => null) ?? null : null;
    // A session the watch still holds past its close attempts is ended before the watch forgets it.
    // While the registry cannot be told, its id stays on the watch and no replacement is launched:
    // at a role concurrency of 1 the live slot would refuse it, and the id is the only way to end it.
    if (watch.session && !listed && !await endApproverSession(item, watch, `approver for ${watch.work} decision ${watch.decision} replaced`))
      throw new Error(`registry session ${watch.session} of the replaced approver could not be ended, so no replacement is launched while it holds the role's slot; ending it is tried again next cycle`);
    // GY-924: the hold for an older decision's capacity-waiting relaunch is taken here, before the
    // launch is counted and handed off, not inside the launcher slot: the launcher counts a body as
    // running for its whole duration, so approver launches that waited in `start` while an older
    // capacity relaunch was slow or hung filled the shared pool and left worker dispatches and
    // session failovers queued for up to the stand-down. Held like a capacity wait (GY-182): nothing
    // ran, so no launch is counted, the watch joins the oldest-first queue (GY-849), and the
    // guarded relaunch path makes it once the launcher is clear. A cycle that settles its launches
    // within itself has no shared pool; its inline wait in `start` stands.
    if (!listed && cycle.detached && capacityRelaunchInFlight(watch.decision)) {
      Object.assign(watch, { agentName: null, pane: null, capacity: `held behind another decision's capacity-waiting relaunch still on the launcher; its approver is launched once that settles`.slice(0, 500) });
      await effects.persist(state);
      return `held behind another decision's capacity-waiting relaunch on the launcher; its approver is launched once that settles`;
    }
    // A headless approver run that was lost (GY-453: killed from outside, recording no exit) judged
    // nothing, so its launch is given back, up to `maxLostApproverRuns` per decision: past that a
    // lost run spends its launch, so an approver killed over and over still ends in the escalation.
    if (!listed && watch.run?.result?.ok === false && watch.run.result.reason === 'lost') {
      const refunded = lostRunRefunded(watch);
      watch.ended = [...watch.ended, `approver run ${watch.agentName ?? name} was lost${refunded ? '' : `, past the ${maxLostApproverRuns} lost runs given back`}: ${watch.run.result.detail}`.slice(0, 300)].slice(-10);
      Object.assign(watch, refunded ? { launches: Math.max(0, watch.launches - 1), lostRuns: watch.lostRuns + 1, run: null } : { run: null });
    }
    Object.assign(watch, { launches: watch.launches + 1, agentName: name, pane: listed?.pane_id ?? null, launchedAt: stamp, account: adopted?.account ?? null, runtime: adopted?.runtime ?? null, session: adopted?.session ?? null });
    // GY-920: adopting a session that is already judging the decision ends any capacity wait the
    // watch still carried. The wait described a launch that never happened; kept, it would have
    // `master status` report "waiting for approver capacity" beside a live approver.
    if (listed) watch.capacity = null;
    await effects.persist(state);
    if (listed) return `adopted approver session ${name}${adopted?.account ? ` on ${adopted.account}` : ''}, already judging it`;
    invalidate();
    // The launch itself — a pane and a registered session — runs on the launcher beside the cycle
    // (GY-616), so this cycle's merges and closes do not wait on it. The watch is not supervised
    // while it is in flight, and what the launch did is reported on the next cycle. A cycle run on
    // its own, with no loop beside it, launches in place.
    if (!cycle.detached) return start(item, watch);
    const key = approverLaunchKey(watch.decision), count = watch.launches;
    cycle.launch('decision', item, key, [], async sink => {
      const detail = await start(item, watch);
      sink.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: `${item.key}'s ${watch.action} decision ${watch.decision}: ${detail}`, attempts: (state.actions[key]?.attempts ?? 0) + 1, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
    });
    return `handed approver session ${name} to the launcher (launch ${count} of ${maxApproverLaunches})`;
  };
  /** The approver launch the launcher runs, and what it did with the watch. */
  const start = async (item: Work, watch: ApprovalWatch) => {
    // GY-849: the account grab is where oldest-first is won or lost. A cycle that settles its
    // launches within itself runs this body inline beside the step, so it holds here while another
    // decision's capacity-waiting relaunch is still on the launcher and makes its call only once
    // that one has settled: first submitted, first served, whatever the concurrency. The wait is
    // bounded; past it the launch proceeds as it did before, and the next cycle's guarded relaunch
    // path applies. The loop's own launcher never sees that wait (GY-924): it counts a body as
    // running for its whole duration, so a waiting approver once held a shared slot while doing no
    // work, and `launch` holds such launches back before submission instead.
    if (!cycle.detached) {
      const standDownBy = Date.now() + 300_000;
      while (capacityRelaunchInFlight(watch.decision) && Date.now() < standDownBy) await new Promise(resolve => setTimeout(resolve, 50));
    }
    let launched: Awaited<ReturnType<NonNullable<DaemonEffects['approver']>>>;
    try { launched = await effects.approver!(item, watch.decision); }
    catch (error) {
      // A launch no account could take (GY-182) ran no session either: the watch keeps why, persisted
      // now so the wait survives a restart, and `master status` names it as waiting for a slot.
      if ((error as { capacityExhausted?: boolean })?.capacityExhausted) { Object.assign(watch, { launches: watch.launches - 1, agentName: null, pane: null, launchedAt: null, account: null, runtime: null, session: null, capacity: message(error).slice(0, 500) }); await effects.persist(state); return `the decision waits for approver capacity: ${message(error)}`; }
      // A role at its concurrency limit is a wait for a slot, not a failed session (GY-190): the
      // launch is not counted against the decision's bound, and the next cycle makes it again, so
      // the approver starts on the first cycle after a slot frees without anybody asking.
      const full = capacityRefusal(error);
      if (!full) {
        // A registry session the failed launch could not end stays on the watch, so the next launch ends it first.
        // The launch made no session, so it is taken back like a capacity refusal (GY-551): a
        // registry or server timeout is retried next cycle within the bound, never spends it, and
        // the escalation past the bound counts only the sessions that ran. GY-920: a failure for
        // any other reason is not a capacity wait — the stale wait is cleared with the rest of the
        // launch state, so `master status` classifies the watch by this failure and its remedy
        // instead of reporting a wait for capacity that is over.
        const orphan = (error as { registrySession?: string })?.registrySession;
        Object.assign(watch, { launches: watch.launches - 1, agentName: null, pane: null, launchedAt: null, account: null, runtime: null, session: orphan ?? null, capacity: null });
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
    if (!agent) return false;
    // Judged against the approver's own runtime's provider messages: free prose about a quota is
    // not a provider limit notice, whatever it mentions (GY-421). A working approver counts only
    // when its runtime is retrying on the notice (GY-973).
    const signal = await Promise.resolve(effects.sessionOutput(agent)).then(output => output ? sessionExhaustion(output, stoppedStates.includes(agent.agent_status ?? ''), watch.runtime ?? approverRuntime(config), clock) : null, () => null);
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
        // Each write is marked as it lands (GY-489): a report that fails after the hold is retried
        // without holding the account again.
        if (watch.heldExhaustion !== session) {
          // An approver on no named account spent its runtime's own login, which an escalation handler launches on too.
          for (const name of account ? [account] : ownLoginAccounts({ name: approverProfile, kind: watch.runtime ?? undefined })) await effects.holdAccount?.(name, { at: new Date(clock).toISOString(), resetsAt: signal.resetsAt, reason: signal.reason, role: 'approver', profile: approverProfile, work: item.key });
          watch.heldExhaustion = session;
          await effects.persist(state);
        }
        await effects.reportCapacity(item, { event: 'exhausted', role: 'approver', requestId: watch.decision.slice(0, 64), profile: approverProfile, account, runtime: watch.runtime, reason: signal.reason, resetsAt: signal.resetsAt,
          partialWork: { state: 'not-applicable', detail: 'an approver session edits nothing: it judges a decision and leaves no work to keep' } });
        watch.reportedExhaustion = session;
        await effects.persist(state);
      }
      const ended = `approver session ${watch.agentName} exhausted ${spentOn} mid-session (${signal.reason}; ${resets})`;
      // The registry slot goes first (closeApprover ends it): at a role concurrency of 1 the replacement is refused while it is held.
      if (!await closeApprover(item, watch, ended)) throw new Error(`the session could not be closed, so its name or registry slot still refuses a replacement`);
      recordWatchEnded(watch, ended);
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
  /**
   * Act on a supervision step once its early guards have passed: put down the session that ended,
   * then make the replacement, record how this one ended, and escalate a decision no session will
   * judge. Shared by the loop's own watches and the hand watches (GY-779), so the two supervision
   * paths cannot drift apart in how an approver is closed, relaunched or left standing. Returns
   * `rerequest` when the decision itself must be asked again — only the loop's own request path
   * can do that, so it takes its bound and re-request from there. `wait` means the ended session
   * could not be put down yet, so the step is taken again next cycle.
   */
  const actOnStep = async (item: Work, watch: ApprovalWatch, step: ApprovalStep): Promise<'wait' | 'rerequest' | 'done'> => {
    const base = `approver:${watch.decision}`;
    // While the ended session cannot be put down, its name or registry slot still refuses a
    // replacement, so the step is taken again next cycle.
    if (!await closeApprover(item, watch, step.detail) && watch.closeAttempts < maxApproverCloses) return 'wait';
    // A launch that waited for a slot or was refused ran no session: it is only made again. A
    // capacity wait relaunches one at a time (GY-849): while another waiter's relaunch is still
    // on the launcher, this one waits for a later cycle.
    if (step.step === 'relaunch' && !watch.agentName) {
      if (capacityRelaunchWaits(watch)) return 'wait';
      if (watch.capacity) capacityRelaunchHanded = true;
      const waited = watch.capacity ? 'waited for an approver slot' : 'had its last approver launch refused';
      try { await note(`${base}:launch:${watch.launches + 1}`, item, 'decision', 'done', `${item.key}'s ${watch.action} decision ${watch.decision} ${waited}; ${await launch(item, watch, false)}`); }
      catch (error) { await note(`${base}:launch:${watch.launches + 1}`, item, 'decision', 'failed', `${item.key}'s ${watch.action} decision ${watch.decision} ${waited}; its approver session could not be launched: ${message(error)}`); }
      return 'done';
    }
    recordWatchEnded(watch, step.detail);
    if (step.step === 'rerequest') return 'rerequest';
    if (step.step === 'exhausted') { await escalateUnjudged(item, watch, step.detail); return 'done'; }
    try { await note(`${base}:launch:${watch.launches + 1}`, item, 'decision', 'done', `${step.detail}; ${await launch(item, watch, false)}`); }
    catch (error) { await note(`${base}:launch:${watch.launches + 1}`, item, 'decision', 'failed', `${step.detail}; a replacement approver session could not be launched: ${message(error)}`); }
    return 'done';
  };
  // 4c'. Approver sessions no request of the loop's launched (GY-403). `master approver` records the
  //      item and decision with its launch, and the loop registers such a session in its approval
  //      watch; one with no record is known by its name, which `approverSessionName` derives from the
  //      item and decision. Either way the session is supervised exactly as the loop's own approvers
  //      are (GY-551): closed, with why, once its decision is applied, refused or otherwise settled,
  //      or its item is delivered, and relaunched while the decision stands open and it ends without
  //      judging it — on the next eligible approver account, up to the same launch bound, a relaunch
  //      the registry or control plane refused retried on the next cycle. One the loop still needs
  //      is adopted by the request path, which retires this watch.
  const superviseHandApprovers = () => isolate('decision', null, 'hand-approvers', async () => {
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
          Object.assign(watch, { exhaustedAt: null, launches: 1, closeAttempts: 0, pane: agent.pane_id, launchedAt: fresh?.launchedAt ?? stamp, account: fresh?.account ?? null, runtime: fresh?.runtime ?? null, session: fresh?.session ?? watch.session, capacity: null, reportedExhaustion: null, heldExhaustion: null });
          await note(`approver:${watch.decision}:rewatched:${watch.launchedAt}`, item, 'decision', 'done', `Watching approver session ${agent.name}, put to ${item.key} decision ${watch.decision} again after its earlier sessions were spent`);
        }
        if ((!judged || judged.state === 'requested') && await approverExhausted(item, watch)) continue;
        const step = approvalStep({ ...watch, launchedAt: watch.launchedAt ?? watch.requestedAt }, judged, seen, clock);
        if (step.step === 'wait') continue;
        // GY-1300: an approved decision is judged. Its session is put down, never replaced, and the control plane is asked to apply
        // what was approved; the next cycle finds it applied and lets the watch go, or asks again.
        if (step.step === 'apply') {
          recordWatchEnded(watch, step.detail);
          if (effects.resume) await effects.resume(item, watch.decision).catch(error => note(`approver:${watch.decision}:apply`, item, 'decision', 'failed', `${step.detail}, and could not: ${message(error)}`));
          await closeApprover(item, watch, 'its decision is approved');
          continue;
        }
        if (step.step === 'relaunch' && !watch.agentName && approversSpent) continue;
        // The close, relaunch, record and escalation steps of the loop's own watches (GY-779): a
        // `rerequest` step cannot arise here — a decision this watch holds that the control plane
        // settled otherwise already set `why` above — and a hand watch has no request of its own
        // to repeat.
        await actOnStep(item, watch, step);
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
  const reconcileRegistrySessions = async () => { if (effects.reconcileSessions) await isolate('decision', null, 'agent-registry', async () => {
    const finished = new Map<string, string>();
    for (const watch of Object.values(state.approvals)) if (watch.session && watch.settledAt) finished.set(watch.session, `approver decision ${watch.decision} on ${watch.work} is judged`);
    const ended = await effects.reconcileSessions!(await sessions(), finished);
    for (const watch of Object.values(state.approvals)) if (watch.session && ended.some(entry => entry.session === watch.session)) watch.session = null;
    for (const entry of ended) performed.push(await record(state, `registry:end:${entry.session}`, { kind: 'close', work: entry.work, principal: null, state: 'done',
      detail: `Ended the ${entry.role} registry session ${entry.session} on ${entry.account}${entry.work ? ` for ${entry.work}` : ''}: ${entry.reason}`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
  }); };
  return { sessions, invalidate, endApproverSession, closeApprover, capacityRelaunchWaits, launch, approverExhausted, escalateUnjudged, actOnStep, superviseHandApprovers, reconcileRegistrySessions };
}
