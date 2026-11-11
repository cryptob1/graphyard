import { sessionAgents } from '../session-inventory.js';
import { type Work } from '../model.js';
import { observeSessions, registeredLaunch, reportedHandle } from '../model/session-state.js';
import { type SessionHandleInput } from '../model/sessions.js';
import { runtimeEndedStates } from '../harness.js';
import { type DispatchRequest } from '../model/dispatch.js';
import { profileAccount } from '../master/environments.js';
import { sessionAgentName, withReviewerDefaults, type MasterConfig, type ProducerProfile, type ReviewerProfile } from '../master/profiles.js';
import { withLaunchedRuntime } from '../master/launch.js';
import { boundedLaunch, launchBoundMs } from '../master/launch-bound.js';
import { capacityRefusal } from '../fleet.js';
import { WorkerSandboxError } from '../worker-sandbox.js';
import { answeredByPendingReview, LauncherUnavailableError, UnknownReviewerProfileError, unpostedVerdict } from '../reviewer.js';
import { launchRefusalProbeDue, owedPostMergeReviews, postMergeRefusalProbeMs } from '../model/post-merge-review.js';
import { answeredByPendingSession, independentProducerProfiles, sessionRetry } from '../producer.js';
import { unexercisedFindings } from '../model/mechanical-proofs.js';
import { cursorTextLimit, bounded, closeFailureReasons, type DispatchLaunch, type DispatchWait, dispatchAttemptCeiling, type DispatchFailure, type DispatchCursor, dispatchRetryMinMs, dispatchRetryMaxMs, capacityRecheckMs, dispatchReadTimeoutMs, attributePersistFailure, tickWaits, capacityReasonLimit, dispatchFailureReasonLimit, closureFailureReasonLimit, dispatchFailureLimit, verdictIngestGraceMs, backedOffProfiles, probeBackoffFailures, probeBackoffMs } from './cursor.js';
import { describeAttempts, unactedProducerSession, requestSpentAt, preferFreshProfiles, requestSessions, limitNoticeExit, type DispatchedSession } from './attempts.js';
import { selectReviewerProfile, launchWithFailover, type InstantExit } from './launch-failover.js';
import { launchedSessionHandle, type SessionClosure, sessionHandleKey, reconcileSessionLiveness, reportClosure, sweepRegistrySessions } from './session-sweep.js';
import { postMergeWaitReason, reviewedAfterMerge, postMergeRequest, filePostMergeFollowUps } from './post-merge.js';
import type { DispatchEffects } from './effects.js';

/**
 * The launch side of automatic dispatch at submit. The control plane records what each exact
 * head still needs (model/dispatch.ts); this loop reads those requests every few seconds and
 * launches the configured reviewer profile and one producer session per proof group for them,
 * within the 30-second bound and without a keystroke. It launches at most one session per
 * request id — the reviewer and producer ledgers say which requests already have one — so a
 * restart, a second tick, or a re-read snapshot never doubles a session. A head change is the
 * control plane's cancellation: the ledgers close the sessions for the old head on the next
 * tick, and the new head's requests launch afresh unless a carried binding covers them. The
 * master handles findings, reworks and merges; it never launches these by hand.
 *
 * A session that started and then failed or expired does not strand its request until the head
 * changes: the request is launched again as its next attempt after a widening wait (producer.ts
 * `sessionRetry`), up to a bound, and master status reports the attempts and the next one.
 *
 * Each reviewer and producer profile runs as many sessions at once as its `concurrency` declares
 * (GY-107; master.ts profileSessions): a launch takes the first profile with a slot left, a request
 * with none waits and the tick says which limit it waits on. The limit is read from the live
 * configuration on every tick, so raising it starts more sessions on the next tick and lowering it
 * launches nothing new until the running sessions drain — none is stopped.
 *
 * This interval is also what reconciles session liveness (GY-113; model/sessions.ts). A session
 * recorded as running is otherwise believed until something ends it, and a session that died reports
 * nothing — so every tick sweeps the graph's running handles against what the runtime reports,
 * closes the ones that vanished, ended, were superseded by a head or a candidate moving on, or hold
 * a slot a newer session already holds, and counts a role slot as taken only while the reconciled
 * record says a live session has it. Closing finished sessions is therefore no longer a duty
 * anybody performs by hand.
 */
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const retryDelay = (attempts: number) => Math.min(dispatchRetryMinMs * 2 ** Math.max(0, attempts - 1), dispatchRetryMaxMs);
/** The fixed wording of review launch-wait reasons (GY-1175). */
const launchWaitWording = { busy: 'every reviewer profile is busy', settles: 'the control plane settles the request once it reads that verdict' } as const;
export interface DispatchTick { at: string; launched: DispatchLaunch[]; refused: (DispatchFailure & { requestId: string })[]; waiting: DispatchWait[]; skipped: number;
  /** Post-merge verdicts this tick filed (GY-1525): the follow-up items per item and merge commit. */
  followUps?: { work: string; sha: string; filed: string[]; memory: number; failure?: string }[];
  /** Session records this tick reconciled against the runtime, and the ones whose closure could not be written back. */
  closed: SessionClosure[]; closeFailures: { work: string; id: string; reason: string }[];
  /** Registry sessions this tick ended because no Herdr pane backed them (GY-2945), with the missing pane. */
  registryClosed?: { work: string | null; id: string; role: string; pane: string | null }[];
  /** The session report (GY-172): how many sessions this tick observed, how many records it wrote, and the writes that failed. */
  sessions?: { observed: number; written: number; failures: { work: string; id: string; reason: string }[] };
  /** Items whose observation this tick woke because a reviewer had answered their request (GY-1429). */
  woken?: string[] }


/**
 * One tick: settle the sessions the ledgers hold against the snapshot, then launch a session for
 * every open request that has none. Each launch is recorded by the launcher's own ledger before
 * the tick moves on, so a kill between two launches leaves nothing to repeat.
 */
export async function runDispatchTick(config: MasterConfig, cursor: DispatchCursor, effects: DispatchEffects, now: () => number = Date.now, readTimeoutMs = dispatchReadTimeoutMs, launchBound = launchBoundMs(config)): Promise<DispatchTick> {
  return dispatchTick(config, cursor, effects, now, readTimeoutMs, launchBound);
}

async function dispatchTick(config: MasterConfig, cursor: DispatchCursor, effects: DispatchEffects, now: () => number, readTimeoutMs: number, launchBound: number): Promise<DispatchTick> {
  const snapshot = await boundedRead(() => effects.snapshot(readTimeoutMs), readTimeoutMs);
  const observedAt = snapshot.now;
  const clock = Number.isFinite(Date.parse(observedAt)) ? Date.parse(observedAt) : now();
  const tick: DispatchTick = { at: new Date(clock).toISOString(), launched: [], refused: [], waiting: [], skipped: 0, closed: [], closeFailures: [] };
  const inventoryRead = await effects.inventory?.();
  const herdr = inventoryRead ? (inventoryRead.available ? sessionAgents(inventoryRead) : null) : await effects.agents();
  // GY-1490: the loop sleeping beside this tick is woken for what its next cycle acts on, within one tick of it appearing.
  try { effects.observeLoopSubjects?.(snapshot.work, herdr, clock); } catch { /* a wake that cannot be judged leaves the loop to its interval */ }
  // GY-3234: read once per tick — a pending review whose pane and registry session are both gone
  // settles here, and the registry sweep below judges the same document.
  const registry = herdr && effects.registry ? await effects.registry() : null;
  const { reviews, released } = await effects.reconcileReviews(snapshot.work, herdr, registry);
  const { producers } = await effects.reconcileProducers(snapshot.work, herdr);
  // Session liveness, swept on this same bounded interval (GY-113): a session that died reports
  // nothing, so nothing but a sweep ever contradicts a record that says it is running. The judgment
  // is made before anything launches, because the slot check below reads it.
  // The item's own facts first — a review or proof session bound to something the item moved past,
  // or a second session in one slot. The runtime is not consulted here: what the runtime says is
  // the session report below, the one observation every reader shares (GY-172).
  const sweep = reconcileSessionLiveness(snapshot.work, null, new Date(clock), { states: runtimeEndedStates, hostId: config.hostId });
  const superseded = new Set(sweep.closures.map(closure => sessionHandleKey(closure.workId, closure.id)));
  const report = observeSessions(snapshot.work, herdr, new Date(clock), { states: runtimeEndedStates, hostId: config.hostId, settled: superseded, firstMissed: cursor.sessionMisses });
  const closures = [...sweep.closures, ...report.entries.filter(entry => entry.closed).map(reportClosure)];
  // What the runtime did not report this tick, for the closing reason to say how long. The map
  // holds only handles currently missing, so it is bounded by the graph's live sessions.
  // A tick that could not read the runtime reported nothing, so it leaves them as they were.
  if (herdr) cursor.sessionMisses = report.missing;
  const byId = new Map(snapshot.work.map(item => [item.id, item]));
  const sessions = tick.sessions = { observed: report.entries.length, written: 0, failures: [] as { work: string; id: string; reason: string }[] };
  await (async () => {
    for (const entry of report.entries.filter(entry => !entry.closed && entry.changed)) {
      const item = byId.get(entry.workId);
      // A delivered item takes the observation too (engine.ts): a session that outlives the delivery
      // is still one every reader shows, so its record is kept as fresh as any other.
      if (!item || !effects.recordSession) continue;
      // The observation is the record every reader shows; one that could not be written is
      // retried by the next tick's report, which finds the stored record still behind.
      try { await effects.recordSession(item, reportedHandle(entry)); sessions.written++; }
      catch (error) { sessions.failures.push({ work: entry.key, id: entry.id, reason: bounded(message(error), closureFailureReasonLimit) }); }
    }
    for (const closure of closures) {
      // A closure that cannot be written back still stands as a judgment — the session is over
      // whichever way the record went — so the slot is freed either way and the tick says what failed.
      try { await effects.endSession?.(closure); tick.closed.push(closure); }
      catch (error) { tick.closeFailures.push({ work: closure.key, id: closure.id, reason: bounded(message(error), closureFailureReasonLimit) }); }
    }
  })();
  if (herdr && registry) await sweepRegistrySessions(config.hostId, cursor, effects, registry, herdr, [...reviews, ...producers], clock, snapshot.work, tick);
  // An unreadable inventory cannot confirm whether a launch name is already running.
  // A released pane is matched by its (pane, name) pair, as the reconcile pass matched it, in the
  // inventory and in the recorded handles alike (GY-1075): `observeSessions` above read the
  // inventory before the close, so a running handle on that pane still says running until a later
  // tick's report closes it, and a profile of one session could not take the freed name this tick.
  const releasedPanes = new Set((released ?? []).map(entry => `${entry.pane}\0${entry.agentName}`));
  const isReleased = (pane: string | null | undefined, name: string | null | undefined) => !!pane && !!name && releasedPanes.has(`${pane}\0${name}`);
  const agents = (herdr ?? []).filter(agent => !isReleased(agent.pane_id, agent.name));
  const credentials = await effects.credentials(config.producers);
  // The sessions this tick has started join the inventory at once, so two requests in one tick
  // never both take a profile's last slot. A launcher that does not report its session name is
  // counted under the name it would have chosen for the request.
  const started: { name: string }[] = [];
  const inventory = () => [...agents, ...started];
  const launchedName = (profile: { agentName: string; concurrency?: number }, request: DispatchRequest, result: unknown) =>
    typeof (result as { agentName?: unknown })?.agentName === 'string' ? (result as { agentName: string }).agentName : sessionAgentName(profile, { id: request.id, requestId: request.id });
  // Registration (GY-172 AC-2): the recorder every launch below registers through, and the
  // coordinates a launcher's result carries once its runtime has started.
  const record = (item: Work) => effects.recordSession ? (handle: SessionHandleInput) => effects.recordSession!(item, handle) : undefined;
  const coordinates = (profile: { agentName: string; concurrency?: number }, request: DispatchRequest, result: unknown) => ({ pane: (result as { pane?: string | null } | undefined)?.pane ?? null, agentName: launchedName(profile, request, result) });
  const attachTo = (pane: string) => `herdr pane attach ${pane}${config.herdrWorkspace ? ` --workspace ${config.herdrWorkspace}` : ''}`;
  // Each launch is bounded on its own (GY-1373): one its runtime never acknowledges fails as that
  // request's refusal naming the runtime, and the launches step — and with it the tick — goes on.
  const withinBound = <T>(handle: SessionHandleInput, start: () => Promise<T>) => () => boundedLaunch(start, { runtime: handle.runtime, host: config.hostId, subject: handle.subject ?? handle.id, boundMs: launchBound });
  /**
   * The slots recorded sessions still hold. A handle is the durable record of a live session, so a
   * session this host has not listed yet — or one another host launched — holds its profile's slot
   * as surely as a listed pane does, and the record outlives a restart of this loop. A session the
   * sweep above judged over holds nothing: that is what makes a name busy only while a live session
   * has it, rather than until somebody ends the record by hand (GY-113 AC-2). Nor does one on a pane
   * the review reconcile closed this tick, nor one the runtime no longer lists whose ledger record
   * settled (GY-1716): its request is still open, so no fact closes the handle, and only a
   * replacement launched into the slot it held can answer that request.
   */
  const wait = (kind: 'review' | 'producer', item: Work, request: DispatchRequest, reason: string, answeredAt?: string) => tick.waiting.push({ kind, work: item.key, requestId: request.id, sha: request.sha, reason, requestedAt: request.requestedAt, ...(request.group ? { group: request.group } : {}), ...(answeredAt ? { answeredAt } : {}) });
  /**
   * GY-1429: a review request a reviewer already answered settles only once the item's observation
   * reads the verdict, and that reading rode the scheduler's thirty-minute review band, so a verdict
   * posted between readings stood unread for minutes while the request aged. The verdict wakes the
   * item's observation at once, one wake per item per tick, unless a reading newer than the verdict
   * already stands; the tick awaits the wakes before it ends and a failed one is named on the wait.
   */
  const settlementWakes = new Map<string, { key: string; wake: Promise<string | null> }>();
  const wakeSettlement = (item: Work, answeredAt: string) => {
    const observed = Date.parse(item.observation?.at ?? ''), answered = Date.parse(answeredAt);
    if (!effects.wakeObservation || settlementWakes.has(item.id) || Number.isFinite(observed) && Number.isFinite(answered) && observed > answered) return;
    settlementWakes.set(item.id, { key: item.key, wake: Promise.resolve().then(() => effects.wakeObservation!(item)).then(() => null, (error: unknown) => message(error)) });
  };
  const refuse = (kind: 'review' | 'producer', item: Work, request: DispatchRequest, error: unknown) => {
    if ((error as { probeBackoff?: boolean })?.probeBackoff) { delete cursor.failures[request.id]; wait(kind, item, request, bounded(message(error), dispatchFailureReasonLimit)); return; }
    const previous = cursor.failures[request.id];
    // Bounded at the cursor schema's ceiling: a request probed hourly past its attempt limit (GY-2075)
    // keeps counting its refusals, and the count must stay one the cursor can persist.
    const attempts = Math.min(previous?.attempts ?? 0, dispatchAttemptCeiling - 1) + 1;
    // Bounded below the cursor's cap: the wait sentence that wraps it on later ticks must fit too.
    const failure: DispatchFailure = { kind, work: item.key, sha: request.sha, attempts, reason: bounded(message(error), dispatchFailureReasonLimit), at: new Date(now()).toISOString(), nextAt: new Date(now() + retryDelay(attempts)).toISOString() };
    cursor.failures[request.id] = failure;
    // A refusal is the role answering with something other than spent quota, so any hold the
    // previous tick armed is stale: withdraw it rather than let the summary keep reporting a
    // provider reset beside the failure a master can fix now.
    delete cursor.capacity[kind];
    tick.refused.push({ ...failure, requestId: request.id });
  };
  // A role out of capacity is not launched again until its accounts are due to be read, and the
  // wait is never a failure: nothing is counted, and the request launches when an account returns.
  const spent = (kind: 'review' | 'producer') => { const hold = cursor.capacity[kind]; return hold && Date.parse(hold.recheckAt) > now() ? hold : null; };
  const capacityWait = (kind: 'review' | 'producer') => `${kind === 'review' ? 'reviewer' : 'producer'} capacity is exhausted (${cursor.capacity[kind]!.reason}); launches are paused and its accounts are read again at ${cursor.capacity[kind]!.recheckAt}`;
  const outOfCapacity = (kind: 'review' | 'producer', item: Work, request: DispatchRequest, error: unknown) => {
    // A role at its registry concurrency limit waits for a slot (GY-205), as an approver does: the
    // refusal is not counted against the request and arms no quota hold, so the launch is made again
    // on the first tick after the registry ends a session of the role.
    const full = capacityRefusal(error);
    if (full) { delete cursor.failures[request.id]; wait(kind, item, request, `waits for a ${kind === 'review' ? 'reviewer' : 'producer'} slot, launched on the first tick one frees: ${full}`); return true; }
    if (!(error as { capacityExhausted?: boolean })?.capacityExhausted) return false;
    cursor.capacity[kind] = { at: cursor.capacity[kind]?.at ?? new Date(now()).toISOString(), recheckAt: new Date(now() + capacityRecheckMs).toISOString(), reason: bounded(message(error), capacityReasonLimit) };
    delete cursor.failures[request.id];
    wait(kind, item, request, capacityWait(kind));
    return true;
  };
  // The tick's reasons, in the order they are stored, each with the request it was composed for:
  // a persist that fails on one of them is attributed to that request rather than to the tick.
  const composed = () => {
    const reasons = new Map<string, DispatchWait>();
    for (const entry of tick.waiting) { const reason = bounded(`${entry.kind} for ${entry.work} ${entry.sha.slice(0, 12)}: ${entry.reason}`, cursorTextLimit); if (!reasons.has(reason)) reasons.set(reason, entry); }
    return [...reasons.entries()].slice(0, 20);
  };
  // One write at a time: producer launches run beside each other and persist as each ends, and two writes of
  // the cursor racing each other could land the older state last.
  let persisting: Promise<unknown> = Promise.resolve();
  const persist = () => {
    const write = persisting.then(async () => { try { await effects.persist(cursor); } catch (error) { throw attributePersistFailure(error, cursor, composed().map(([, entry]) => entry)); } });
    persisting = write.catch(() => { /* the caller that wrote it sees the failure */ });
    return write;
  };
  // The failover for a session that exited at launch on its provider's limit notice: the account
  // the launcher selected is held until the reset the notice named, the exhaustion goes on the
  // item's record as a mid-session one would, and the caller launches the profile's next account.
  const exhaustedAtLaunch = (kind: 'review' | 'producer', item: Work, request: DispatchRequest) => async (profile: { name: string; kind?: string }, exit: InstantExit): Promise<string> => {
    const role = kind === 'review' ? 'reviewer' : 'producer', notice = exit.notice!;
    const selected = await effects.selectedAccount?.(role, profile.name).catch(() => null) ?? null;
    const account = selected?.environment ?? null;
    const held = await effects.holdAccount!(account ?? profileAccount(profile.name), { at: new Date(now()).toISOString(), resetsAt: notice.resetsAt, reason: notice.reason, role, profile: profile.name, work: item.key });
    await effects.reportCapacity?.(item, { event: 'exhausted', role, requestId: request.id, profile: profile.name, account, runtime: selected?.kind ?? profile.kind ?? null, reason: notice.reason, resetsAt: notice.resetsAt,
      partialWork: { state: 'not-applicable', detail: 'the session exited at launch on the provider limit notice: it read nothing and edited nothing' } }).catch(() => { /* the hold stands; a record the control plane refused is not a failed failover */ });
    return `${profile.name}: ${account ?? `${profile.name}'s own account`} exited at launch on its provider's limit notice (${notice.reason}); held ${notice.resetsAt ? `until it resets ${notice.resetsAt}` : held && 'until' in held && held.until ? `until ${held.until}` : 'for its reset'}`;
  };
  const retryable = (request: DispatchRequest) => { const failure = cursor.failures[request.id]; return !failure || failure.attempts < dispatchFailureLimit && Date.parse(failure.nextAt) <= now(); };
  // A request whose automatic sessions all ended unanswered is left to the master, once, naming
  // every attempt; the wait says no further attempt follows, and status raises the attention item.
  const abandon = (kind: 'review' | 'producer', item: Work, request: DispatchRequest, records: DispatchedSession[], why: string) => {
    if (!cursor.abandoned[request.id]) cursor.abandoned[request.id] = { kind, work: item.key, sha: request.sha, at: new Date(now()).toISOString(), reason: bounded(why, dispatchFailureReasonLimit), attempts: describeAttempts(records, request.id),
      ...(kind === 'producer' && request.group ? { group: request.group, proofs: (request.proofs ?? []).slice(0, 50) } : {}) };
    wait(kind, item, request, `${why}; no further automatic attempt, raised as attention for the master`);
  };
  // GY-1153. A producer request whose every attempt ended without the session acting judged nothing
  // about the candidate, so spending its attempts is a producer-runtime fault, not the head's: once
  // the request is spent it relaunches on an independent profile whose credential is available and
  // which none of its attempts ran on. A profile it already tried is not relaunched on for a trust
  // prompt or a broken runtime, which look healthy to the credential check and would spend a session
  // every cycle. GY-1227: a profile whose last attempt exited at launch on its account's limit notice
  // was held until the reset; once its credential reads available again it has recovered, and the
  // request relaunches on it once, which a sole producer profile needs to recover without an
  // operator. Null when the request has any attempt that acted.
  const runtimeProfiles = (item: Work, request: DispatchRequest, records: DispatchedSession[]) => {
    const sessions = requestSessions(records, request.id);
    if (!sessions.length || !sessions.every(unactedProducerSession)) return null;
    const spentAt = requestSpentAt(sessions, now()), before = sessions.slice(0, spentAt), after = sessions.slice(spentAt);
    const tried = new Set(sessions.map(record => record.profile).filter((name): name is string => !!name));
    const recovered = (name: string) => !after.some(record => record.profile === name) && limitNoticeExit(before.filter(record => record.profile === name).at(-1));
    return independentProducerProfiles(item, config.producers).filter(profile => credentials[profile.name]?.available !== false && (!tried.has(profile.name) || recovered(profile.name)));
  };
  // A spent request: its sessions are exhausted, or settled at the limit (GY-1227: the settled path
  // relaunches as the exhausted one does, so the launch restricts it to the same profiles).
  const spentRequest = (records: DispatchedSession[], request: DispatchRequest) => { const retry = sessionRetry(records, request.id, now()); return retry.exhausted || retry.settled && retry.attempts >= dispatchFailureLimit; };
  const runtimeRelaunch = (kind: 'review' | 'producer', item: Work, request: DispatchRequest, records: DispatchedSession[]) => {
    if (kind !== 'producer' || !runtimeProfiles(item, request, records)?.length) return false;
    delete cursor.abandoned[request.id];
    return true;
  };
  // Whether the request already has its session, waits to relaunch one that ended, or may launch now.
  const session = (kind: 'review' | 'producer', item: Work, request: DispatchRequest, records: DispatchedSession[]) => {
    const retry = sessionRetry(records, request.id, now());
    const role = kind === 'review' ? 'reviewer' : 'producer';
    if (retry.settled) {
      if (!retry.last || retry.last.state === 'pending') { tick.skipped++; return false; }
      // A session that settled while its request still stands for the same head answered nothing
      // the gates accept (GY-193): the next attempt launches on this tick, on another profile first,
      // up to the dispatch failure limit. Only a verdict the control plane may not have read yet is
      // waited on first, since a second verdict on one request is withheld together with the first.
      const last = requestSessions(records, request.id).at(-1)!;
      const settledAt = Date.parse(last.closedAt ?? last.requestedAt);
      const settled = `${role} session attempt ${retry.attempts} ${last.state} without satisfying the request: ${last.resolution ?? 'no reason recorded'}`;
      if (kind === 'review' && last.verdict && last.verdict.state !== 'DISMISSED' && now() - settledAt < verdictIngestGraceMs) {
        tick.skipped++;
        const answeredAt = new Date(settledAt).toISOString();
        wakeSettlement(item, answeredAt);
        wait(kind, item, request, `${role} session attempt ${retry.attempts} posted ${last.verdict.state}; the control plane is given until ${new Date(settledAt + verdictIngestGraceMs).toISOString()} to read it before another attempt`, answeredAt);
        return false;
      }
      if (retry.attempts >= dispatchFailureLimit) {
        if (runtimeRelaunch(kind, item, request, records)) return true;
        tick.skipped++; abandon(kind, item, request, records, `${settled}, after ${retry.attempts} sessions`); return false;
      }
      return true;
    }
    if (retry.launch) return true;
    const last = `${role} session attempt ${retry.attempts} ${retry.last!.state}: ${retry.last!.resolution ?? 'no reason recorded'}`;
    if (retry.exhausted) {
      if (runtimeRelaunch(kind, item, request, records)) return true;
      abandon(kind, item, request, records, `${last}; ${retry.attempts} sessions failed or expired`);
      return false;
    }
    // A reviewer that judged the head and was reminded to post, and still posted nothing within the
    // bound, is relaunched now (GY-193 AC-2): the wait was the reminder's, already served.
    const ended = requestSessions(records, request.id).at(-1);
    if (kind === 'review' && ended?.acknowledgedAt && !ended.verdict && unpostedVerdict.test(ended.resolution ?? '')) return true;
    wait(kind, item, request, `${last}; attempt ${retry.attempts + 1} of ${retry.limit} at ${retry.nextAt}`);
    return false;
  };
  // A reviewer launch must never take a Herdr name a producer
  // launch is taking: both read the tick's inventory, and a name joins it only once its launch
  // returns. A launch holds the agent name of the one profile it is launching on until that name is
  // in the inventory, and takes a failover profile's name only when failover reaches it, so a launch
  // never waits on a name it would not have used.
  const nameTurns = new Map<string, Promise<unknown>>();
  const reserveName = <T>(name: string, launch: () => Promise<T>): Promise<T> => {
    const turn = (nameTurns.get(name) ?? Promise.resolve()).then(launch);
    nameTurns.set(name, turn.catch(() => { /* the launcher sees the failure */ }));
    return turn;
  };
  // Launch over `profiles` in order, each in its own name's turn. Room is read again once the name
  // is this launch's. The registry chooses and reserves the slot inside the launcher.
  // GY-3235: a profile whose launch failed the same sandbox probe twice in a row is skipped for its
  // role until its backoff ends, in favour of the next; the probe failure is the profile's, never
  // a refusal counted against the request.
  const launchInTurns = async <P extends ReviewerProfile | ProducerProfile>(request: DispatchRequest, profiles: P[], launch: (profile: P) => Promise<unknown>, exhausted?: (profile: P, exit: InstantExit) => Promise<string>) => {
    const role = request.kind === 'producer' ? 'producer' : 'reviewer', key = (profile: P) => `${role}:${profile.name}`;
    const skipped = backedOffProfiles(cursor, now()).filter(entry => entry.role === role);
    const usable = profiles.filter(profile => !skipped.some(entry => entry.profile === profile.name));
    if (profiles.length && !usable.length) throw Object.assign(new Error(`every ${role} profile is backed off after failing its launch probe: ${skipped.map(entry => `${entry.profile} until ${entry.until} (${entry.cause})`).join('; ')}`), { probeBackoff: true });
    return launchWithFailover(usable, profile => reserveName(profile.agentName, async () => {
      let result: unknown;
      try { result = await launch(profile); }
      catch (error) {
        if (!(error instanceof WorkerSandboxError)) throw error;
        const previous = cursor.profileBackoff[key(profile)], failures = previous?.path === error.path ? Math.min(previous.failures, dispatchAttemptCeiling - 1) + 1 : 1;
        cursor.profileBackoff[key(profile)] = { role, profile: profile.name, path: bounded(error.path, cursorTextLimit), cause: bounded(message(error), cursorTextLimit), failures, at: new Date(now()).toISOString(),
          until: failures >= probeBackoffFailures ? new Date(now() + probeBackoffMs).toISOString() : null };
        throw Object.assign(error, { probeBackoff: true });
      }
      delete cursor.profileBackoff[key(profile)];
      started.push({ name: launchedName(profile, request, result) });
      return result;
    }), exhausted);
  };
  const dispatchReview = async (item: Work, review: DispatchRequest) => {
    // A product review (GY-2989) launches like a review on the same reviewer lanes — one session per
    // head, reviewer concurrency and capacity.
    if (review.kind === 'product') return dispatchProductReview(item, review);
    // A normal-risk control-plane head merges on its trial (model/gates.ts, GY-1525): its review comes after the merge.
    if (reviewedAfterMerge(item)) wait('review', item, review, postMergeWaitReason);
    else if (!session('review', item, review, reviews)) { /* settled, or waiting to relaunch */ }
    else if (spent('review')) wait('review', item, review, capacityWait('review'));
    else if (!retryable(review)) wait('review', item, review, `launch refused ${cursor.failures[review.id].attempts} time(s): ${cursor.failures[review.id].reason}; ${cursor.failures[review.id].attempts >= dispatchFailureLimit ? 'no further automatic attempt, launch it with master review once the cause is fixed' : `next attempt at ${cursor.failures[review.id].nextAt}`}`);
    else {
      // Every review is a control-plane review (GY-1525): it posts through the API under a one-time token, so a profile answers it with no reviewer App.
      const { profile, reason } = selectReviewerProfile(config);
      // The selected profile answers; the other reviewer profiles are its failover when none of
      // its accounts can launch. A profile with no slot left is passed over for one with room,
      // and a request no profile has room for waits on the limit it names.
      const candidates = profile ? [profile, ...withReviewerDefaults(config).reviewers.filter(other => other.name !== profile.name)] : [];
      const withRoom = () => preferFreshProfiles(candidates, reviews, review.id);
      const busy = () => wait('review', item, review, `${launchWaitWording.busy}: registry slots are occupied; set concurrency on the registry reviewer role`);
      if (!profile) wait('review', item, review, reason!);
      else if (!withRoom().length) busy();
      else {
        try {
          // The session is registered before its runtime starts and its coordinates written once it
          // has (GY-172), where every Graphyard reader looks — so watching this reviewer never means
          // reading this host's local ledger, and the session report observes it from the start.
          const launched = await launchInTurns(review, withRoom(), candidate => {
            const handle = launchedSessionHandle('review', review, `${item.key}: review ${review.sha.slice(0, 12)} (PR #${review.pr})`, config.hostId, undefined, candidate.kind, config.herdrWorkspace);
            return registeredLaunch(record(item), handle, withinBound(handle, withLaunchedRuntime(handle, () => effects.launchReview(item, review, candidate, inventory(), observedAt))), result => coordinates(candidate, review, result), attachTo);
          }, effects.holdAccount ? exhaustedAtLaunch('review', item, review) : undefined);
          if (!launched) busy();
          else {
            delete cursor.failures[review.id]; delete cursor.capacity.review;
            tick.launched.push({ kind: 'review', work: item.key, requestId: review.id, sha: review.sha, profile: launched.profile.name, ...(launched.failover.length ? { failover: launched.failover } : {}), ...(launched.relaunched ? { relaunched: true } : {}) });
          }
        } catch (error) {
          // A request a settled session already answered waits on the control plane reading that
          // verdict (GY-1083): no launch was refused, so no failure counts against the request.
          const answered = answeredByPendingReview(error, review);
          if (answered?.answered) {
            wakeSettlement(item, answered.answered.at);
            wait('review', item, review, `reviewer session ${answered.agentName} already answered with ${answered.answered.state} (review ${answered.answered.reviewId}); ${launchWaitWording.settles}`, answered.answered.at);
          }
          // A live reviewer session already answering this head is a wait, never a counted refusal; one gone from Herdr still refuses.
          else if (answered && inventory().some(agent => agent.name === answered.agentName)) { delete cursor.failures[review.id]; wait('review', item, review, `reviewer session ${answered.agentName} is already pending on ${review.sha.slice(0, 12)}; ${launchWaitWording.settles}`); }
          // An unknown reviewer profile is a configuration wait (GY-1850): the launch boundary spaces its own attempts and master status names the fix, so nothing is counted and the request resumes once the profiles change.
          else if (error instanceof UnknownReviewerProfileError) { delete cursor.failures[review.id]; wait('review', item, review, message(error)); }
          // GY-2995: a launch whose sandbox cannot reach its own CLI is configuration attention, never a counted failure.
          else if (error instanceof LauncherUnavailableError) { delete cursor.failures[review.id]; wait('review', item, review, message(error)); }
          else if (!outOfCapacity('review', item, review, error)) refuse('review', item, review, error);
        }
        await persist();
      }
    }
  };
  /** The product reviewer's launch: the same session machinery as a code review, with the product prompt and a product launch registration. */
  const dispatchProductReview = async (item: Work, request: DispatchRequest) => {
    if (!session('review', item, request, reviews)) { /* settled, or waiting to relaunch */ }
    // The review ledger starts one session per head: a code review still under way on this head is
    // answered first, and the product review launches once it settles — its verdict, or the rework
    // that replaces the head, settles this request beside it. There is no other wait: the trial a
    // head serves by cannot run while the review gate holds for this very review, and a repository
    // with no previewable application never serves the head at all. The reviewer walks the served
    // app against the head's diff instead, as the product prompt's fallback names.
    else if (reviews.some(record => record.state === 'pending' && record.key === item.key && record.sha === request.sha && record.requestId !== request.id))
      wait('review', item, request, `the product review of ${item.key} waits for the reviewer session already judging ${request.sha.slice(0, 12)}; the ledger starts one session per head`);
    else if (spent('review')) wait('review', item, request, capacityWait('review'));
    else if (!effects.launchProductReview) wait('review', item, request, 'this dispatcher launches no product reviews');
    else if (!retryable(request)) wait('review', item, request, `launch refused ${cursor.failures[request.id].attempts} time(s): ${cursor.failures[request.id].reason}; ${cursor.failures[request.id].attempts >= dispatchFailureLimit ? 'no further automatic attempt, launch it with master review once the cause is fixed' : `next attempt at ${cursor.failures[request.id].nextAt}`}`);
    else {
      const { profile, reason } = selectReviewerProfile(config);
      const candidates = profile ? [profile, ...withReviewerDefaults(config).reviewers.filter(other => other.name !== profile.name)] : [];
      const withRoom = () => preferFreshProfiles(candidates, reviews, request.id);
      const busy = () => wait('review', item, request, `product review: ${launchWaitWording.busy}: registry slots are occupied`);
      if (!profile) wait('review', item, request, `product review: ${reason!}`);
      else if (!withRoom().length) busy();
      else {
        try {
          const launched = await launchInTurns(request, withRoom(), candidate => {
            const handle = launchedSessionHandle('review', request, `${item.key}: product review ${request.sha.slice(0, 12)}`, config.hostId, undefined, candidate.kind, config.herdrWorkspace);
            return registeredLaunch(record(item), handle, withinBound(handle, withLaunchedRuntime(handle, () => effects.launchProductReview!(item, request, candidate, inventory(), observedAt))), result => coordinates(candidate, request, result), attachTo);
          }, effects.holdAccount ? exhaustedAtLaunch('review', item, request) : undefined);
          if (!launched) busy();
          else {
            delete cursor.failures[request.id]; delete cursor.capacity.review;
            tick.launched.push({ kind: 'review', work: item.key, requestId: request.id, sha: request.sha, profile: launched.profile.name, ...(launched.failover.length ? { failover: launched.failover } : {}), ...(launched.relaunched ? { relaunched: true } : {}), reason: 'product review' });
          }
        } catch (error) {
          const answered = answeredByPendingReview(error, request);
          if (answered) {
            // A session on this head met between the guard and the launch (the code review's, usually)
            // or one that already answered: neither is a refusal — the request settles with that
            // session's verdict, so the launch waits rather than counting failures against itself.
            if (answered.answered) wakeSettlement(item, answered.answered.at);
            wait('review', item, request, answered.answered
              ? `product reviewer session ${answered.agentName} already answered with ${answered.answered.state}; ${launchWaitWording.settles}`
              : `a reviewer session on ${request.sha.slice(0, 12)} is already answering ${item.key} (one session per head); the product review launches once it settles`, answered.answered?.at);
          }
          else if (error instanceof UnknownReviewerProfileError || error instanceof LauncherUnavailableError) { delete cursor.failures[request.id]; wait('review', item, request, message(error)); }
          else if (!outOfCapacity('review', item, request, error)) refuse('review', item, request, error);
        }
        await persist();
      }
    }
  };
  // Producer launches that could not take the same profile run at once (GY-377), so the pass is
  // bounded by the profiles' capacity and not by the sum of every launch's duration. Requests that
  // could take the same profile keep the pass's order: each waits for the earlier ones on any agent
  // name it could launch under, failover included, and then reads its room as a serial pass would.
  const producerLaunches: Promise<{ error: unknown } | null>[] = [];
  const producerTurns = new Map<string, Promise<unknown>>();
  const afterEarlier = (names: string[], launch: () => Promise<void>) => {
    const earlier = [...new Set(names)].map(name => producerTurns.get(name)).filter(Boolean);
    const turn = Promise.allSettled(earlier).then(launch);
    for (const name of names) producerTurns.set(name, turn.catch(() => { /* the launch reports its own failure */ }));
    return turn;
  };
  let outcomes: ({ error: unknown } | null)[] = [];
  await (async () => {
    try {
      for (const item of snapshot.work.filter(work => work.stage !== 'done' && work.autoDispatch)) {
        const review = item.autoDispatch!.review;
        if (review?.state === 'requested' && review.provider === 'github') await dispatchReview(item, review);
        const product = item.autoDispatch!.product;
        if (product?.state === 'requested' && product.kind === 'product') await dispatchReview(item, product);
        for (const request of item.autoDispatch!.producers.filter(entry => entry.state === 'requested')) {
          // Evidence recorded as not exercising its criterion goes back to the worker as a rework the
          // loop requests (master-daemon.ts); no producer is launched for the head again (GY-193 AC-3).
          const unexercised = unexercisedFindings(item, new Date(now()), request.sha, request.proofs);
          if (unexercised.length) { tick.skipped++; wait('producer', item, request, `evidence does not exercise its criterion (${unexercised.map(entry => entry.proof).join(', ')}); the head returns to its worker through the loop's rework, and no producer is launched for it again`); continue; }
          if (!session('producer', item, request, producers)) continue;
          if (!herdr) { wait('producer', item, request, 'Herdr session inventory is unavailable'); continue; }
          if (spent('producer')) { wait('producer', item, request, capacityWait('producer')); continue; }
          if (!retryable(request)) { wait('producer', item, request, `launch refused ${cursor.failures[request.id].attempts} time(s): ${cursor.failures[request.id].reason}; ${cursor.failures[request.id].attempts >= dispatchFailureLimit ? 'no further automatic attempt' : `next attempt at ${cursor.failures[request.id].nextAt}`}`); continue; }
          // Independence is per item, never per process: a profile whose principal held an assignment
          // on this item is skipped for this item however many slots it has, and the launcher selects
          // among the rest up to each one's concurrency.
          const independent = independentProducerProfiles(item, config.producers);
          const available = independent.filter(profile => credentials[profile.name]?.available !== false);
          // A spent request relaunching for a producer-runtime fault (GY-1153) launches only on the
          // profiles `runtimeProfiles` names; any other request on every available profile, freshest first.
          const relaunch = spentRequest(producers, request) ? runtimeProfiles(item, request, producers) ?? [] : null;
          const eligible = (profile: ProducerProfile) => (!relaunch || relaunch.some(entry => entry.name === profile.name));
          const usable = () => preferFreshProfiles(available.filter(eligible), producers, request.id);
          const busy = () => wait('producer', item, request, !config.producers.length ? 'no producer profile is configured; add one with master producer add'
            : !independent.length ? `every producer principal (${config.producers.map(profile => profile.principal).join(', ')}) has held an assignment on ${item.key}; its evidence would not be trusted`
            : `every independent producer profile is busy or unavailable (${independent.map(profile => credentials[profile.name]?.available === false ? `${profile.name}: ${credentials[profile.name].reason}` : `${profile.name}: registry slot unavailable`).join('; ')}); set concurrency on the registry producer role`);
          if (!available.some(eligible)) { busy(); continue; }
          producerLaunches.push(afterEarlier(available.map(profile => profile.agentName), async () => {
            if (!usable().length) { busy(); return; }
            try {
              const launched = await launchInTurns(request, usable(), candidate => {
                const handle = launchedSessionHandle('proof', request, `${item.key}: ${request.group} proofs on ${request.sha.slice(0, 12)} (${(request.proofs ?? []).join(', ')})`, config.hostId, undefined, candidate.kind, config.herdrWorkspace, candidate.principal);
                return registeredLaunch(record(item), handle, withinBound(handle, withLaunchedRuntime(handle, () => effects.launchProducer(item, request, candidate, inventory(), observedAt))), result => coordinates(candidate, request, result), attachTo);
              }, effects.holdAccount ? exhaustedAtLaunch('producer', item, request) : undefined);
              if (!launched) busy();
              else {
                delete cursor.failures[request.id]; delete cursor.capacity.producer; delete cursor.abandoned[request.id];
                tick.launched.push({ kind: 'producer', work: item.key, requestId: request.id, sha: request.sha, profile: launched.profile.name, group: request.group, proofs: request.proofs, ...(launched.failover.length ? { failover: launched.failover } : {}), ...(launched.relaunched ? { relaunched: true } : {}) });
              }
            } catch (error) {
              // An executor's session already answering this head is waited on, not refused (GY-415).
              const pending = answeredByPendingSession(error, request);
              if (pending) wait('producer', item, request, `producer session ${pending.agentName} is already pending on ${request.sha.slice(0, 12)} for the ${request.group} proofs`);
              else if (!outOfCapacity('producer', item, request, error)) refuse('producer', item, request, error);
            }
            await persist();
          }).then(() => null, (error: unknown) => ({ error })));
        }
      }
    } finally { outcomes = await Promise.all(producerLaunches); }
  })();
  for (const outcome of outcomes) if (outcome) throw outcome.error;
  // Review by risk (GY-1525 AC-4): a normal-risk delta the merge writer delivered owes one review of
  // its merge delta. It launches through the same ledger, retry and capacity rules as a pre-merge
  // review, under a request of its own per merge commit; its verdict's BLOCKING findings become
  // follow-up items and the rest project memory, once per record.
  const owed = effects.launchPostMergeReview ? owedPostMergeReviews(snapshot.work) : [];
  await (async () => {
    for (const item of owed) {
      const request = postMergeRequest(item);
      if (!session('review', item, request, reviews)) continue;
      if (spent('review')) { wait('review', item, request, capacityWait('review')); continue; }
      // A post-merge request the attempt limit stranded is probed again one hour after its last
      // refusal (GY-2075): nothing else recovers it — the item is delivered, so no pre-merge
      // request stands for `master review` to answer, and a system-driven item refuses the command
      // — while its refusal's cause usually lives in the served control plane the loop cannot fix
      // from here. The probe is one attempt per standstill hour; the first one past the cause's
      // repair launches, and the launch that succeeds clears the record.
      if (!retryable(request) && !launchRefusalProbeDue(cursor.failures[request.id], dispatchFailureLimit, now())) {
        const failure = cursor.failures[request.id];
        wait('review', item, request, `launch refused ${failure.attempts} time(s): ${failure.reason}; ${failure.attempts >= dispatchFailureLimit ? `probed again every ${postMergeRefusalProbeMs / 60_000} minutes (next at ${new Date(Date.parse(failure.at) + postMergeRefusalProbeMs).toISOString()}): the request launches once the refusal's cause is gone` : `next attempt at ${failure.nextAt}`}`);
        continue;
      }
      const { profile, reason } = selectReviewerProfile(config);
      const candidates = profile ? [profile, ...withReviewerDefaults(config).reviewers.filter(other => other.name !== profile.name)] : [];
      const withRoom = () => preferFreshProfiles(candidates, reviews, request.id);
      const busy = () => wait('review', item, request, `${launchWaitWording.busy}: registry slots are occupied; set concurrency on the registry reviewer role`);
      if (!profile) { wait('review', item, request, reason!); continue; }
      if (!withRoom().length) { busy(); continue; }
      try {
        // The delivered item names no live request, so no session handle is recorded on it: the ledger holds the session.
        const launched = await launchInTurns(request, withRoom(), candidate => {
          const handle = launchedSessionHandle('review', request, `${item.key}: post-merge review ${request.sha.slice(0, 12)}`, config.hostId, undefined, candidate.kind, config.herdrWorkspace);
          return registeredLaunch(undefined, handle, withinBound(handle, withLaunchedRuntime(handle, () => effects.launchPostMergeReview!(item, request, candidate, inventory(), observedAt))), result => coordinates(candidate, request, result), attachTo);
        }, effects.holdAccount ? exhaustedAtLaunch('review', item, request) : undefined);
        if (!launched) busy();
        else {
          delete cursor.failures[request.id]; delete cursor.capacity.review;
          tick.launched.push({ kind: 'review', work: item.key, requestId: request.id, sha: request.sha, profile: launched.profile.name, reason: 'post-merge review of the delivered merge commit', ...(launched.failover.length ? { failover: launched.failover } : {}), ...(launched.relaunched ? { relaunched: true } : {}) });
        }
      } catch (error) {
        const answered = answeredByPendingReview(error, request);
        if (answered) wait('review', item, request, `reviewer session ${answered.agentName} is already pending on ${request.sha.slice(0, 12)}; ${launchWaitWording.settles}`);
        else if (error instanceof UnknownReviewerProfileError || error instanceof LauncherUnavailableError) { delete cursor.failures[request.id]; wait('review', item, request, message(error)); }
        else if (!outOfCapacity('review', item, request, error)) refuse('review', item, request, error);
      }
      await persist();
    }
    for (const record of reviews) {
      if (!record.postMerge || !record.verdict || (record.postMergeFollowUps && !record.postMergeFollowUps.failure && !record.postMergeFollowUps.pending)) continue;
      const item = snapshot.work.find(work => work.key === record.key);
      if (!item) continue;
      const outcome = await filePostMergeFollowUps(item, record, effects, new Date(now()));
      if (!outcome) continue;
      await effects.settlePostMerge?.(record, outcome);
      (tick.followUps ??= []).push({ work: item.key, sha: record.sha, filed: outcome.filed.map(entry => entry.key), memory: outcome.memory ?? 0, ...(outcome.failure ? { failure: outcome.failure } : {}) });
    }
  })();
  for (const { key, wake } of settlementWakes.values()) {
    const failed = await wake;
    if (!failed) { (tick.woken ??= []).push(key); continue; }
    for (const entry of tick.waiting) if (entry.work === key && entry.answeredAt) entry.reason = bounded(`${entry.reason}; waking its observation failed: ${failed}`, cursorTextLimit);
  }
  // A failure for a request the control plane resolved is history the cursor need not keep.
  const live = new Set([...snapshot.work.flatMap(work => [...(work.autoDispatch?.review ? [work.autoDispatch.review.id] : []), ...(work.autoDispatch?.product ? [work.autoDispatch.product.id] : []), ...(work.autoDispatch?.producers ?? []).map(request => request.id)]), ...owed.map(item => postMergeRequest(item).id)]);
  for (const id of Object.keys(cursor.failures)) if (!live.has(id)) delete cursor.failures[id];
  for (const id of Object.keys(cursor.abandoned)) if (!live.has(id)) delete cursor.abandoned[id];
  cursor.ticks += 1; cursor.lastTickAt = cursor.lastSuccessAt = new Date(now()).toISOString(); cursor.consecutiveFailures = 0;
  cursor.lastTick = { at: tick.at, launched: tick.launched.length, refused: tick.refused.length, waiting: tick.waiting.length, settled: tick.skipped,
    closed: tick.closed.length, closeFailures: closeFailureReasons(tick.closeFailures),
    reasons: [...composed().map(([reason]) => reason), ...tick.launched.filter(launch => launch.reason).map(launch => bounded(`${launch.kind} for ${launch.work} ${launch.sha.slice(0, 12)}: launched; ${launch.reason}`, cursorTextLimit))].slice(0, 20),
    waits: tickWaits(tick.waiting) };
  await persist();
  return tick;
}
async function boundedRead<T>(read: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`work snapshot read timed out after ${timeoutMs}ms`)), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
